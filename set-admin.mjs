import admin from "firebase-admin";

const uid = process.env.ADMIN_UID;
if (!uid) throw new Error("Set ADMIN_UID first.");
admin.initializeApp({ credential: admin.credential.applicationDefault() });
await admin.auth().setCustomUserClaims(uid, { admin: true });
console.log(`Admin claim assigned to ${uid}. The user should sign out/in or refresh their ID token.`);
