import { setPersistence, browserSessionPersistence, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getIdTokenResult } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { auth } from "./firebase-config.js";
const form = document.getElementById("admin-login-form"), error = document.getElementById("login-error");
form?.addEventListener("submit", async e => {
  e.preventDefault(); error.textContent = "";
  const button = form.querySelector("button"); button.disabled = true;
  try {
    await setPersistence(auth, browserSessionPersistence);
    const cred = await signInWithEmailAndPassword(auth, document.getElementById("admin-email").value.trim(), document.getElementById("admin-password").value);
    const token = await getIdTokenResult(cred.user, true);
    if (token.claims.admin !== true) { await signOut(auth); throw new Error("Access denied. This account is not an administrator."); }
    location.href = "admin.html";
  } catch (err) { error.textContent = err.message || "Unable to sign in."; button.disabled = false; }
});
