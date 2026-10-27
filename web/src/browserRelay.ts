import {FrameGate,unpack,isStale} from './protocol';
import {fragment,Reassembler,verifyEnvelope,MAX_ENVELOPE,MAX_MESSAGE,type BrowserPlan,type BrowserSignal,type BrowserLink,type RelayBytes,type RelayLinkDiagnostic} from './browserRelayProtocol';
export interface RelayStatus {role:BrowserPlan['role'];reason:string;centerBytes:number;peerBytes:number;sentBytes:number;verifiedFrames:number;rejected:number;path:string;sharing?:RelayBytes;links?:RelayLinkDiagnostic[];failure?:string;serverBackup?:boolean;mediaAgeMs?:number;planFrames?:number;active?:boolean}
export const emptyRelayStatus=():RelayStatus=>({role:'off',reason:'网页分流未开启',centerBytes:0,peerBytes:0,sentBytes:0,verifiedFrames:0,rejected:0,path:'尚未验证办公网路径'});
const CONTROL_LEASE_MS=9000, HIGH_WATER=2*1024*1024, LOW_WATER=256*1024;
interface Link {config:BrowserLink;generation:number;pc:RTCPeerConnection;channel?:RTCDataChannel;assembler:Reassembler;needKey:boolean;backpressured:boolean}
interface Callbacks {send:(command:unknown)=>void;frame:(buffer:ArrayBuffer)=>void;reset:(epoch:number)=>void;keyframe:()=>void;status:(status:RelayStatus)=>void;now:()=>number;expired:()=>void;revalidate?:()=>Promise<boolean>}
export class BrowserRelay {
 private plan:BrowserPlan|null=null;private key:Promise<CryptoKey>|null=null;private links=new Map<string,Link>();private gate=new FrameGate();
 private queue:{buffer:ArrayBuffer;peer:boolean;generation:number}[]=[];private processing=false;private disposed=false;private failed=false;private expired=false;
 private sharingBase:RelayBytes={centerBytes:0,peerBytes:0,sentBytes:0};private peerGate=new FrameGate();private peerFrames=0;private peerMediaAt=0;private failureCode="";
 private status=emptyRelayStatus();private controlAt=Date.now();private mediaAt=Date.now();private planAt=Date.now();private lastStats=0;private checkingStats=false;
 private lastReport=0;private planFrames=0;private lastKeyRequest=-Infinity;
 private timer:ReturnType<typeof setInterval>;private revalidating:Promise<void>|null=null;
 private visibilityChanged=()=>{
  if(this.disposed)return;
  this.lastReport=0;this.tick();
  if(this.plan?.active&&this.authorized()&&this.visibility()==='visible')this.requestKeyframe();
 };
 constructor(private cb:Callbacks){
  this.timer=setInterval(()=>this.tick(),500);
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',this.visibilityChanged);
 }
 static capable(){return typeof RTCPeerConnection==='function'&&!!globalThis.crypto?.subtle}
 touch(){this.controlAt=Date.now()}
 private visibility(){return typeof document==='undefined'?'unknown':document.visibilityState==='hidden'?'hidden':'visible'}
 private send(command:unknown){if(!this.disposed)this.cb.send({type:'browser',browser:command})}
 private requestKeyframe(){if(!this.disposed&&Date.now()-this.lastKeyRequest>=500){this.lastKeyRequest=Date.now();this.cb.keyframe()}}
 hello(){this.send({kind:'hello',capable:BrowserRelay.capable()})}
 apply(plan:BrowserPlan){
  if(this.disposed||this.expired||this.plan&&plan.generation<=this.plan.generation)return;
  const previous=this.plan;
  if(plan.active&&(!previous||previous.roomId!==plan.roomId||previous.epoch!==plan.epoch)){this.sharingBase={centerBytes:this.status.centerBytes,peerBytes:this.status.peerBytes,sentBytes:this.status.sentBytes};this.failureCode=""}
  const retain=previous?.active&&plan.active&&previous.roomId===plan.roomId&&previous.epoch===plan.epoch;
  const source=plan.role==='peer'&&plan.links.length===1?plan.links[0]:undefined;
  const previousSource=previous?.role==='peer'&&previous.links.length===1?previous.links[0]:undefined;
  const sameSource=retain&&!this.failed&&source&&previousSource&&source.id===previousSource.id&&source.peer===previousSource.peer&&this.links.has(source.id);
  // A membership generation is not a new screen stream. Keep the decoder and
  // sequence gate for receivers in the same sharing epoch, even on a source swap.
  const receives=(p:BrowserPlan)=>['root','peer','direct'].includes(p.role);
  const keepPlayback=retain&&previous&&receives(previous)&&receives(plan);
  this.queue=[];this.plan=plan;this.failed=false;this.key=null;if(!keepPlayback)this.gate.reset(plan.epoch);
  // Membership churn must not extend the deadline of an already stalled source.
  if(!sameSource){this.planAt=this.mediaAt=this.peerMediaAt=Date.now();this.peerFrames=0;this.peerGate.reset(plan.epoch)}
  this.planFrames=0;this.lastReport=0;
  this.status={...this.status,role:plan.role,reason:plan.reason,path:'尚未验证办公网路径',serverBackup:!!plan.serverBackup};
  for(const [id,link] of this.links){
   const next=plan.links.find(c=>c.id===id&&c.peer===link.config.peer&&c.offerer===link.config.offerer);
   if(!retain||!next){this.closeLink(link);this.links.delete(id)}
   else {link.config=next;link.assembler.clear();link.needKey=true}
  }
  if(!plan.active){this.publish();return}
  if(!keepPlayback)this.cb.reset(plan.epoch);
  if(plan.publicKey){
   const key=this.key=crypto.subtle.importKey('jwk',plan.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   void key.catch(()=>{if(this.current(plan)&&this.key===key)this.fail('key_import_failed')});
  }
  for(const config of plan.links){
   if(this.links.has(config.id))continue;
   try{
    const pc=new RTCPeerConnection({iceServers:[],iceCandidatePoolSize:0,bundlePolicy:'max-bundle'});
    const link:Link={config,generation:config.generation??plan.generation,pc,assembler:new Reassembler(),needKey:true,backpressured:false};this.links.set(config.id,link);
    pc.onconnectionstatechange=()=>{if(this.linked(link)&&pc.connectionState==='failed')this.fail('ice_failed')};
    pc.ondatachannel=event=>{if(!this.linked(link)||config.offerer||link.channel||event.channel.label!=='webzoom-frames'){event.channel.close();return}this.channel(link,event.channel)};
    if(config.offerer){this.channel(link,pc.createDataChannel('webzoom-frames',{ordered:true}));void this.offer(link)}
   }catch{this.fail('setup_failed');break}
  }
  this.requestKeyframe();this.publish();
 }
 private current(plan:BrowserPlan,link?:Link){return !this.disposed&&this.plan===plan&&(!link||this.links.get(link.config.id)===link)}
 private linked(link:Link){return !this.disposed&&!this.failed&&!!this.plan?.active&&this.links.get(link.config.id)===link}
 // A frozen event loop can resume before its queued clock reply. Stop media
 // immediately, but first challenge the existing authenticated WSS connection.
 // Ordinary queued controls cannot complete this fresh-response check.
 private authorized(){
  if(this.disposed||this.expired||this.revalidating)return false;
  if(this.plan?.active&&Date.now()-this.controlAt>CONTROL_LEASE_MS){
   if(!this.cb.revalidate){this.expireControl();return false}
   this.queue=[];this.gate.reset(this.plan.epoch);
   for(const link of this.links.values()){link.assembler.clear();link.needKey=true}
   this.cb.reset(this.plan.epoch);this.status.reason='后台恢复后正在确认中心连接，暂停售流';this.publish();
   const operation=Promise.resolve().then(()=>this.cb.revalidate!()).then(ok=>{
    if(this.disposed)return;
    if(!ok){this.expireControl();return}
    this.controlAt=this.planAt=this.mediaAt=Date.now();
    this.status.reason=this.plan?.reason??this.status.reason;this.requestKeyframe();this.publish();
   }).catch(()=>{if(!this.disposed)this.expireControl()}).finally(()=>{if(this.revalidating===operation)this.revalidating=null});
   this.revalidating=operation;return false;
  }
  return true;
 }
 private expireControl(){
  if(this.disposed||this.expired)return;
  this.expired=true;this.disconnectLinks();this.queue=[];this.failed=true;this.key=null;
  if(this.plan)this.cb.reset(this.plan.epoch);
  this.status.reason='中心授权连接超时，已停止同伴转发并重新验证登录';this.publish();this.cb.expired();
 }
 private async controlReady(){
  if(this.authorized())return true;
  if(this.revalidating)await this.revalidating;
  return this.authorized();
 }
 private async gathered(pc:RTCPeerConnection){
  if(pc.iceGatheringState==='complete')return;
  await new Promise<void>((resolve,reject)=>{
   const finish=(error?:Error)=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);pc.removeEventListener('connectionstatechange',closed);error?reject(error):resolve()};
   const changed=()=>{if(pc.iceGatheringState==='complete')finish()};
   const closed=()=>{if(pc.connectionState==='closed')finish(Error('closed'))};
   const timer=setTimeout(()=>finish(Error('ICE gathering timeout')),5000);
   pc.addEventListener('icegatheringstatechange',changed);pc.addEventListener('connectionstatechange',closed);changed();closed();
  });
 }
 private async local(link:Link,description:RTCSessionDescriptionInit){
  if(!this.linked(link))return;
  await link.pc.setLocalDescription(description);await this.gathered(link.pc);
  if(!this.linked(link)||!await this.controlReady()||!this.linked(link))return;
  const sdp=link.pc.localDescription?.sdp;if(!sdp||sdp.length>12*1024)throw Error('SDP size');
  this.send({kind:'signal',signal:{generation:this.plan!.generation,link:link.config.id,type:description.type,sdp}});
 }
 private async offer(link:Link){try{await this.local(link,await link.pc.createOffer())}catch{if(this.linked(link))this.fail('negotiation_failed')}}
 async signal(signal:BrowserSignal){
  const plan=this.plan,link=this.links.get(signal.link);
  if(!plan||!link||signal.generation>plan.generation||signal.generation<link.generation||!this.linked(link)||!await this.controlReady()||!this.linked(link))return;
  try{
   if(signal.type!==(link.config.offerer?'answer':'offer'))throw Error('signal direction');
   await link.pc.setRemoteDescription({type:signal.type,sdp:signal.sdp});
   if(!this.linked(link))return;
   if(signal.type==='offer')await this.local(link,await link.pc.createAnswer());
  }catch{if(this.linked(link))this.fail('negotiation_failed')}
 }
 private channel(link:Link,channel:RTCDataChannel){
  link.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=LOW_WATER;
  channel.onopen=()=>{if(this.linked(link)&&this.authorized())this.requestKeyframe()};
  channel.onbufferedamountlow=()=>this.resumeLink(link);
  channel.onclose=()=>{if(this.linked(link))this.fail('channel_closed')};
  channel.onerror=()=>{if(this.linked(link))this.fail('channel_error')};
  let windowAt=Date.now(),bytes=0;
  channel.onmessage=event=>{
   if(!this.linked(link)||!this.authorized())return;
   if(link.config.offerer||!(event.data instanceof ArrayBuffer)){channel.close();return}
   if(Date.now()-windowAt>=1000){windowAt=Date.now();bytes=0}bytes+=event.data.byteLength;
   if(bytes>4*1024*1024){this.fail('receive_limit');return}
   try{const complete=link.assembler.receive(event.data);if(complete)this.receive(complete,true)}catch{this.status.rejected++;this.fail('invalid_fragment')}
  };
 }
 receive(buffer:ArrayBuffer,peer=false){
  const plan=this.plan;if(!plan?.active||this.disposed||(this.failed&&(!plan.serverBackup||peer))||!this.authorized())return;
  if(!peer)this.status.centerBytes+=buffer.byteLength;
  if(peer&&plan.role!=='peer'||!peer&&plan.role!=='root'&&plan.role!=='direct'&&!plan.serverBackup)return;
  // Retained channels can finish a previous-generation frame. Ignore it without
  // resetting the new decoder or generating a storm of keyframe requests.
  if(buffer.byteLength>=8&&new DataView(buffer).getUint32(4)!==plan.generation)return;
  if(buffer.byteLength>MAX_ENVELOPE||this.queue.length>=3){this.status.rejected++;this.requestKeyframe();return}
  this.queue.push({buffer,peer,generation:plan.generation});void this.drain();
 }
 private async drain(){
  if(this.processing)return;this.processing=true;
  try{while(this.queue.length&&!this.disposed){
   const item=this.queue.shift()!,plan=this.plan,key=this.key;
   if(!plan||!key||item.generation!==plan.generation)continue;
   try{
    const raw=await verifyEnvelope(item.buffer,plan,await key,this.cb.now());
    if(!this.current(plan)||(this.failed&&(!plan.serverBackup||item.peer))||!this.authorized())continue;
    const f=unpack(raw);
    if(item.peer&&this.peerGate.accept(f)){this.peerFrames++;this.peerMediaAt=Date.now();this.status.peerBytes+=item.buffer.byteLength}
    if(isStale(f.timestamp,this.cb.now())||!this.gate.accept(f)){if(!plan.serverBackup)this.requestKeyframe();continue}
    this.mediaAt=Date.now();this.status.verifiedFrames++;this.planFrames++;
    this.cb.frame(raw);
    if(plan.role==='root')for(const link of this.links.values())this.forward(link,item.buffer,f.key);
   }catch{if(this.current(plan)){this.status.rejected++;this.gate.reset(plan.epoch);this.requestKeyframe()}}
  }}finally{this.processing=false}
 }
 private resumeLink(link:Link){
  if(!this.linked(link)||!this.authorized()||!link.backpressured||!link.channel||link.channel.bufferedAmount>LOW_WATER)return;
  link.backpressured=false;link.needKey=true;this.requestKeyframe();
 }
 private forward(link:Link,buffer:ArrayBuffer,key:boolean){
  const channel=link.channel;if(!channel||channel.readyState!=='open'||!this.authorized())return;
  if(link.backpressured){this.resumeLink(link);if(link.backpressured)return}
  if(link.needKey&&!key)return;
  try{
   const negotiated=link.pc.sctp?.maxMessageSize??MAX_MESSAGE;
   const parts=fragment(buffer,negotiated===0?MAX_MESSAGE:negotiated);
   const bytes=parts.reduce((sum,part)=>sum+part.byteLength,0);
   if(channel.bufferedAmount+bytes>HIGH_WATER){link.needKey=true;link.backpressured=true;return}
   for(const part of parts){channel.send(part);this.status.sentBytes+=part.byteLength}
   link.needKey=false;
  }catch{link.needKey=true;this.requestKeyframe()}
 }
 private fail(failure='connection_failed'){
  const plan=this.plan;if(!plan?.active||this.disposed||this.failed)return;
  if(plan.role!=='peer')return; // One failed downstream must not stop healthy siblings.
  this.failureCode=failure;this.failed=true;this.disconnectLinks();this.queue=plan.serverBackup?this.queue.filter(item=>!item.peer):[];this.status.reason='同伴供流中断，正在申请换源或受限服务器直连';this.publish();
  this.send({kind:'failed',generation:plan.generation,failure});
 }
 private tick(){
  if(!this.authorized())return;
  const now=Date.now();
  if(this.plan?.role==='peer'&&now-this.planAt>12000&&now-this.peerMediaAt>4000)this.fail(this.peerFrames>0?'peer_stalled':[...this.links.values()].some(l=>l.channel?.readyState==='open')?'peer_no_media':'connection_timeout');
  for(const link of this.links.values())this.resumeLink(link);
  if(now-this.lastStats>5000&&!this.checkingStats){this.lastStats=now;void this.inspectPath()}
  if(this.plan?.active&&now-this.lastReport>=2000){
   this.lastReport=now;const s=this.status;
   this.send({kind:'report',generation:this.plan.generation,report:{generation:this.plan.generation,centerBytes:s.centerBytes,peerBytes:s.peerBytes,sentBytes:s.sentBytes,verifiedFrames:s.verifiedFrames,rejected:s.rejected,planFrames:this.planFrames,mediaAgeMs:Math.max(0,now-this.mediaAt),visibility:this.visibility(),sharing:this.sharingBytes(),peerPlanFrames:this.peerFrames,peerMediaAgeMs:Math.max(0,now-this.peerMediaAt)}});
  }
  this.publish();
 }
 private async inspectPath(){
  this.checkingStats=true;const plan=this.plan;
  try{const diagnostics:RelayLinkDiagnostic[]=[];for(const link of this.links.values()){
   const diagnostic:RelayLinkDiagnostic={connection:link.pc.connectionState,ice:link.pc.iceConnectionState,channel:link.channel?.readyState??'none',bufferedBytes:link.channel?.bufferedAmount??0};diagnostics.push(diagnostic);
   const stats=await link.pc.getStats();if(!plan||!this.current(plan,link))return;
   let pair:RTCStats|undefined;
   stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId)});
   if(pair){const p=pair as RTCStats&{localCandidateId:string;remoteCandidateId:string};const local=stats.get(p.localCandidateId),remote=stats.get(p.remoteCandidateId);
    const rtt=(pair as RTCStats&{currentRoundTripTime?:number}).currentRoundTripTime;if(typeof rtt==='number'&&Number.isFinite(rtt))diagnostic.rttMs=Math.round(rtt*1000);
    this.status.path=(local?.candidateType??'?')+' → '+(remote?.candidateType??'?')+' / '+(local?.protocol??'?')+'；办公网路径待现场核验';
   }
  }this.diagnostics=diagnostics;}catch{/* Closed connections are expected during generation changes. */}finally{this.checkingStats=false}
 }
 private sharingBytes():RelayBytes{return {centerBytes:this.status.centerBytes-this.sharingBase.centerBytes,peerBytes:this.status.peerBytes-this.sharingBase.peerBytes,sentBytes:this.status.sentBytes-this.sharingBase.sentBytes}}
 private diagnostics:RelayLinkDiagnostic[]=[];
 private publish(){this.cb.status({...this.status,sharing:this.sharingBytes(),failure:this.failureCode,links:this.diagnostics.map(l=>({...l})),mediaAgeMs:Math.max(0,Date.now()-this.mediaAt),planFrames:this.planFrames,active:!!this.plan?.active})}
 private closeLink(link:Link){
  link.pc.onconnectionstatechange=null;link.pc.ondatachannel=null;
  if(link.channel){link.channel.onopen=null;link.channel.onclose=null;link.channel.onerror=null;link.channel.onmessage=null;link.channel.onbufferedamountlow=null;link.channel.close()}
  link.assembler.clear();link.pc.close();
 }
 private disconnectLinks(){this.diagnostics=[];for(const link of this.links.values())this.closeLink(link);this.links.clear()}
 close(){
  this.disposed=true;clearInterval(this.timer);
  if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.visibilityChanged);
  this.disconnectLinks();this.queue=[];this.plan=null;this.key=null;
 }
}
