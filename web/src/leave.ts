interface LeaveOptions {
 notify:(signal:AbortSignal)=>Promise<unknown>;
 fallback:()=>void;
 finish:()=>void;
}
// Never trap the user behind an unavailable HTTP endpoint. The HTTP path
// clears recovery even when the socket is offline; the socket is best effort.
export async function leaveMeeting(options:LeaveOptions):Promise<void> {
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  const deadline=new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>{reject(new Error('leave timed out'));controller.abort()},2000);
  });
  await Promise.race([options.notify(controller.signal),deadline]);
 }catch{
  try {options.fallback()}catch{/* A closed socket must not block navigation. */}
 }finally{
  clearTimeout(timer);options.finish();
 }
}
