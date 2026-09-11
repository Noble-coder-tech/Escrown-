import { getClientLogs, clearClientLogs } from "./auth.js";
const out = document.getElementById("log-output");
function render(){ const logs=getClientLogs(); out.textContent=logs.length ? logs.map(x=>JSON.stringify(x,null,2)).join("\n\n") : "No client error logs recorded yet."; }
document.getElementById("refresh-logs")?.addEventListener("click",render);
document.getElementById("clear-logs")?.addEventListener("click",()=>{clearClientLogs();render();});
document.getElementById("copy-logs")?.addEventListener("click",async()=>{await navigator.clipboard.writeText(JSON.stringify(getClientLogs(),null,2));alert("Logs copied.");});
document.getElementById("download-logs")?.addEventListener("click",()=>{const blob=new Blob([JSON.stringify(getClientLogs(),null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`escrown-error-logs-${Date.now()}.json`;a.click();URL.revokeObjectURL(a.href);});
render();
