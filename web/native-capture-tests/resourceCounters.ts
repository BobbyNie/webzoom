// Test-only validation. A missing browser process is an incomplete sample, not
// zero memory; the caller may retry with a freshly reported browser PID list.
export interface ProcessCounters {Id:number;WorkingSet64:number;PrivateMemorySize64:number;HandleCount:number}
export function validateCounters(ids:number[],value:unknown){
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('Invalid test-browser process IDs');
 const rows=Array.isArray(value)?value:[value];
 const processes:ProcessCounters[]=[];
 for(const row of rows){
  if(!row||typeof row!=='object'||!ids.includes(row.Id)||processes.some(p=>p.Id===row.Id)||(['WorkingSet64','PrivateMemorySize64','HandleCount'] as const).some(key=>!Number.isSafeInteger(row[key])||row[key]<0))throw Error('Invalid browser process memory counters: '+JSON.stringify(value));
  processes.push(row as ProcessCounters);
 }
 const missingIds=ids.filter(id=>!processes.some(p=>p.Id===id));
 return {processes,missingIds,complete:missingIds.length===0};
}
