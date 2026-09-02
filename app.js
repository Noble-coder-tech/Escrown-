import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { auth, db } from "./firebase-config.js";

function escapeText(v) { return String(v ?? ""); }
function routeTo(p) { if (location.pathname.split("/").pop() !== p) location.href = p; }

onAuthStateChanged(auth, async user => {
  if (!user || (!user.emailVerified && !user.providerData.some(p => p.providerId === "google.com"))) return routeTo("signin.html");
  const snap = await get(ref(db, `users/${user.uid}`));
  if (!snap.exists()) return routeTo("signin.html");
  const data = snap.val();
  document.getElementById("user-display-id")?.replaceChildren(document.createTextNode(`ID: ${escapeText(data.escrownId || data.escrownID || "Not Set")}`));
  document.getElementById("profile-username")?.replaceChildren(document.createTextNode(data.username || "User"));
  document.getElementById("profile-escrown-id")?.replaceChildren(document.createTextNode(data.escrownId || data.escrownID || "Not Set"));
  document.getElementById("profile-email")?.replaceChildren(document.createTextNode(data.email || user.email || ""));
  const acc = document.getElementById("profile-account-number"); if (acc) acc.value = data.accountNumber || "";
});

document.getElementById("logout-btn")?.addEventListener("click", async () => { await window.handleUserLogout?.(); });

document.getElementById("start-chat-form")?.addEventListener("submit", async e => {
  e.preventDefault();
  const q = document.getElementById("target-user-id").value.trim().toLowerCase();
  const err = document.getElementById("chat-error"); err.textContent = "";
  try {
    const snap = await get(ref(db, "user_directory"));
    let target = null;
    snap.forEach(child => {
      const u = child.val() || {};
      const username = String(u.username || "").toLowerCase();
      const eid = String(u.escrownId || u.escrownID || "").toLowerCase();
      if (!target && (username === q || eid === q)) target = child.key;
    });
    if (!target) throw new Error("No user found with that Username or Escrown ID.");
    if (target === auth.currentUser.uid) throw new Error("You cannot start a chat with yourself.");
    location.href = `chat.html?peer=${encodeURIComponent(target)}`;
  } catch (e2) { err.textContent = e2.message || "Could not find that user."; }
});

document.getElementById("update-bank-form")?.addEventListener("submit", async e => {
  e.preventDefault();
  const value = document.getElementById("profile-account-number").value.trim();
  const msg = document.getElementById("profile-msg");
  if (!/^\d{10}$/.test(value)) { msg.textContent = "Enter a valid 10-digit bank account number."; msg.style.display = "block"; return; }
  try {
    await update(ref(db, `users/${auth.currentUser.uid}`), { accountNumber: value });
    msg.textContent = "Bank account updated."; msg.style.display = "block";
  } catch { msg.textContent = "Unable to update your account right now."; msg.style.display = "block"; }
});
