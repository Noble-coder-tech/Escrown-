import {
  setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendEmailVerification,
  sendPasswordResetEmail, signOut, onAuthStateChanged, deleteUser
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { httpsCallable, getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { auth, app } from "./firebase-config.js";
const functions = getFunctions(app, "europe-west1");

const provider = new GoogleAuthProvider();
const PASSWORD_MIN = 8;
const RESERVED = new Set(["admin", "support", "escrown", "system"]);
const LOG_KEY = "escrown_error_logs_v1";
const MAX_LOGS = 200;
// Prevent the global auth-state listener from navigating away while an explicit
// sign-in/sign-up flow is still creating/repairing the user profile.
let authFlowInProgress = false;

function safeSerialize(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, val) => {
      if (["password", "accessToken", "idToken", "refreshToken", "apiKey"].includes(key)) return "[REDACTED]";
      if (typeof val === "string" && val.length > 500) return `${val.slice(0, 500)}…`;
      return val;
    }));
  } catch { return String(value); }
}

export function logClientEvent(level, event, details = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    event,
    page: page(),
    path: location.pathname,
    uid: auth.currentUser?.uid || null,
    details: safeSerialize(details)
  };
  try {
    const logs = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    logs.push(entry);
    while (logs.length > MAX_LOGS) logs.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  } catch {}
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  console[method](`[Escrown ${level}] ${event}`, entry.details);
  window.dispatchEvent(new CustomEvent("escrown-log-added", { detail: entry }));
  return entry;
}

function errorDetails(err) {
  return {
    name: err?.name || "Error",
    code: err?.code || null,
    message: err?.message || String(err),
    serverMessage: err?.customData?.message || null,
    stack: err?.stack || null
  };
}

export function recordError(event, err, extra = {}) {
  logClientEvent("error", event, { ...extra, error: errorDetails(err) });
}

export function getClientLogs() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; }
}

export function clearClientLogs() {
  localStorage.removeItem(LOG_KEY);
  window.dispatchEvent(new Event("escrown-log-cleared"));
}

export function generateEscrownID() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function page() { return location.pathname.split("/").pop()?.toLowerCase() || "index.html"; }
function go(path) { if (page() !== path) location.href = path; }
function isGoogleUser(user) { return user?.providerData?.some(p => p.providerId === "google.com"); }

