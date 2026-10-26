export async function withSharingDeadline<T>(notify:(signal:AbortSignal)=>Promise<T>,milliseconds=10000):Promise<T> {
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  const deadline=new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>{reject(new Error('共享请求超时，请重试。'));controller.abort()},milliseconds);
  });
  return await Promise.race([notify(controller.signal),deadline]);
 }finally{clearTimeout(timer)}
}

// Use the transport that owns the capture, never a replacement connection.
export function sendSharingControl(socket:WebSocket|null,type:'cancel-start'|'stop-sharing',epoch:number):boolean {
 if(socket?.readyState!==WebSocket.OPEN)return false;
 try{socket.send(JSON.stringify({type,epoch}));return true}catch{return false}
}

// Do not unlock the next start until the server has processed this cleanup.
// If its outcome cannot be confirmed, retire this transport: publisher
// disconnect is the existing server-side fence for all of its pending starts.
export async function confirmSharingControl(socket:WebSocket|null,type:'cancel-start'|'stop-sharing',epoch:number):Promise<boolean> {
 if(socket?.readyState!==WebSocket.OPEN)return false;
 try{
  await withSharingDeadline(signal=>new Promise<void>((resolve,reject)=>{
   const finish=(error?:Error)=>{
    socket.removeEventListener('message',message);socket.removeEventListener('close',closed);signal.removeEventListener('abort',aborted);
    if(error)reject(error);else resolve();
   };
   const message=(event:MessageEvent)=>{if(typeof event.data!=='string')return;try{const value=JSON.parse(event.data);if(value.type==='sharing-control'&&value.action===type&&value.epoch===epoch)finish()}catch{}};
   const closed=()=>finish(new Error('共享连接已中断。'));
   const aborted=()=>finish(new Error('共享清理未获确认。'));
   socket.addEventListener('message',message);socket.addEventListener('close',closed);signal.addEventListener('abort',aborted,{once:true});
   if(!sendSharingControl(socket,type,epoch))closed();
  }),2000);
  return true;
 }catch{try{socket.close()}catch{}return false}
}
