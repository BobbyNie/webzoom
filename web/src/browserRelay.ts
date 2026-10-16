import {FrameGate,unpack,isStale} from './protocol';
import {fragment,Reassembler,verifyEnvelope,MAX_ENVELOPE,MAX_MESSAGE,type BrowserPlan,type BrowserSignal,type BrowserLink} from './browserRelayProtocol';
export interface RelayStatus {role:BrowserPlan['role'];reason:string;centerBytes:number;peerBytes:number;sentBytes:number;verifiedFrames:number;rejected:number;path:string}
export const emptyRelayStatus=():RelayStatus=>({role:'off',reason:'网页分流未开启',centerBytes:0,peerBytes:0,sentBytes:0,verifiedFrames:0,rejected:0,path:'尚未验证办公网路径'});
interface Link {config:BrowserLink;pc:RTCPeerConnection;channel?:RTCDataChannel;assembler:Reassembler;needKey:boolean}
interface Callbacks {send:(command:unknown)=>void;frame:(buffer:ArrayBuffer)=>void;reset:(epoch:number)=>void;keyframe:()=>void;status:(status:RelayStatus)=>void;now:()=>number;expired:()=>void}
export class BrowserRelay {
 private plan:BrowserPlan|null=null;private key:Promise<CryptoKey>|null=null;private links=new Map<string,Link>();private gate=new FrameGate();
 private queue:{buffer:ArrayBuffer;peer:boolean;generation:number}[]=[];private processing=false;private disposed=false;private failed=false;private expired=false;
 private status=emptyRelayStatus();private controlAt=Date.now();private mediaAt=Date.now();private planAt=Date.now();private lastStats=0;private checkingStats=false;
 private lastReport=0;private planFrames=0;
 private timer:ReturnType<typeof setInterval>;
 constructor(private cb:Callbacks){this.timer=setInterval(()=>this.tick(),500)}
 static capable(){return typeof RTCPeerConnection==='function'&&!!globalThis.crypto?.subtle}
 touch(){this.controlAt=Date.now()}
 private send(command:unknown){if(!this.disposed)this.cb.send({type:'browser',browser:command})}
 hello(){this.send({kind:'hello',capable:BrowserRelay.capable()})}
 apply(plan:BrowserPlan){
  if(this.disposed||this.plan&&plan.generation<=this.plan.generation)return;
  this.disconnectLinks();this.queue=[];this.plan=plan;this.failed=false;this.key=null;this.gate.reset(plan.epoch);this.planAt=this.mediaAt=Date.now();
  this.planFrames=0;this.lastReport=0;
  this.status={...this.status,role:plan.role,reason:plan.reason,path:'尚未验证办公网路径'};
  if(!plan.active){this.publish();return}
  this.cb.reset(plan.epoch);
  if(plan.publicKey)this.key=crypto.subtle.importKey('jwk',plan.publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  void this.key?.catch(()=>this.fail('key_import_failed'));
  for(const config of plan.links){
   try{
    const pc=new RTCPeerConnection({iceServers:[],iceCandidatePoolSize:0,bundlePolicy:'max-bundle'});
    const link:Link={config,pc,assembler:new Reassembler(),needKey:true};this.links.set(config.id,link);
    pc.onconnectionstatechange=()=>{if(this.current(plan,link)&&pc.connectionState==='failed')this.fail('ice_failed')};
    pc.ondatachannel=event=>{if(!this.current(plan,link)||config.offerer||link.channel||event.channel.label!=='webzoom-frames'){event.channel.close();return}this.channel(link,event.channel,plan)};
    if(config.offerer){this.channel(link,pc.createDataChannel('webzoom-frames',{ordered:true}),plan);void this.offer(link,plan)}
   }catch{this.fail('setup_failed')}
  }this.publish();
 }
 private current(plan:BrowserPlan,link?:Link){return !this.disposed&&this.plan===plan&&(!link||this.links.get(link.config.id)===link)}
 private async gathered(pc:RTCPeerConnection){
  if(pc.iceGatheringState==='complete')return;
  await new Promise<void>((resolve,reject)=>{
   const finish=(error?:Error)=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);pc.removeEventListener('connectionstatechange',closed);error?reject(error):resolve()};
   const changed=()=>{if(pc.iceGatheringState==='complete')finish()};
   const closed=()=>{if(pc.connectionState==='closed')finish(Error('closed'))};
   const timer=setTimeout(()=>finish(Error('ICE gathering timeout')),5000);
   pc.addEventListener('icegatheringstatechange',changed);pc.addEventListener('connectionstatechange',closed);changed();
  });
 }
 private async local(link:Link,plan:BrowserPlan,description:RTCSessionDescriptionInit){
  await link.pc.setLocalDescription(description);await this.gathered(link.pc);
  if(!this.current(plan,link))return;
  const sdp=link.pc.localDescription?.sdp;if(!sdp||sdp.length>12*1024)throw Error('SDP size');
  this.send({kind:'signal',signal:{generation:plan.generation,link:link.config.id,type:description.type,sdp}});
 }
 private async offer(link:Link,plan:BrowserPlan){try{await this.local(link,plan,await link.pc.createOffer())}catch{if(this.current(plan,link))this.fail('negotiation_failed')}}
 async signal(signal:BrowserSignal){
  const plan=this.plan,link=this.links.get(signal.link);
  if(!plan||!link||signal.generation!==plan.generation||!this.current(plan,link))return;
  try{
   if(signal.type!==(link.config.offerer?'answer':'offer'))throw Error('signal direction');
   await link.pc.setRemoteDescription({type:signal.type,sdp:signal.sdp});
   if(!this.current(plan,link))return;
   if(signal.type==='offer')await this.local(link,plan,await link.pc.createAnswer());
  }catch{if(this.current(plan,link))this.fail('negotiation_failed')}
 }
 private channel(link:Link,channel:RTCDataChannel,plan:BrowserPlan){
  link.channel=channel;channel.binaryType='arraybuffer';
  channel.onopen=()=>{if(this.current(plan,link))this.cb.keyframe()};
  channel.onclose=()=>{if(this.current(plan,link))this.fail('channel_closed')};
  channel.onerror=()=>{if(this.current(plan,link))this.fail('channel_error')};
  let windowAt=Date.now(),bytes=0;
  channel.onmessage=event=>{
   if(!this.current(plan,link))return;
   if(link.config.offerer||!(event.data instanceof ArrayBuffer)){channel.close();return}
   if(Date.now()-windowAt>=1000){windowAt=Date.now();bytes=0}bytes+=event.data.byteLength;
   if(bytes>4*1024*1024){this.fail('receive_limit');return}
   try{const complete=link.assembler.receive(event.data);if(complete)this.receive(complete,true)}catch{this.status.rejected++;this.fail('invalid_fragment')}
  };
 }
 receive(buffer:ArrayBuffer,peer=false){
  const plan=this.plan;if(!plan?.active||this.disposed||this.failed)return;
  if(!peer)this.status.centerBytes+=buffer.byteLength;
  if(peer&&plan.role!=='peer'||!peer&&plan.role!=='root'&&plan.role!=='direct')return;
  if(buffer.byteLength>MAX_ENVELOPE||this.queue.length>=3){this.status.rejected++;this.cb.keyframe();return}
  this.queue.push({buffer,peer,generation:plan.generation});void this.drain();
 }
 private async drain(){
  if(this.processing)return;this.processing=true;
  try{while(this.queue.length&&!this.disposed){
   const item=this.queue.shift()!,plan=this.plan,key=this.key;
   if(!plan||!key||item.generation!==plan.generation)continue;
   try{
    const raw=await verifyEnvelope(item.buffer,plan,await key,this.cb.now());
    if(!this.current(plan)||this.failed)continue;
    const f=unpack(raw);
    if(isStale(f.timestamp,this.cb.now())||!this.gate.accept(f)){this.cb.keyframe();continue}
    this.mediaAt=Date.now();this.status.verifiedFrames++;this.planFrames++;if(item.peer)this.status.peerBytes+=item.buffer.byteLength;
    this.cb.frame(raw);
    if(plan.role==='root')for(const link of this.links.values())this.forward(link,item.buffer,f.key);
   }catch{if(this.current(plan)){this.status.rejected++;this.gate.reset(plan.epoch);this.cb.keyframe()}}
  }}finally{this.processing=false}
 }
 private forward(link:Link,buffer:ArrayBuffer,key:boolean){
  const channel=link.channel;if(!channel||channel.readyState!=='open')return;
  if(link.needKey&&!key)return;
  if(channel.bufferedAmount+buffer.byteLength>2*1024*1024){link.needKey=true;this.cb.keyframe();return}
  try{
   const negotiated=link.pc.sctp?.maxMessageSize??MAX_MESSAGE;
   for(const part of fragment(buffer,negotiated===0?MAX_MESSAGE:negotiated)){channel.send(part);this.status.sentBytes+=part.byteLength}
   link.needKey=false;
  }catch{link.needKey=true;this.cb.keyframe()}
 }
 private fail(failure='connection_failed'){
  const plan=this.plan;if(!plan?.active||this.disposed||this.failed)return;
  if(plan.role!=='peer')return; // A root still serves itself and the other leaf.
  this.failed=true;this.disconnectLinks();this.queue=[];this.status.reason='同伴连接未能持续供流，正在申请受限中心直连';this.publish();
  this.send({kind:'failed',generation:plan.generation,failure});
 }
 private tick(){
  if(this.disposed)return;
  if(this.plan?.active&&Date.now()-this.controlAt>9000){if(!this.expired){this.expired=true;this.disconnectLinks();this.queue=[];this.failed=true;this.cb.reset(this.plan.epoch);this.status.reason='中心授权连接超时，已停止同伴转发并重新验证登录';this.publish();this.cb.expired()}return}
  if(this.plan?.role==='peer'&&Date.now()-this.planAt>12000&&Date.now()-this.mediaAt>4000)this.fail('media_timeout');
  if(Date.now()-this.lastStats>2000&&!this.checkingStats){this.lastStats=Date.now();void this.inspectPath()}
  if(this.plan?.active&&Date.now()-this.lastReport>=2000){
   this.lastReport=Date.now();const s=this.status;
   this.send({kind:'report',generation:this.plan.generation,report:{generation:this.plan.generation,centerBytes:s.centerBytes,peerBytes:s.peerBytes,sentBytes:s.sentBytes,verifiedFrames:s.verifiedFrames,rejected:s.rejected,planFrames:this.planFrames,mediaAgeMs:Math.max(0,Date.now()-this.mediaAt)}});
  }
  this.publish();
 }
 private async inspectPath(){
  this.checkingStats=true;const plan=this.plan;
  try{for(const link of this.links.values()){
   const stats=await link.pc.getStats();if(!plan||!this.current(plan,link))return;
   let pair:RTCStats|undefined;
   stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId)});
   if(pair){const p=pair as RTCStats&{localCandidateId:string;remoteCandidateId:string};const local=stats.get(p.localCandidateId),remote=stats.get(p.remoteCandidateId);
    this.status.path=(local?.candidateType??'?')+' → '+(remote?.candidateType??'?')+' / '+(local?.protocol??'?')+'；办公网路径待现场核验';
   }
  }}catch{/* Closed connections are expected during generation changes. */}finally{this.checkingStats=false}
 }
 private publish(){this.cb.status({...this.status})}
 private disconnectLinks(){for(const link of this.links.values()){link.pc.onconnectionstatechange=null;link.pc.ondatachannel=null;if(link.channel){link.channel.onopen=null;link.channel.onclose=null;link.channel.onerror=null;link.channel.onmessage=null;link.channel.close()}link.assembler.clear();link.pc.close()}this.links.clear()}
 close(){this.disposed=true;clearInterval(this.timer);this.disconnectLinks();this.queue=[];this.plan=null;this.key=null}
}