import {
  setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendEmailVerification,
  sendPasswordResetEmail, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, set, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { auth, db } from "./firebase-config.js";

const provider = new GoogleAuthProvider();
const PASSWORD_MIN = 8;
const RESERVED = new Set(["admin", "support", "escrown", "system"]);

export function generateEscrownID() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function page() { return location.pathname.split("/").pop()?.toLowerCase() || "index.html"; }
function go(path) { if (page() !== path) location.href = path; }
function isGoogleUser(user) { return user?.providerData?.some(p => p.providerId === "google.com"); }

async function ensureProfile(user, requestedUsername = "") {
  const userRef = ref(db, `users/${user.uid}`);
  const snap = await get(userRef);
  if (snap.exists()) {
    const current = snap.val() || {};
    if (!current.escrownId && current.escrownID) { current.escrownId = current.escrownID; await set(userRef, current); }
    if (!current.username) { current.username = (user.displayName || user.email?.split("@")[0] || "User").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || `user${user.uid.slice(0, 6)}`; await set(ref(db, `users/${user.uid}/username`), current.username); }
    await set(ref(db, `user_directory/${user.uid}`), { uid: user.uid, username: current.username, escrownId: current.escrownId });
    return current;
  }

  const profile = {
    uid: user.uid,
    email: user.email || "",
    username: requestedUsername || (user.displayName || user.email?.split("@")[0] || "User").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || `user${user.uid.slice(0, 6)}`,
    escrownId: generateEscrownID(),
    displayName: user.displayName || "",
    createdAt: Date.now()
  };
  await set(userRef, profile);
  await set(ref(db, `user_directory/${user.uid}`), { uid: user.uid, username: profile.username, escrownId: profile.escrownId });
  return profile;
}

async function handleSignup(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = document.getElementById("signup-email")?.value.trim().toLowerCase();
  const password = document.getElementById("signup-password")?.value || "";
  const username = document.getElementById("signup-username")?.value.trim();
  const accepted = document.getElementById("tickbox")?.checked;
  const button = document.getElementById("signup-btn");
  if (!accepted) return alert("Please accept the Terms and Privacy Policy first.");
  if (password.length < PASSWORD_MIN) return alert(`Password must be at least ${PASSWORD_MIN} characters.`);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username) || RESERVED.has(username.toLowerCase())) return alert("Choose a valid username (3–20 letters, numbers or underscores).");

  button && (button.disabled = true, button.textContent = "Creating account…");
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await ensureProfile(cred.user, username);
    await sendEmailVerification(cred.user);
    sessionStorage.setItem("pendingEmail", email);
    go("verification.html");
  } catch (err) {
    alert(cleanAuthError(err));
    button && (button.disabled = false, button.textContent = "Sign Up");
  }
}

async function handleSignin(e) {
  e.preventDefault();
  const email = document.getElementById("signin-email")?.value.trim().toLowerCase();
  const password = document.getElementById("signin-password")?.value || "";
  const button = document.getElementById("btn-sign-in");
  button && (button.disabled = true, button.textContent = "Signing in…");
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await ensureProfile(cred.user);
    if (!isGoogleUser(cred.user) && !cred.user.emailVerified) go("verification.html");
    else go("home.html");
  } catch (err) {
    alert(cleanAuthError(err));
    button && (button.disabled = false, button.textContent = "Sign In");
  }
}

async function handleGoogle(e) {
  e.preventDefault();
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    const result = await signInWithPopup(auth, provider);
    await ensureProfile(result.user);
    go("home.html");
  } catch (err) {
    alert(cleanAuthError(err));
    btn.disabled = false;
  }
}

async function handleForgot(e) {
  e.preventDefault();
  const email = document.getElementById("forgot-email")?.value.trim().toLowerCase();
  const btn = document.getElementById("reset-btn");
  try {
    await sendPasswordResetEmail(auth, email);
    alert("If an account exists for that address, a password reset email has been sent.");
    if (btn) {
      btn.disabled = true; let t = 30; btn.textContent = `Send again in ${t}s`;
      const timer = setInterval(() => { t -= 1; btn.textContent = `Send again in ${t}s`; if (t <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = "Send Reset Link"; } }, 1000);
    }
  } catch (err) { alert(cleanAuthError(err)); }
}

async function handleResend() {
  if (!auth.currentUser) return alert("Please sign in again to resend verification.");
  try {
    await sendEmailVerification(auth.currentUser);
    alert("Verification email sent.");
  } catch (err) { alert(cleanAuthError(err)); }
}

function cleanAuthError(err) {
  const map = {
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/email-already-in-use": "An account already exists for that email.",
    "auth/weak-password": "Use a stronger password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/invalid-email": "Please enter a valid email address."
  };
  return map[err?.code] || "Authentication failed. Please try again.";
}

const signupForm = document.getElementById("signup-form");
const signinForm = document.getElementById("signin-form");
const forgotForm = document.getElementById("forgot-form");
if (signupForm) signupForm.addEventListener("submit", handleSignup);
if (signinForm) signinForm.addEventListener("submit", handleSignin);
if (forgotForm) forgotForm.addEventListener("submit", handleForgot);
for (const id of ["google-signup", "google-signin"]) document.getElementById(id)?.addEventListener("click", handleGoogle);
document.getElementById("resend")?.addEventListener("click", handleResend);

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("tickbox");
  const signup = document.getElementById("signup-btn");
  const google = document.getElementById("google-signup");
  if (checkbox && signup && google) {
    const sync = () => { signup.disabled = !checkbox.checked; google.disabled = !checkbox.checked; };
    sync(); checkbox.addEventListener("change", sync);
  }
});

onAuthStateChanged(auth, async (user) => {
  const p = page();
  const publicPages = new Set(["index.html", "", "signin.html", "signup.html", "forget.html", "verification.html"]);
  if (!user) {
    if (!publicPages.has(p)) go("signin.html");
    return;
  }
  if (!isGoogleUser(user) && !user.emailVerified) {
    if (p !== "verification.html") go("verification.html");
    return;
  }
  if (["signin.html", "signup.html", "forget.html", "verification.html", "index.html", ""].includes(p)) go("home.html");
});

window.handleUserLogout = async () => { await signOut(auth); go("signin.html"); };
window.logoutUser = window.handleUserLogout;
