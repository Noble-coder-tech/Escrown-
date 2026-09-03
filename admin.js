import { onAuthStateChanged, signOut, getIdTokenResult } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { httpsCallable, getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { auth, db, app } from "./firebase-config.js";
const functions = getFunctions(app, "europe-west1");

function td(text) { const x=document.createElement("td"); x.textContent=String(text ?? "--"); return x; }
async function guard() { const u=auth.currentUser; if(!u) return false; const t=await getIdTokenResult(u,true); return t.claims.admin===true; }
function addRow(tbody, cells, action) { const tr=document.createElement("tr"); cells.forEach(v=>tr.appendChild(td(v))); if(action){const cell=document.createElement("td"); cell.appendChild(action); tr.appendChild(cell);} tbody.appendChild(tr); }
async function call(name, data) { return (await httpsCallable(functions, name)(data)).data; }
function actionMessage(text, ok=false) { const el=document.getElementById("admin-action-msg"); if(el){el.textContent=text; el.style.color=ok ? "var(--gold)" : "var(--red)";} }

onAuthStateChanged(auth, async user => {
  if (!user || !(await guard().catch(()=>false))) { await signOut(auth); location.href="adminlogin.html"; return; }
  document.getElementById("admin-id-display")?.replaceChildren(document.createTextNode(user.email || "ADMIN"));
  load();
});

document.getElementById("admin-logout-btn")?.addEventListener("click", async()=>{await signOut(auth);location.href="adminlogin.html";});

document.getElementById("verify-payment-form")?.addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const publicTxId=document.getElementById("payment-tx-input").value.trim().toUpperCase();
    const providerReference=document.getElementById("payment-reference-input").value.trim();
    await call("confirmPayment",{publicTxId,providerReference});
    e.currentTarget.reset(); actionMessage("Payment verified. Transaction is now FUNDED.",true);
  } catch(err){ actionMessage(err?.message||"Payment verification failed."); }
});
document.getElementById("add-ledger-form")?.addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const publicTxId=document.getElementById("ledger-tx-input").value.trim().toUpperCase();
    const payoutReference=document.getElementById("ledger-note-input").value.trim();
    await call("releaseTransaction",{publicTxId,payoutReference});
    e.currentTarget.reset(); actionMessage("Transaction released and completed.",true);
  } catch(err){ actionMessage(err?.message||"Transaction release failed."); }
});

function load(){
  onValue(ref(db,"flagged_transactions"), snap=>{
    const body=document.getElementById("flagged-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};const b=document.createElement("button");b.className="btn-outline";b.textContent="Dismiss dispute";b.onclick=async()=>{if(!confirm(`Dismiss dispute for ${x.publicTxId||x.txId}?`))return;try{await call("resolveFlaggedTransaction",{reportKey:c.key,decision:"dismiss"});actionMessage("Dispute dismissed and transaction returned to FUNDED.",true);}catch(e){actionMessage(e?.message||"Could not resolve dispute.");}};addRow(body,[x.publicTxId||x.txId,x.flaggedByUid,x.status||"OPEN",x.timestamp?new Date(x.timestamp).toLocaleString():"--"],b);});
    if(!n) body.innerHTML='<tr><td colspan="5" class="center-text">No flagged transactions.</td></tr>'; document.getElementById("metric-flagged").textContent=n;
  });
  onValue(ref(db,"completed_ledger"), snap=>{
    const body=document.getElementById("ledger-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};addRow(body,[x.publicTxId||x.txId,x.note,x.completedAt?new Date(x.completedAt).toLocaleDateString():"--"]);});
    if(!n) body.innerHTML='<tr><td colspan="3" class="center-text">No completed transactions logged.</td></tr>'; document.getElementById("metric-completed").textContent=n;
  });
  onValue(ref(db,"users"), snap=>{
    const body=document.getElementById("users-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};addRow(body,[x.username,x.escrownId||x.escrownID,x.email,x.accountNumber?"••••••"+String(x.accountNumber).slice(-4):"Not provided"]);});
    if(!n) body.innerHTML='<tr><td colspan="4" class="center-text">No registered users.</td></tr>'; document.getElementById("metric-users").textContent=n;
  });
}
