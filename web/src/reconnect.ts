// Bounded exponential delay with jitter avoids synchronized reconnect storms.
// Returns null after the final attempt. random is injectable for deterministic tests.
export function reconnectDelay(attempt:number,random:()=>number=Math.random):number|null {
 if(!Number.isInteger(attempt)||attempt<1||attempt>8)return null;
 const base=Math.min(1000*2**(attempt-1),8000);
 return Math.round(base*(0.75+Math.min(1,Math.max(0,random()))*0.5));
}