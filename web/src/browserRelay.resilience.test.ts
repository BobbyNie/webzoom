import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {BrowserRelay} from './browserRelay';
import {pack} from './protocol';
import type {BrowserPlan} from './browserRelayProtocol';
class Channel {
 label='webzoom-frames';readyState='open';bufferedAmount=0;bufferedAmountLowThreshold=0;binaryType='';
 onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
 onmessage:((event:{data:ArrayBuffer})=>void)|null=null;onbufferedamountlow:(()=>void)|null=null;
 send=vi.fn();close=vi.fn(()=>{this.readyState='closed'});
}
class Connection {
 static instances:Connection[]=[];
 connectionState='connected';iceGatheringState='complete';sctp={maxMessageSize:16384};
 onconnectionstatechange:(()=>void)|null=null;ondatachannel:((event:{channel:Channel})=>void)|null=null;
 localDescription:RTCSessionDescriptionInit|null=null;channel=new Channel();
 constructor(){Connection.instances.push(this)}
 createDataChannel=vi.fn(()=>this.channel);
 createOffer=vi.fn(async()=>({type:'offer' as const,sdp:'offer'}));
 createAnswer=vi.fn(async()=>({type:'answer' as const,sdp:'answer'}));
 setLocalDescription=vi.fn(async(description:RTCSessionDescriptionInit)=>{this.localDescription=description});
 setRemoteDescription=vi.fn(async(_description:RTCSessionDescriptionInit)=>{});
 close=vi.fn(()=>{this.connectionState='closed'});
 getStats=vi.fn(async()=>new Map());
}
const plan:BrowserPlan={roomId:'a'.repeat(32),generation:7,epoch:3,active:true,role:'root',reason:'test',links:[]};
const relays:BrowserRelay[]=[];
function setup(){
 const cb={send:vi.fn(),frame:vi.fn(),reset:vi.fn(),keyframe:vi.fn(),status:vi.fn(),now:()=>1000,expired:vi.fn()};
 const relay=new BrowserRelay(cb);relays.push(relay);return {relay,cb};
}
async function signing(){
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey);
 async function frame(sequence:number,key=true,generation=7){
  const raw=pack({epoch:3,sequence,timestamp:1000000,key,width:640,height:360,data:new Uint8Array(20000)});
  const out=new Uint8Array(104+raw.byteLength),v=new DataView(out.buffer);
  v.setUint32(0,0x575a5031);v.setUint32(4,generation);out.set(new TextEncoder().encode(plan.roomId),8);out.set(new Uint8Array(raw),104);
  const signed=new Uint8Array(40+raw.byteLength);signed.set(out.subarray(0,40));signed.set(new Uint8Array(raw),40);
  out.set(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,signed)),40);
  return out.buffer;
 }
 return {publicKey,frame};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(10000);Connection.instances=[];vi.stubGlobal('RTCPeerConnection',Connection);vi.stubGlobal('crypto',webcrypto)});
