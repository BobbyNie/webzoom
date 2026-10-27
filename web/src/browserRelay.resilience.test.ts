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
  expect(failures).toEqual([{kind:'failed',generation:9,failure:'connection_timeout'}]);
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
 it('keeps playback and the sequence gate across unrelated membership generations',async()=>{
  const {relay,cb}=setup(),{publicKey,frame}=await signing();relay.apply({...plan,publicKey});
  relay.receive(await frame(1));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));cb.reset.mockClear();
  relay.apply({...plan,publicKey,generation:8});expect(cb.reset).not.toHaveBeenCalled();
  // A contiguous delta is still decodable; a room membership change is not a new stream.
  relay.receive(await frame(2,false,8));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(2));
  relay.apply({...plan,publicKey,generation:9,role:'waiting'});expect(cb.reset).toHaveBeenCalledTimes(1);
  relay.apply({...plan,publicKey,generation:10,epoch:4});expect(cb.reset).toHaveBeenLastCalledWith(4);
 });
 it('pauses media during a fresh WSS check, then resumes the same RTC link without expiring',async()=>{
  const base=setup(),cb={...base.cb,revalidate:vi.fn<()=>Promise<boolean>>()};base.relay.close();
  let confirm!:(ok:boolean)=>void;cb.revalidate.mockReturnValue(new Promise(resolve=>{confirm=resolve}));
  const relay=new BrowserRelay(cb);relays.push(relay);const {publicKey,frame}=await signing();
  relay.apply({...plan,publicKey,links:[{id:'healthy',peer:'child',offerer:true}]});
  relay.receive(await frame(1));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
  const pc=Connection.instances.at(-1)!;pc.channel.send.mockClear();
  vi.setSystemTime(25000);relay.receive(await frame(2));await vi.waitFor(()=>expect(cb.revalidate).toHaveBeenCalledTimes(1));
  // Queued controls may refresh normal lease bookkeeping but cannot prove liveness.
  relay.touch();relay.receive(await frame(3));expect(cb.frame).toHaveBeenCalledTimes(1);expect(pc.channel.send).not.toHaveBeenCalled();expect(pc.close).not.toHaveBeenCalled();
  confirm(true);await vi.waitFor(()=>expect(cb.status.mock.calls.at(-1)?.[0].reason).toBe('test'));
  relay.receive(await frame(4));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(2));
  expect(pc.channel.send).toHaveBeenCalled();expect(Connection.instances).toHaveLength(1);expect(cb.expired).not.toHaveBeenCalled();
 });
 it('still expires and closes media exactly once when the fresh WSS check fails',async()=>{
  const base=setup(),cb={...base.cb,revalidate:vi.fn(async()=>false)};base.relay.close();const relay=new BrowserRelay(cb);relays.push(relay);
  relay.apply({...plan,links:[{id:'healthy',peer:'child',offerer:true}]});vi.setSystemTime(25000);
  relay.receive(new ArrayBuffer(128));await vi.waitFor(()=>expect(cb.expired).toHaveBeenCalledTimes(1));
  relay.touch();relay.receive(new ArrayBuffer(128));expect(cb.expired).toHaveBeenCalledTimes(1);expect(Connection.instances.at(-1)!.close).toHaveBeenCalledTimes(1);
 });
 it('does not resume after disposal even if a pending fresh WSS check later succeeds',async()=>{
  const base=setup();base.relay.close();let confirm!:(ok:boolean)=>void;
  const cb={...base.cb,revalidate:()=>new Promise<boolean>(resolve=>{confirm=resolve})},relay=new BrowserRelay(cb);relays.push(relay);
  relay.apply(plan);vi.setSystemTime(25000);relay.receive(new ArrayBuffer(128));await Promise.resolve();relay.close();confirm(true);
  await Promise.resolve();await Promise.resolve();expect(cb.expired).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
 });

 it('waits for fresh authorization before processing and answering an in-flight offer',async()=>{
  const base=setup();base.relay.close();let confirm!:(ok:boolean)=>void;
  const cb={...base.cb,revalidate:vi.fn(()=>new Promise<boolean>(resolve=>{confirm=resolve}))},relay=new BrowserRelay(cb);relays.push(relay);
  relay.apply({...plan,role:'peer',links:[{id:'offer',peer:'root',offerer:false}]});const pc=Connection.instances.at(-1)!;
  vi.setSystemTime(25000);const negotiation=relay.signal({generation:7,link:'offer',type:'offer',sdp:'offer'});
  await Promise.resolve();expect(cb.revalidate).toHaveBeenCalledTimes(1);expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  relay.touch();await Promise.resolve();expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  confirm(true);await negotiation;expect(pc.setRemoteDescription).toHaveBeenCalledWith({type:'offer',sdp:'offer'});
  expect(cb.send).toHaveBeenCalledWith({type:'browser',browser:{kind:'signal',signal:{generation:7,link:'offer',type:'answer',sdp:'answer'}}});
  expect(cb.expired).not.toHaveBeenCalled();expect(pc.close).not.toHaveBeenCalled();
 });

});

 it('resets sharing counters only for a new stream, not membership or source changes',async()=>{
  const {relay,cb}=setup(),signed=await signing();relay.apply({...plan,publicKey:signed.publicKey});
  const first=await signed.frame(1);relay.receive(first);await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
  vi.advanceTimersByTime(500);expect(cb.status.mock.calls.at(-1)![0].sharing.centerBytes).toBe(first.byteLength);
  relay.apply({...plan,generation:8,role:'direct',publicKey:signed.publicKey});
  expect(cb.status.mock.calls.at(-1)![0].sharing.centerBytes).toBe(first.byteLength);
  relay.apply({...plan,generation:9,epoch:4,publicKey:signed.publicKey});
  expect(cb.status.mock.calls.at(-1)![0].sharing.centerBytes).toBe(0);
  expect(cb.status.mock.calls.at(-1)![0].centerBytes).toBe(first.byteLength);
 });
 it('keeps accepting server frames while a backup peer probe fails',async()=>{
  const {relay,cb}=setup(),signed=await signing();
  relay.apply({...plan,role:'peer',serverBackup:true,links:[{id:'probe',peer:'root',offerer:false}],publicKey:signed.publicKey});
  const pc=Connection.instances[0],channel=new Channel();pc.ondatachannel!({channel});
  relay.receive(await signed.frame(1));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
  channel.onclose!();expect(cb.send.mock.calls.at(-1)![0].browser).toMatchObject({kind:'failed',failure:'channel_closed'});
  relay.receive(await signed.frame(2));await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(2));
  expect(cb.reset).toHaveBeenCalledTimes(1);expect(cb.expired).not.toHaveBeenCalled();
 });
 it('distinguishes an opened channel without media from a previously working peer that stalls',async()=>{
  const {relay,cb}=setup(),signed=await signing();
  relay.apply({...plan,role:'peer',links:[{id:'peer',peer:'root',offerer:false}],publicKey:signed.publicKey});
  Connection.instances[0].ondatachannel!({channel:new Channel()});
  for(let n=0;n<3;n++){vi.advanceTimersByTime(4500);relay.touch()}
  expect(cb.send.mock.calls.find(([m])=>m.browser.kind==='failed')![0].browser.failure).toBe('peer_no_media');
  relay.apply({...plan,generation:8,role:'peer',links:[{id:'new-peer',peer:'other',offerer:false}],publicKey:signed.publicKey});
  const channel=new Channel();Connection.instances[1].ondatachannel!({channel});
  const {fragment}=await import('./browserRelayProtocol');
  for(const data of fragment(await signed.frame(1,true,8)))channel.onmessage!({data});
  await vi.waitFor(()=>expect(cb.frame).toHaveBeenCalledTimes(1));
  for(let n=0;n<3;n++){vi.advanceTimersByTime(4500);relay.touch()}
  expect(cb.send.mock.calls.filter(([m])=>m.browser.kind==='failed').at(-1)![0].browser.failure).toBe('peer_stalled');
 });
