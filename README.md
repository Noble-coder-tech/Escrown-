# Escrown fixed build

This archive fixes the frontend bugs and moves sensitive transaction actions into Firebase callable functions. It also adds Realtime Database rules, an admin custom-claim flow, a public minimal user directory, and an admin login page.

## Before deployment

1. Install the Firebase CLI and log in.
2. In `functions/`, run `npm install`.
3. Copy `functions/.env.example` to `functions/.env` and set `ADMIN_UID` to the Firebase Auth UID of the administrator.
4. Assign the initial admin custom claim using the included `scripts/set-admin.mjs` script with a Firebase service-account credential available through `GOOGLE_APPLICATION_CREDENTIALS`, or an equivalent trusted Admin SDK environment.
5. Deploy the Realtime Database rules and Cloud Functions.
6. Configure your real payment processor/bank webhook in the backend before accepting real money. The frontend intentionally contains no bank account number or payment secret.
7. Do not put Gemini/API secrets in frontend files. An AI integration should be implemented as a server-side function if you add one.

## Important

The Firebase web configuration is normally safe to ship in browser code; Firebase Authentication and Database Rules are the security boundaries. The previous Gemini key was removed from the frontend, but any previously exposed Gemini key should be revoked/rotated in the provider console because an exposed secret cannot be made safe retroactively.

The transaction lifecycle is now: `NEGOTIATING -> AWAITING_PAYMENT -> FUNDED -> RELEASED/COMPLETED`, with `DISPUTED` and `CANCELLED` as controlled states. Payment confirmation and release must still be connected to your real payment provider/webhook before this is a production custodial escrow service.