afterEach(()=>{for(const relay of relays.splice(0))relay.close();vi.unstubAllGlobals();vi.useRealTimers()});
describe('relay resilience',()=>{
 it('does not let unrelated replans postpone a stalled source timeout',()=>{
  const {relay,cb}=setup(),link={id:'stalled',peer:'root',offerer:false,generation:7};
  relay.apply({...plan,role:'peer',links:[link]});
  for(const generation of [8,9]){
   vi.advanceTimersByTime(5000);relay.touch();
   relay.apply({...plan,generation,role:'peer',links:[link]});
  }
  vi.advanceTimersByTime(3000);
  const failures=cb.send.mock.calls.map(([m])=>m.browser).filter(m=>m.kind==='failed');
  expect(failures).toEqual([{kind:'failed',generation:9,failure:'media_timeout'}]);
  expect(cb.expired).not.toHaveBeenCalled();
  expect(Connection.instances).toHaveLength(1);
 });
 it('gives a replacement source its own setup deadline',()=>{
  const {relay,cb}=setup();
  relay.apply({...plan,role:'peer',links:[{id:'old',peer:'root-a',offerer:false}]});
  vi.advanceTimersByTime(6000);relay.touch();
  relay.apply({...plan,generation:8,role:'peer',links:[{id:'new',peer:'root-b',offerer:false}]});
  vi.advanceTimersByTime(6500);relay.touch();
  expect(cb.send.mock.calls.some(([m])=>m.browser.kind==='failed')).toBe(false);
  vi.advanceTimersByTime(6000);
  expect(cb.send.mock.calls.filter(([m])=>m.browser.kind==='failed')).toHaveLength(1);
  expect(cb.expired).not.toHaveBeenCalled();
 });
 it('retains a healthy channel during replans and accepts its in-flight original-generation negotiation',async()=>{
  const {relay}=setup(),link={id:'link',peer:'root',offerer:false,generation:7};
  relay.apply({...plan,role:'peer',links:[link]});const pc=Connection.instances[0];
  relay.apply({...plan,generation:8,role:'peer',links:[link]});
  expect(Connection.instances).toHaveLength(1);expect(pc.close).not.toHaveBeenCalled();
  await relay.signal({generation:7,link:'link',type:'offer',sdp:'offer'});
  expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
  await relay.signal({generation:6,link:'link',type:'offer',sdp:'too-old'});
  await relay.signal({generation:9,link:'link',type:'offer',sdp:'future'});
  expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
  relay.apply({...plan,generation:9,epoch:4,role:'peer',links:[{...link,generation:9}]});
  expect(pc.close).toHaveBeenCalledTimes(1);expect(Connection.instances).toHaveLength(2);
 });
 it('checks authorization on media arrival even when background timers have not fired',async()=>{
  const {relay,cb}=setup();relay.apply(plan);
  vi.setSystemTime(20000);relay.receive(new ArrayBuffer(128));relay.receive(new ArrayBuffer(128));
  expect(cb.expired).toHaveBeenCalledTimes(1);expect(cb.frame).not.toHaveBeenCalled();
  expect(cb.reset).toHaveBeenLastCalledWith(3);
 });
 it('reports background visibility without declaring a media failure and removes its listener',()=>{
  const doc=new EventTarget() as EventTarget&{visibilityState:string};doc.visibilityState='visible';
  vi.stubGlobal('document',doc);const {relay,cb}=setup();relay.apply(plan);
  doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));
  const reports=()=>cb.send.mock.calls.map(([m])=>m.browser).filter(m=>m.kind==='report');
  expect(reports().at(-1).report.visibility).toBe('hidden');
  expect(cb.send.mock.calls.some(([m])=>m.browser.kind==='failed')).toBe(false);
  vi.advanceTimersByTime(1000);cb.keyframe.mockClear();
  doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));
  expect(reports().at(-1).report.visibility).toBe('visible');expect(cb.keyframe).toHaveBeenCalledTimes(1);
  relay.close();const count=cb.send.mock.calls.length;doc.dispatchEvent(new Event('visibilitychange'));
  expect(cb.send).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);
 });
 it('isolates a congested downstream, resumes on a keyframe, and keeps healthy siblings flowing',async()=>{
  const {relay,cb}=setup(),{publicKey,frame}=await signing();
  relay.apply({...plan,publicKey,links:[{id:'slow',peer:'a',offerer:true},{id:'healthy',peer:'b',offerer:true}]});
  const [slow,healthy]=Connection.instances;slow.channel.bufferedAmount=2*1024*1024;
  relay.receive(await frame(1));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
  expect(slow.channel.send).not.toHaveBeenCalled();expect(healthy.channel.send).toHaveBeenCalled();
  slow.channel.bufferedAmount=0;slow.channel.onbufferedamountlow?.();
  relay.receive(await frame(2,false));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(2));
  expect(slow.channel.send).not.toHaveBeenCalled();
  relay.receive(await frame(3));await vi.waitFor(()=>expect(slow.channel.send).toHaveBeenCalled());
  expect(slow.channel.bufferedAmountLowThreshold).toBe(256*1024);
  slow.connectionState='failed';slow.onconnectionstatechange?.();
  relay.receive(await frame(4,false));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(4));
  expect(healthy.close).not.toHaveBeenCalled();
  expect(cb.send.mock.calls.some(([m])=>m.browser.kind==='failed')).toBe(false);
 });
 it('ignores queued old-generation frames rather than rejecting them or requesting keyframes repeatedly',async()=>{
  const {relay,cb}=setup(),{publicKey,frame}=await signing();relay.apply({...plan,publicKey});
  relay.apply({...plan,publicKey,generation:8});cb.keyframe.mockClear();
  for(let i=1;i<=3;i++)relay.receive(await frame(i));
  expect(cb.frame).not.toHaveBeenCalled();expect(cb.keyframe).not.toHaveBeenCalled();
  relay.receive(await frame(4,true,8));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
 });
 it('keeps leases and one healthy channel across two hours of simulated clock time',async()=>{
  // Logical-time coverage only, not two hours of video playback or CPU measurement.
  const {relay,cb}=setup(),link={id:'stable',peer:'leaf',offerer:true,generation:7};
  relay.apply({...plan,links:[link]});
  for(let elapsed=0;elapsed<7200000;elapsed+=3000){
   relay.touch();await vi.advanceTimersByTimeAsync(3000);
   if(elapsed%60000===0)relay.apply({...plan,generation:8+elapsed/60000,links:[link]});
  }
  expect(cb.expired).not.toHaveBeenCalled();expect(Connection.instances).toHaveLength(1);
  expect(Connection.instances[0].close).not.toHaveBeenCalled();
  expect(cb.send.mock.calls.filter(([m])=>m.browser.kind==='report').length).toBeGreaterThan(3000);
  // A late media callback after an actual lease lapse must still stop immediately.
  vi.setSystemTime(Date.now()+10000);relay.receive(new ArrayBuffer(128));
  expect(cb.expired).toHaveBeenCalledTimes(1);expect(Connection.instances[0].close).toHaveBeenCalledTimes(1);
  relay.touch();relay.receive(new ArrayBuffer(128));expect(cb.expired).toHaveBeenCalledTimes(1);
 });
});
