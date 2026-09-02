import { onAuthStateChanged, signOut, getIdTokenResult } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { ref, onValue, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { httpsCallable, getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import { auth, db, app } from "./firebase-config.js";
const functions = getFunctions(app, "europe-west1");

function td(text) { const x=document.createElement("td"); x.textContent=String(text ?? "--"); return x; }
async function guard() { const u=auth.currentUser; if(!u) return false; const t=await getIdTokenResult(u,true); return t.claims.admin===true; }
function addRow(tbody, cells, action) { const tr=document.createElement("tr"); cells.forEach(v=>tr.appendChild(td(v))); if(action){const cell=document.createElement("td"); cell.appendChild(action); tr.appendChild(cell);} tbody.appendChild(tr); }

onAuthStateChanged(auth, async user => {
  if (!user || !(await guard().catch(()=>false))) { await signOut(auth); location.href="adminlogin.html"; return; }
  document.getElementById("admin-id-display")?.replaceChildren(document.createTextNode(user.email || "ADMIN"));
  load();
});

document.getElementById("admin-logout-btn")?.addEventListener("click", async()=>{await signOut(auth);location.href="adminlogin.html";});
function load(){
  onValue(ref(db,"flagged_transactions"), snap=>{
    const body=document.getElementById("flagged-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};const b=document.createElement("button");b.className="btn-outline";b.textContent="Resolve / Dismiss";b.onclick=()=>remove(ref(db,`flagged_transactions/${c.key}`));addRow(body,[x.publicTxId||x.txId,x.flaggedByUid,x.status||"OPEN",x.timestamp?new Date(x.timestamp).toLocaleString():"--"],b);});
    if(!n) body.innerHTML='<tr><td colspan="5" class="center-text">No flagged transactions.</td></tr>'; document.getElementById("metric-flagged").textContent=n;
  });
  onValue(ref(db,"completed_ledger"), snap=>{
    const body=document.getElementById("ledger-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};const b=document.createElement("button");b.className="btn-outline";b.textContent="Delete";b.onclick=()=>remove(ref(db,`completed_ledger/${c.key}`));addRow(body,[x.txId,x.note,x.completedAt?new Date(x.completedAt).toLocaleDateString():"--"],b);});
    if(!n) body.innerHTML='<tr><td colspan="4" class="center-text">No completed transactions logged.</td></tr>'; document.getElementById("metric-completed").textContent=n;
  });
  onValue(ref(db,"users"), snap=>{
    const body=document.getElementById("users-table-body"); body.replaceChildren(); let n=0;
    snap.forEach(c=>{n++;const x=c.val()||{};addRow(body,[x.username,x.escrownId||x.escrownID,x.email,x.accountNumber?"••••••"+String(x.accountNumber).slice(-4):"Not provided"]);});
    if(!n) body.innerHTML='<tr><td colspan="4" class="center-text">No registered users.</td></tr>'; document.getElementById("metric-users").textContent=n;
  });
}
