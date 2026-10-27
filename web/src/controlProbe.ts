// Only a reply to a new negative clock nonce proves the WSS connection is live.
// Background/OS suspension is not a failed network test: restart the probe after
// a scheduling gap, and count a timeout only while the visible event loop runs.
export class ControlProbe {
 private nonce=0;private sentAt=0;private checkedAt=0;private disposed=false;
 private pending:Promise<boolean>|null=null;private resolve:((ok:boolean)=>void)|null=null;
 private timer:ReturnType<typeof setInterval>|undefined;
 private resume=()=>{if(this.pending)this.sendFresh()};
 constructor(private send:(nonce:number)=>void,private visible=()=>typeof document==='undefined'||document.visibilityState!=='hidden'){
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',this.resume);
  if(typeof window!=='undefined')window.addEventListener('pageshow',this.resume);
 }
 check():Promise<boolean>{
  if(this.disposed)return Promise.resolve(false);
  if(this.pending)return this.pending;
  const result=this.pending=new Promise<boolean>(resolve=>{this.resolve=resolve});
  this.timer=setInterval(()=>this.tick(),250);this.sendFresh();return result;
 }
 private sendFresh(){
  this.sentAt=this.checkedAt=Date.now();this.nonce--;
  try{this.send(this.nonce)}catch{this.finish(false)}
 }
 receive(nonce:number){
  if(!this.pending||nonce!==this.nonce)return;
  const age=Date.now()-this.sentAt;
  if(age<0||age>=5000){this.sendFresh();return}
  this.finish(true);
 }
 private tick(){
  const now=Date.now(),gap=now-this.checkedAt;this.checkedAt=now;
  if(gap<0||gap>2000){this.sendFresh();return}
  if(this.visible()&&now-this.sentAt>=5000)this.finish(false);
 }
 private finish(ok:boolean){
  clearInterval(this.timer);this.timer=undefined;
  const resolve=this.resolve;this.resolve=null;this.pending=null;resolve?.(ok);
 }
 dispose(){
  this.disposed=true;this.finish(false);
  if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.resume);
  if(typeof window!=='undefined')window.removeEventListener('pageshow',this.resume);
 }
}
