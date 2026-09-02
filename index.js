const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

const FEE_RATE = 0.02;
const PUBLIC_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Authentication required.");
  return request.auth.uid;
}
function requireAdmin(request) {
  const uid = requireAuth(request);
  if (request.auth.token.admin !== true) throw new HttpsError("permission-denied", "Administrator access required.");
  return uid;
}
function validChatId(chatId, uid, peerUid) {
  if (typeof chatId !== "string" || typeof peerUid !== "string") throw new HttpsError("invalid-argument", "Invalid chat information.");
  const expected = [uid, peerUid].sort().join("_");
  if (chatId !== expected || uid === peerUid) throw new HttpsError("permission-denied", "You are not a member of this chat.");
}
async function ensureChat(chatId, uid, peerUid) {
  validChatId(chatId, uid, peerUid);
  const chatRef = db.ref(`chats/${chatId}`);
  const snap = await chatRef.once("value");
  if (!snap.exists()) {
    await chatRef.set({ members: { [uid]: true, [peerUid]: true }, createdAt: Date.now() });
  } else if (!snap.child(`members/${uid}`).val() || !snap.child(`members/${peerUid}`).val()) {
    throw new HttpsError("permission-denied", "Chat membership is invalid.");
  }
}
function makePublicTxId() {
  let result = "TX";
  for (let i = 0; i < 8; i++) result += PUBLIC_ID_CHARS[Math.floor(Math.random() * PUBLIC_ID_CHARS.length)];
  return result;
}
async function uniquePublicTxId() {
  for (let i = 0; i < 10; i++) {
    const id = makePublicTxId();
    const snap = await db.ref("publicTransactionIds").child(id).once("value");
    if (!snap.exists()) return id;
  }
  throw new HttpsError("resource-exhausted", "Could not allocate a transaction reference.");
}

exports.requestNewTransaction = onCall(async request => {
  const uid = requireAuth(request);
  const { chatId, peerUid } = request.data || {};
  await ensureChat(chatId, uid, peerUid);
  const txRef = db.ref(`chats/${chatId}/new_tx_request`);
  const existing = await txRef.once("value");
  if (existing.exists() && existing.val()?.status === "pending") throw new HttpsError("failed-precondition", "A transaction request is already pending.");
  await txRef.set({ requestedBy: uid, requestedFor: peerUid, status: "pending", timestamp: Date.now() });
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: "A new transaction request has been created. Waiting for the other party to accept it.", timestamp: Date.now() });
  return { ok: true };
});

