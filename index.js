const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

const FEE_RATE = 0.02;
const PUBLIC_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RESERVED_USERNAMES = new Set(["admin", "support", "escrown", "system"]);

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
  for (let i = 0; i < 20; i++) {
    const id = makePublicTxId();
    const ref = db.ref(`publicTransactionIds/${id}`);
    const result = await ref.transaction(current => current == null ? { reserved: true, createdAt: Date.now() } : undefined);
    if (result.committed) return id;
  }
  throw new HttpsError("resource-exhausted", "Could not allocate a transaction reference.");
}


function generateUniqueEscrownId() {
  let id = "";
  for (let i = 0; i < 6; i++) id += "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)];
  return id;
}
function makeSafeUsername(value, fallback) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20);
  return cleaned.length >= 3 ? cleaned : fallback;
}
async function allocateEscrownId(uid) {
  for (let i = 0; i < 20; i++) {
    const id = generateUniqueEscrownId();
    const result = await db.ref(`escrown_ids/${id}`).transaction(current => current == null ? uid : undefined);
    if (result.committed) return id;
  }
  throw new HttpsError("resource-exhausted", "Could not allocate an Escrown ID.");
}

exports.ensureUserProfile = onCall(async request => {
  const uid = requireAuth(request);
  const userRecord = await admin.auth().getUser(uid);
  const requestedUsername = String(request.data?.username || "").trim();
  if (requestedUsername && (!/^[A-Za-z0-9_]{3,20}$/.test(requestedUsername) || RESERVED_USERNAMES.has(requestedUsername.toLowerCase()))) {
    throw new HttpsError("invalid-argument", "Choose a valid username (3–20 letters, numbers or underscores).");
  }
  const userRef = db.ref(`users/${uid}`);
  const existingSnap = await userRef.once("value");

  if (existingSnap.exists()) {
    const current = existingSnap.val() || {};
    let escrownId = current.escrownId || current.escrownID;
    const username = current.username || makeSafeUsername(userRecord.displayName || userRecord.email?.split("@")[0], `user${uid.slice(0, 6)}`);
    const updates = {};
    if (!escrownId) {
      escrownId = await allocateEscrownId(uid);
      updates[`users/${uid}/escrownId`] = escrownId;
      updates[`escrown_ids/${escrownId}`] = uid;
    } else {
      updates[`escrown_ids/${escrownId}`] = uid;
    }
    if (!current.username) updates[`users/${uid}/username`] = username;
    if (!current.email && userRecord.email) updates[`users/${uid}/email`] = userRecord.email;
    updates[`user_directory/${uid}`] = { uid, username, escrownId };
    if (Object.keys(updates).length) await db.ref().update(updates);
    return { uid, username, escrownId };
  }

  let username = makeSafeUsername(
    requestedUsername || userRecord.displayName || userRecord.email?.split("@")[0],
    `user${uid.slice(0, 6)}`
  );
  if (RESERVED_USERNAMES.has(username.toLowerCase())) username = `user${uid.slice(0, 6)}`;
  const usernameKey = username.toLowerCase();
  const usernameRef = db.ref(`usernames/${usernameKey}`);
  const usernameResult = await usernameRef.transaction(current => current == null ? uid : undefined);
  if (!usernameResult.committed) {
    throw new HttpsError("already-exists", "That username is already in use.");
  }

  const escrownId = await allocateEscrownId(uid);
  const profile = { uid, email: userRecord.email || "", username, escrownId,
    displayName: userRecord.displayName || "", createdAt: Date.now() };
  const updates = {};
  updates[`users/${uid}`] = profile;
  updates[`user_directory/${uid}`] = { uid, username, escrownId };
  updates[`usernames/${usernameKey}`] = uid;
  updates[`escrown_ids/${escrownId}`] = uid;
  await db.ref().update(updates);
  return profile;
});