export async function ensureProfile(user, requestedUsername = "") {
  try {
    const result = await httpsCallable(functions, "ensureUserProfile")({ username: requestedUsername });
    logClientEvent("info", "profile.ensure.success", { requestedUsername, result: result.data });
    return result.data;
  } catch (err) {
    recordError("profile.ensure.failed", err, { requestedUsername });
    throw err;
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = document.getElementById("signup-email")?.value.trim().toLowerCase();
  const password = document.getElementById("signup-password")?.value || "";
  const username = document.getElementById("signup-username")?.value.trim();
  const accepted = document.getElementById("tickbox")?.checked;
  const button = document.getElementById("signup-btn");

  logClientEvent("info", "signup.submit", { email, username, termsAccepted: !!accepted });
  if (!form?.checkValidity()) {
    logClientEvent("warn", "signup.validation.failed", { validity: form?.checkValidity() });
    form?.reportValidity();
    return;
  }
  if (!accepted) {
    logClientEvent("warn", "signup.terms.notAccepted");
    return alert("Please accept the Terms and Privacy Policy first.");
  }
  if (password.length < PASSWORD_MIN) {
    logClientEvent("warn", "signup.password.tooShort", { length: password.length });
    return alert(`Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username) || RESERVED.has(username.toLowerCase())) {
    logClientEvent("warn", "signup.username.invalid", { username });
    return alert("Choose a valid username (3–20 letters, numbers or underscores).");
  }

  button && (button.disabled = true, button.textContent = "Creating account…");
  let createdUser = null;
  authFlowInProgress = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    logClientEvent("info", "signup.persistence.ready");

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    createdUser = cred.user;
    logClientEvent("info", "signup.auth.created", { uid: createdUser.uid, email: createdUser.email });

    try {
      await ensureProfile(createdUser, username);
    } catch (profileErr) {
      recordError("signup.profile.failed", profileErr, { uid: createdUser.uid, email, username });
      try {
        await deleteUser(createdUser);
        logClientEvent("warn", "signup.rollback.authUserDeleted", { uid: createdUser.uid });
      } catch (rollbackErr) {
        recordError("signup.rollback.failed", rollbackErr, { uid: createdUser.uid });
      }
      throw profileErr;
    }

    try {
      await sendEmailVerification(createdUser);
      logClientEvent("info", "signup.verification.sent", { uid: createdUser.uid });
    } catch (verificationErr) {
      recordError("signup.verification.failed", verificationErr, { uid: createdUser.uid });
      alert("Your account was created, but we could not send the verification email. You can retry from the verification page.");
    }

    sessionStorage.setItem("pendingEmail", email);
    logClientEvent("info", "signup.completed", { uid: createdUser.uid });
    authFlowInProgress = false;
    go("verification.html");
  } catch (err) {
    authFlowInProgress = false;
    recordError("signup.failed", err, { uid: createdUser?.uid || null, email, username });
    alert(cleanAuthError(err));
    button && (button.disabled = false, button.textContent = "Sign Up");
  }
}

async function handleSignin(e) {
  e.preventDefault();
  const email = document.getElementById("signin-email")?.value.trim().toLowerCase();
  const password = document.getElementById("signin-password")?.value || "";
  const button = document.getElementById("btn-sign-in");
  logClientEvent("info", "signin.submit", { email });
  button && (button.disabled = true, button.textContent = "Signing in…");
  authFlowInProgress = true;
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInWithEmailAndPassword(auth, email, password);
    logClientEvent("info", "signin.auth.success", { uid: cred.user.uid });
    await ensureProfile(cred.user);
    authFlowInProgress = false;
    if (!isGoogleUser(cred.user) && !cred.user.emailVerified) go("verification.html");
    else go("home.html");
  } catch (err) {
    authFlowInProgress = false;
    recordError("signin.failed", err, { email });
    alert(cleanAuthError(err));
    button && (button.disabled = false, button.textContent = "Sign In");
  }
}

async function handleGoogle(e) {
  e.preventDefault();
  const btn = e.currentTarget;
  btn.disabled = true;
  authFlowInProgress = true;
  logClientEvent("info", "google.signin.submit", { buttonId: btn.id });
  try {
    await setPersistence(auth, browserLocalPersistence);
    const result = await signInWithPopup(auth, provider);
    logClientEvent("info", "google.signin.success", { uid: result.user.uid });
    await ensureProfile(result.user);
    authFlowInProgress = false;
    go("home.html");
  } catch (err) {
    authFlowInProgress = false;
    recordError("google.signin.failed", err, { buttonId: btn.id });
    alert(cleanAuthError(err));
    btn.disabled = false;
  }
}

async function handleForgot(e) {
  e.preventDefault();
  const email = document.getElementById("forgot-email")?.value.trim().toLowerCase();
  const btn = document.getElementById("reset-btn");
  logClientEvent("info", "password-reset.submit", { email });
  try {
    await sendPasswordResetEmail(auth, email);
    logClientEvent("info", "password-reset.sent", { email });
    alert("If an account exists for that address, a password reset email has been sent.");
    if (btn) {
      btn.disabled = true; let t = 30; btn.textContent = `Send again in ${t}s`;
      const timer = setInterval(() => { t -= 1; btn.textContent = `Send again in ${t}s`; if (t <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = "Send Reset Link"; } }, 1000);
    }
  } catch (err) { recordError("password-reset.failed", err, { email }); alert(cleanAuthError(err)); }
}

async function handleResend() {
  if (!auth.currentUser) return alert("Please sign in again to resend verification.");
  try { await sendEmailVerification(auth.currentUser); logClientEvent("info", "verification.resend.success", { uid: auth.currentUser.uid }); alert("Verification email sent."); }
  catch (err) { recordError("verification.resend.failed", err); alert(cleanAuthError(err)); }
}

function cleanAuthError(err) {
  const map = {
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/email-already-in-use": "An account already exists for that email.",
    "auth/weak-password": "Use a stronger password.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/popup-closed-by-user": "Google sign-in was cancelled.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "functions/already-exists": "That username is already in use.",
    "functions/invalid-argument": "Some signup information is invalid. Please check the form.",
    "functions/failed-precondition": "The account could not be completed yet. Please try again.",
    "functions/internal": "The server could not complete the request. Open Error Logs for details."
  };
  return map[err?.code] || err?.message || "Authentication failed. Please try again.";
}

const signupForm = document.getElementById("signup-form");
const signinForm = document.getElementById("signin-form");
const forgotForm = document.getElementById("forgot-form");
if (signupForm) signupForm.addEventListener("submit", handleSignup);
if (signinForm) signinForm.addEventListener("submit", handleSignin);
if (forgotForm) forgotForm.addEventListener("submit", handleForgot);
for (const id of ["google-signup", "google-signin"]) document.getElementById(id)?.addEventListener("click", handleGoogle);
document.getElementById("resend")?.addEventListener("click", handleResend);
document.getElementById("backToSignInBtn")?.addEventListener("click", async () => {
  try { await signOut(auth); logClientEvent("info", "verification.signout"); } catch (err) { recordError("verification.signout.failed", err); }
  sessionStorage.removeItem("pendingEmail");
  go("signin.html");
});
document.getElementById("refresh-verification")?.addEventListener("click", async () => {
  try {
    if (!auth.currentUser) return go("signin.html");
    await auth.currentUser.reload();
    logClientEvent("info", "verification.refresh", { emailVerified: auth.currentUser.emailVerified });
    if (auth.currentUser.emailVerified || isGoogleUser(auth.currentUser)) go("home.html");
    else alert("Your email is not verified yet. Open the verification email, then try again.");
  } catch (err) { recordError("verification.refresh.failed", err); alert(cleanAuthError(err)); }
});

document.addEventListener("DOMContentLoaded", () => {
  const checkbox = document.getElementById("tickbox");
  const signup = document.getElementById("signup-btn");
  const google = document.getElementById("google-signup");
  if (checkbox && signup && google) {
    const sync = () => { signup.disabled = !checkbox.checked; google.disabled = !checkbox.checked; };
    sync(); checkbox.addEventListener("change", sync);
  }
});

window.addEventListener("error", event => logClientEvent("error", "window.error", {
  message: event.message, source: event.filename, line: event.lineno, column: event.colno
}));
window.addEventListener("unhandledrejection", event => recordError("window.unhandledrejection", event.reason));

onAuthStateChanged(auth, async (user) => {
  const p = page();
  const publicPages = new Set(["index.html", "", "signin.html", "signup.html", "forget.html", "verification.html", "error-logs.html"]);
  logClientEvent("info", "auth.state.changed", { uid: user?.uid || null, emailVerified: user?.emailVerified || false, providerIds: user?.providerData?.map(x => x.providerId) || [] });
  if (!user) {
    if (!publicPages.has(p)) go("signin.html");
    return;
  }

  // Explicit sign-in/sign-up handlers are responsible for ensuring the profile
  // before navigation. Do not let this listener race them to another page.
  if (authFlowInProgress) {
    logClientEvent("info", "auth.state.navigation.deferred", { uid: user.uid, page: p });
    return;
  }

  if (!isGoogleUser(user) && !user.emailVerified) {
    if (p !== "verification.html") go("verification.html");
    return;
  }
  if (["signin.html", "signup.html", "forget.html", "verification.html", "index.html", ""].includes(p)) go("home.html");
});

window.handleUserLogout = async () => {
  try {
    logClientEvent("info", "logout.submit", { uid: auth.currentUser?.uid || null });
    await signOut(auth);
    logClientEvent("info", "logout.success");
    go("signin.html");
  } catch (err) {
    recordError("logout.failed", err);
    alert("Unable to log out right now. Open Error Logs for details.");
    throw err;
  }
};
window.logoutUser = window.handleUserLogout;