exports.acceptTransaction = onCall(async request => {
  const uid = requireAuth(request);
  const { chatId, peerUid } = request.data || {};
  await ensureChat(chatId, uid, peerUid);
  const reqRef = db.ref(`chats/${chatId}/new_tx_request`);
  const reqSnap = await reqRef.once("value");
  const req = reqSnap.val();
  if (!req || req.status !== "pending" || req.requestedFor !== uid) throw new HttpsError("failed-precondition", "No transaction request is waiting for you.");

  const oldTxSnap = await db.ref(`chats/${chatId}/transaction`).once("value");
  const oldTx = oldTxSnap.val();
  const updates = {};
  if (oldTx && !["COMPLETED", "CANCELLED"].includes(oldTx.status)) {
    updates[`chats/${chatId}/transaction/status`] = "CANCELLED";
    updates[`chats/${chatId}/transaction/closedAt`] = Date.now();
  }
  const txId = `internal-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const publicTxId = await uniquePublicTxId();
  updates[`chats/${chatId}/transaction`] = {
    txId, publicTxId, status: "NEGOTIATING", createdBy: req.requestedBy, createdFor: uid,
    createdAt: Date.now(), amount: null, fee: null, total: null, fundedAt: null, releasedAt: null
  };
  updates[`publicTransactionIds/${publicTxId}`] = { chatId, txId, createdAt: Date.now() };
  updates[`chats/${chatId}/new_tx_request`] = null;
  await db.ref().update(updates);
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: `New transaction ${publicTxId} created. Both parties must explicitly agree on the amount.`, timestamp: Date.now() });
  return { publicTxId };
});

exports.declineTransactionRequest = onCall(async request => {
  const uid = requireAuth(request);
  const { chatId, peerUid } = request.data || {};
  await ensureChat(chatId, uid, peerUid);
  const snap = await db.ref(`chats/${chatId}/new_tx_request`).once("value");
  const req = snap.val();
  if (!req || req.requestedFor !== uid) throw new HttpsError("failed-precondition", "No request to decline.");
  await db.ref(`chats/${chatId}/new_tx_request`).set(null);
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: "The transaction request was declined.", timestamp: Date.now() });
  return { ok: true };
});

exports.agreeTransaction = onCall(async request => {
  const uid = requireAuth(request);
  const { chatId, amount } = request.data || {};
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0 || Number(amount) > 1000000000) throw new HttpsError("invalid-argument", "Enter a valid transaction amount.");
  const members = String(chatId || "").split("_");
  if (members.length !== 2 || !members.includes(uid)) throw new HttpsError("permission-denied", "Invalid chat.");
  const peerUid = members.find(x => x !== uid);
  await ensureChat(chatId, uid, peerUid);
  const txRef = db.ref(`chats/${chatId}/transaction`);
  const snap = await txRef.once("value"); const tx = snap.val();
  if (!tx || ["COMPLETED", "CANCELLED", "DISPUTED"].includes(tx.status)) throw new HttpsError("failed-precondition", "Create or accept a transaction first.");
  const fee = Math.round(Number(amount) * FEE_RATE * 100) / 100;
  const total = Math.round((Number(amount) + fee) * 100) / 100;
  await txRef.update({ amount: Number(amount), fee, total, status: "AWAITING_PAYMENT", agreedBy: uid, agreedAt: Date.now() });
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: `Agreement recorded for ${tx.publicTxId}: amount ₦${Number(amount).toLocaleString()} + fee ₦${fee.toLocaleString()}. Transaction is awaiting verified payment.`, timestamp: Date.now() });
  return { publicTxId: tx.publicTxId, amount: Number(amount), fee, total };
});

exports.confirmPayment = onCall(async request => {
  requireAdmin(request);
  const { publicTxId, providerReference } = request.data || {};
  if (typeof publicTxId !== "string" || !publicTxId) throw new HttpsError("invalid-argument", "Transaction reference is required.");
  const indexSnap = await db.ref(`publicTransactionIds/${publicTxId}`).once("value");
  const index = indexSnap.val();
  if (!index) throw new HttpsError("not-found", "Transaction not found.");
  const txRef = db.ref(`chats/${index.chatId}/transaction`);
  const txSnap = await txRef.once("value"); const tx = txSnap.val();
  if (!tx || tx.txId !== index.txId || tx.publicTxId !== publicTxId) throw new HttpsError("failed-precondition", "Transaction record mismatch.");
  if (tx.status !== "AWAITING_PAYMENT") throw new HttpsError("failed-precondition", "Transaction is not awaiting payment.");
  await txRef.update({ status: "FUNDED", fundedAt: Date.now(), providerReference: String(providerReference || "").slice(0, 120) });
  await db.ref(`chats/${index.chatId}/messages`).push({ isSystem: true, text: `Payment for ${publicTxId} was verified by administration. Funds are now recorded as funded.`, timestamp: Date.now() });
  return { ok: true };
});

exports.releaseTransaction = onCall(async request => {
  requireAdmin(request);
  const { publicTxId, payoutReference } = request.data || {};
  if (typeof publicTxId !== "string" || !publicTxId) throw new HttpsError("invalid-argument", "Transaction reference is required.");
  const indexSnap = await db.ref(`publicTransactionIds/${publicTxId}`).once("value"); const index = indexSnap.val();
  if (!index) throw new HttpsError("not-found", "Transaction not found.");
  const txRef = db.ref(`chats/${index.chatId}/transaction`); const txSnap = await txRef.once("value"); const tx = txSnap.val();
  if (!tx || tx.txId !== index.txId || tx.status !== "FUNDED") throw new HttpsError("failed-precondition", "Only funded transactions can be released.");
  await txRef.update({ status: "COMPLETED", releasedAt: Date.now(), payoutReference: String(payoutReference || "").slice(0, 120) });
  await db.ref(`completed_ledger/${tx.txId}`).set({ txId: tx.txId, publicTxId, chatId: index.chatId, completedAt: Date.now(), note: "Released by authorized administration.", payoutReference: String(payoutReference || "").slice(0, 120) });
  await db.ref(`chats/${index.chatId}/messages`).push({ isSystem: true, text: `Transaction ${publicTxId} was released and completed by authorized administration.`, timestamp: Date.now() });
  return { ok: true };
});

exports.flagTransaction = onCall(async request => {
  const uid = requireAuth(request);
  const { chatId, txId } = request.data || {};
  const members = String(chatId || "").split("_");
  if (members.length !== 2 || !members.includes(uid)) throw new HttpsError("permission-denied", "Invalid chat.");
  const peerUid = members.find(x => x !== uid); await ensureChat(chatId, uid, peerUid);
  const txSnap = await db.ref(`chats/${chatId}/transaction`).once("value"); const tx = txSnap.val();
  if (!tx || tx.txId !== txId || ["COMPLETED", "CANCELLED"].includes(tx.status)) throw new HttpsError("failed-precondition", "Transaction cannot be flagged.");
  const reportRef = db.ref("flagged_transactions").push();
  await reportRef.set({ txId: tx.txId, publicTxId: tx.publicTxId, chatId, flaggedByUid: uid, timestamp: Date.now(), status: "OPEN" });
  await db.ref(`chats/${chatId}/transaction`).update({ status: "DISPUTED", disputedAt: Date.now() });
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: `Transaction ${tx.publicTxId} has been flagged and moved to dispute review.`, timestamp: Date.now() });
  return { ok: true };
});

exports.checkAdmin = onCall(async request => {
  const uid = requireAuth(request);
  return { admin: request.auth.token.admin === true, uid };
});

exports.setConfiguredAdminClaim = onCall(async request => {
  const caller = requireAdmin(request);
  const targetUid = process.env.ADMIN_UID;
  if (!targetUid) throw new HttpsError("failed-precondition", "ADMIN_UID is not configured on the server.");
  if (caller !== targetUid) throw new HttpsError("permission-denied", "Only the configured administrator can run this action.");
  await admin.auth().setCustomUserClaims(targetUid, { admin: true });
  logger.info(`Admin claim refreshed for ${targetUid}`);
  return { ok: true };
});
