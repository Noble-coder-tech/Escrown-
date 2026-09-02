import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, get, onValue, push, set } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { httpsCallable, getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { auth, db, app } from "./firebase-config.js";

const functions = getFunctions(app, "europe-west1");
const peerUid = new URLSearchParams(location.search).get("peer");
let currentUser, me, peer, chatId, activeTransaction, listenersStarted = false;

function safeText(el, value) { if (el) el.replaceChildren(document.createTextNode(String(value ?? ""))); }
function makeChatId(a,b) { return [a,b].sort().join("_"); }
function commandError(err) { alert(err?.message || "The action could not be completed."); }

async function call(name, data) { return (await httpsCallable(functions, name)(data)).data; }

onAuthStateChanged(auth, async user => {
  if (!user || (!user.emailVerified && !user.providerData.some(p => p.providerId === "google.com"))) return location.href = "signin.html";
  if (!peerUid || peerUid === user.uid) return location.href = "home.html";
  currentUser = user; chatId = makeChatId(user.uid, peerUid);
  const [mySnap, peerSnap] = await Promise.all([get(ref(db, `users/${user.uid}`)), get(ref(db, `user_directory/${peerUid}`))]);
  if (!mySnap.exists() || !peerSnap.exists()) return location.href = "home.html";
  me = mySnap.val(); peer = peerSnap.val();
  safeText(document.getElementById("peer-username"), peer.username || "User");
  safeText(document.getElementById("peer-escrown-id"), peer.escrownId || peer.escrownID || "------");
  const chatSnap = await get(ref(db, `chats/${chatId}`));
  if (chatSnap.exists()) startListeners();
});

document.getElementById("chat-form")?.addEventListener("submit", async e => {
  e.preventDefault(); const input = document.getElementById("message-input"); const text = input.value.trim(); if (!text) return; input.value = "";
  try {
    const lower = text.toLowerCase();
    if (lower === "/newtransaction") return await newTransaction();
    if (lower === "/flagtransaction") return await flagTransaction();
    if (lower.startsWith("/agreed")) {
      const parts = text.split(/\s+/); const amount = Number(parts[1]);
      if (!Number.isFinite(amount) || amount <= 0) return alert("Use /agreed AMOUNT, for example /agreed 50000.");
      const result = await call("agreeTransaction", { chatId, amount });
      return;
    }
    await push(ref(db, `chats/${chatId}/messages`), { senderId: currentUser.uid, senderName: me.username || "User", text, timestamp: Date.now() });
  } catch (err) { commandError(err); }
});

document.getElementById("btn-new-tx")?.addEventListener("click", () => newTransaction().catch(commandError));
document.getElementById("btn-flag-tx")?.addEventListener("click", () => flagTransaction().catch(commandError));
document.getElementById("btn-accept-new-tx")?.addEventListener("click", async () => {
  try { await call("acceptTransaction", { chatId, peerUid }); startListeners(); }
  catch (e) { commandError(e); }
});
document.getElementById("btn-decline-new-tx")?.addEventListener("click", async () => {
  try { await call("declineTransactionRequest", { chatId, peerUid }); }
  catch (e) { commandError(e); }
});

async function newTransaction() {
  await call("requestNewTransaction", { chatId, peerUid });
  startListeners();
}
async function flagTransaction() {
  if (!activeTransaction || ["COMPLETED","CANCELLED","DISPUTED"].includes(activeTransaction.status)) return alert("There is no active transaction available to flag.");
  if (!confirm(`Flag transaction ${activeTransaction.publicTxId || activeTransaction.txId} for review?`)) return;
  await call("flagTransaction", { chatId, txId: activeTransaction.txId });
  alert("The transaction has been sent to administration for review.");
}

function startListeners() { if (listenersStarted) return; listenersStarted = true; listenMessages(); listenTransaction(); listenRequest(); }
function listenMessages() {
  onValue(ref(db, `chats/${chatId}/messages`), snap => {
    const box = document.getElementById("chat-messages"); if (!box) return; box.replaceChildren();
    snap.forEach(child => {
      const msg = child.val() || {}; const row = document.createElement("div");
      if (msg.isSystem) {
        row.className = "system-message";
        const boxEl = document.createElement("div"); boxEl.className = "system-box";
        const strong = document.createElement("strong"); strong.textContent = "ESCROWN ESCROW AGENT: ";
        boxEl.append(strong, document.createTextNode(msg.text || "")); row.appendChild(boxEl);
      } else {
        const mine = msg.senderId === currentUser.uid; row.className = `message-row ${mine ? "my-message" : "peer-message"}`;
        const bubble = document.createElement("div"); bubble.className = "message-bubble";
        const sender = document.createElement("span"); sender.className = "sender-name"; sender.textContent = mine ? "You" : (msg.senderName || "User");
        const text = document.createElement("p"); text.textContent = msg.text || "";
        bubble.append(sender, text); row.appendChild(bubble);
      }
      box.appendChild(row);
    }); box.scrollTop = box.scrollHeight;
  });
}
function listenTransaction() {
  onValue(ref(db, `chats/${chatId}/transaction`), snap => {
    activeTransaction = snap.val(); const active = activeTransaction && !["COMPLETED","CANCELLED"].includes(activeTransaction.status);
    safeText(document.getElementById("active-tx-id"), active ? (activeTransaction.publicTxId || activeTransaction.txId) : "None (No active transaction)");
    safeText(document.getElementById("tx-status-badge"), active ? activeTransaction.status : "Inactive");
  });
}
function listenRequest() {
  onValue(ref(db, `chats/${chatId}/new_tx_request`), snap => {
    const modal = document.getElementById("new-tx-modal"); if (!modal) return;
    const req = snap.val(); const show = req && req.status === "pending" && req.requestedBy !== currentUser.uid;
    modal.classList.toggle("hidden", !show);
    if (show) safeText(document.getElementById("new-tx-modal-text"), `${peer.username || "User"} wants to start a new transaction.`);
  });
}