exports.openChat = onCall(async request => {
  const uid = requireAuth(request);
  const peerUid = String(request.data?.peerUid || "");
  if (!peerUid || peerUid === uid) throw new HttpsError("invalid-argument", "Invalid chat participant.");
  if (!(await db.ref(`users/${peerUid}`).once("value")).exists()) throw new HttpsError("not-found", "User not found.");
  const chatId = [uid, peerUid].sort().join("_");
  await ensureChat(chatId, uid, peerUid);
  return { chatId };
});

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
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000000000) {
    throw new HttpsError("invalid-argument", "Enter a valid transaction amount.");
  }
  const members = String(chatId || "").split("_");
  if (members.length !== 2 || !members.includes(uid)) throw new HttpsError("permission-denied", "Invalid chat.");
  const peerUid = members.find(x => x !== uid);
  await ensureChat(chatId, uid, peerUid);

  const txRef = db.ref(`chats/${chatId}/transaction`);
  const snap = await txRef.once("value");
  const tx = snap.val();
  if (!tx || ["COMPLETED", "CANCELLED", "DISPUTED"].includes(tx.status)) {
    throw new HttpsError("failed-precondition", "Create or accept a transaction first.");
  }
  if (["AWAITING_PAYMENT", "FUNDED"].includes(tx.status)) {
    throw new HttpsError("failed-precondition", "The agreed transaction is already awaiting payment or funded.");
  }

  const roundedAmount = Math.round(numericAmount * 100) / 100;
  const existingAgreements = tx.agreements || {};
  const peerAgreement = existingAgreements[peerUid];
  if (peerAgreement != null && Number(peerAgreement) !== roundedAmount) {
    throw new HttpsError("failed-precondition", `The other party agreed to ₦${Number(peerAgreement).toLocaleString()}. Both parties must agree on the same amount.`);
  }

  const agreements = { ...existingAgreements, [uid]: roundedAmount };
  const bothAgreed = agreements[uid] != null && agreements[peerUid] != null &&
    Number(agreements[uid]) === Number(agreements[peerUid]);
  const fee = Math.round(roundedAmount * FEE_RATE * 100) / 100;
  const total = Math.round((roundedAmount + fee) * 100) / 100;

  await txRef.update({
    amount: roundedAmount, fee, total, agreements,
    status: bothAgreed ? "AWAITING_PAYMENT" : "NEGOTIATING",
    agreedAt: Date.now()
  });
  const message = bothAgreed
    ? `Both parties agreed on ${tx.publicTxId}: amount ₦${roundedAmount.toLocaleString()} + fee ₦${fee.toLocaleString()}. Transaction is awaiting verified payment.`
    : `Agreement recorded for ${tx.publicTxId}: ₦${roundedAmount.toLocaleString()}. Waiting for the other party to agree to the same amount.`;
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: message, timestamp: Date.now() });
  return { publicTxId: tx.publicTxId, amount: roundedAmount, fee, total, bothAgreed };
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
  if (tx.status === "DISPUTED") throw new HttpsError("failed-precondition", "This transaction is already under dispute review.");
  const previousStatus = tx.status;
  const reportRef = db.ref("flagged_transactions").push();
  await reportRef.set({
    txId: tx.txId, publicTxId: tx.publicTxId, chatId, flaggedByUid: uid,
    previousStatus, timestamp: Date.now(), status: "OPEN"
  });
  await db.ref(`chats/${chatId}/transaction`).update({ status: "DISPUTED", disputedAt: Date.now() });
  await db.ref(`chats/${chatId}/messages`).push({ isSystem: true, text: `Transaction ${tx.publicTxId} has been flagged and moved to dispute review.`, timestamp: Date.now() });
  return { ok: true };
});

exports.resolveFlaggedTransaction = onCall(async request => {
  requireAdmin(request);
  const { reportKey, decision } = request.data || {};
  if (typeof reportKey !== "string" || !reportKey) throw new HttpsError("invalid-argument", "Report key is required.");
  if (!["dismiss", "refund"].includes(decision)) throw new HttpsError("invalid-argument", "Invalid dispute decision.");
  const reportRef = db.ref(`flagged_transactions/${reportKey}`);
  const reportSnap = await reportRef.once("value");
  const report = reportSnap.val();
  if (!report) throw new HttpsError("not-found", "Flagged report not found.");
  const txRef = db.ref(`chats/${report.chatId}/transaction`);
  const txSnap = await txRef.once("value");
  const tx = txSnap.val();
  if (!tx || tx.txId !== report.txId) throw new HttpsError("failed-precondition", "Transaction record mismatch.");
  if (tx.status !== "DISPUTED") throw new HttpsError("failed-precondition", "Only disputed transactions can be resolved.");
  const nextStatus = decision === "dismiss"
    ? (["NEGOTIATING", "AWAITING_PAYMENT", "FUNDED"].includes(report.previousStatus) ? report.previousStatus : "FUNDED")
    : "CANCELLED";
  await txRef.update({ status: nextStatus, disputeResolvedAt: Date.now(), disputeDecision: decision });
  await reportRef.update({ status: decision === "dismiss" ? "DISMISSED" : "REFUND_REVIEWED", resolvedAt: Date.now() });
  await db.ref(`chats/${report.chatId}/messages`).push({
    isSystem: true,
    text: decision === "dismiss"
      ? `Administration dismissed the dispute for ${report.publicTxId}. The transaction is ${nextStatus}.`
      : `Administration marked ${report.publicTxId} for cancellation/refund review.`,
    timestamp: Date.now()
  });
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
