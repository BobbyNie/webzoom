// Bounded exponential delay with jitter avoids synchronized reconnect storms.
// Returns null after the final attempt. random is injectable for deterministic tests.
export function reconnectDelay(attempt:number,random:()=>number=Math.random):number|null {
 if(!Number.isInteger(attempt)||attempt<1||attempt>8)return null;
 const base=Math.min(1000*2**(attempt-1),8000);
 return Math.round(base*(0.75+Math.min(1,Math.max(0,random()))*0.5));
}

// A failed preflight must not block the retry loop indefinitely. Also settle
// when an operation ignores AbortSignal, and detach all timers on cleanup.
export async function withConnectionDeadline<T>(operation:(signal:AbortSignal)=>Promise<T>,lifetime:AbortSignal,milliseconds=10000):Promise<T> {
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let cancelled=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{
  cancelled=()=>{reject(lifetime.reason);controller.abort(lifetime.reason)};
  if(lifetime.aborted){cancelled();return}
  lifetime.addEventListener('abort',cancelled,{once:true});
  timer=setTimeout(()=>{reject(new Error('连接请求超时。'));controller.abort()},milliseconds);
 });
 try{
  if(lifetime.aborted)return await interrupted;
  return await Promise.race([operation(controller.signal),interrupted]);
 }finally{clearTimeout(timer);lifetime.removeEventListener('abort',cancelled)}
}

// Handshake timeout owns only this socket. OPEN may precede the queued open
// event after a suspended page resumes, so inspect readyState before retiring.
export function watchSocketOpening(socket:WebSocket,expired:()=>void,milliseconds=10000):()=>void {
 const stop=()=>{clearTimeout(timer);socket.removeEventListener('open',stop);socket.removeEventListener('close',stop)};
 const timer=setTimeout(()=>{
  stop();if(socket.readyState!==socket.CONNECTING)return;
  try{socket.close()}catch{}finally{expired()}
 },milliseconds);
 socket.addEventListener('open',stop);socket.addEventListener('close',stop);
 return stop;
}
