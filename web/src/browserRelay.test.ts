import {describe,it,expect,vi,afterEach} from 'vitest';
import {webcrypto} from 'node:crypto';
import {pack} from './protocol';
import {fragment,Reassembler,verifyEnvelope,MAX_ENVELOPE,type BrowserPlan} from './browserRelayProtocol';
import {BrowserRelay} from './browserRelay';
const plan:BrowserPlan={roomId:'a'.repeat(32),generation:7,epoch:3,active:true,role:'root',reason:'test',links:[]};
function raw(size=20000){return pack({epoch:3,sequence:1,timestamp:1000000,key:true,width:640,height:360,data:new Uint8Array(size)})}
async function envelope(){
 vi.stubGlobal('crypto',webcrypto);
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const data=raw(),out=new Uint8Array(104+data.byteLength),v=new DataView(out.buffer);v.setUint32(0,0x575a5031);v.setUint32(4,7);out.set(new TextEncoder().encode(plan.roomId),8);out.set(new Uint8Array(data),104);
 const signed=new Uint8Array(40+data.byteLength);signed.set(out.subarray(0,40));signed.set(new Uint8Array(data),40);
 out.set(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keys.privateKey,signed)),40);
 return {buffer:out.buffer,key:keys.publicKey};
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
describe('browser media protocol',()=>{
 it('fragments to negotiated sizes and reconstructs without changing bytes',async()=>{
  const {buffer}=await envelope();const parts=fragment(buffer,1200),r=new Reassembler();expect(parts.length).toBeGreaterThan(1);let result:ArrayBuffer|null=null;
  for(const p of parts){expect(p.byteLength).toBeLessThanOrEqual(1200);result=r.receive(p,10)}expect(result).toEqual(buffer);
 });
 it('bounds memory, rejects malformed lengths, expires partial frames',async()=>{
  const {buffer}=await envelope(),parts=fragment(buffer,1024),r=new Reassembler();r.receive(parts[0],0);expect(r.receive(parts[1],1001)).toBeNull();expect(r.receive(parts[1],1002)).toBeNull();
  const bad=parts[0].slice(0);new DataView(bad).setUint32(8,MAX_ENVELOPE+1);expect(()=>r.receive(bad)).toThrow();expect(()=>fragment(buffer,16)).toThrow();expect(()=>r.receive(new ArrayBuffer(2))).toThrow();
 });
 it('validates server signature, room, epoch, generation and freshness',async()=>{
  const {buffer,key}=await envelope();await expect(verifyEnvelope(buffer,plan,key,1000)).resolves.toEqual(raw());
  for(const other of [{...plan,roomId:'b'.repeat(32)},{...plan,generation:8},{...plan,epoch:4}])await expect(verifyEnvelope(buffer,other,key,1000)).rejects.toThrow();
  await expect(verifyEnvelope(buffer,plan,key,2001)).rejects.toThrow();const bad=buffer.slice(0);new Uint8Array(bad)[bad.byteLength-1]^=1;await expect(verifyEnvelope(bad,plan,key,1000)).rejects.toThrow('signature');
 });
});
describe('browser relay lifecycle',()=>{
 it('does not create RTC in disabled mode and expires active control once',()=>{
  vi.useFakeTimers();const rtc=vi.fn();vi.stubGlobal('RTCPeerConnection',rtc);
  const callbacks={send:vi.fn(),frame:vi.fn(),reset:vi.fn(),keyframe:vi.fn(),status:vi.fn(),now:()=>1000,expired:vi.fn()},relay=new BrowserRelay(callbacks);
  relay.apply({...plan,active:false,role:'off'});vi.advanceTimersByTime(10000);expect(rtc).not.toHaveBeenCalled();expect(callbacks.expired).not.toHaveBeenCalled();
  relay.touch();relay.apply({...plan,generation:8});vi.advanceTimersByTime(10000);expect(callbacks.expired).toHaveBeenCalledTimes(1);relay.close();expect(vi.getTimerCount()).toBe(0);
 });
 it('requests only one budgeted fallback when RTC creation is blocked',()=>{
  vi.useFakeTimers();vi.stubGlobal('RTCPeerConnection',class{constructor(){throw Error('blocked')}});
  const send=vi.fn(),relay=new BrowserRelay({send,frame:vi.fn(),reset:vi.fn(),keyframe:vi.fn(),status:vi.fn(),now:()=>1000,expired:vi.fn()});
  relay.apply({...plan,role:'peer',links:[{id:'link',peer:'root',offerer:false}]});vi.advanceTimersByTime(15000);
  expect(send.mock.calls.filter(([message])=>message.browser.kind==='failed')).toHaveLength(1);relay.close();
 });
});

describe('receiver report lifecycle',()=>{
 it('reports local counters with generation, never reports disabled or expired sessions, and clears timers',()=>{
  vi.useFakeTimers();vi.setSystemTime(10000);const send=vi.fn();
  const relay=new BrowserRelay({send,frame:vi.fn(),reset:vi.fn(),keyframe:vi.fn(),status:vi.fn(),now:()=>1000,expired:vi.fn()});
  relay.apply({...plan,active:false,role:'off'});vi.advanceTimersByTime(2000);expect(send).not.toHaveBeenCalled();
  relay.touch();relay.apply({...plan,generation:8});vi.advanceTimersByTime(2500);
  const reports=()=>send.mock.calls.map(([m])=>m.browser).filter(m=>m.kind==='report');
  expect(reports().length).toBeGreaterThan(0);expect(reports()[0].report).toMatchObject({generation:8,planFrames:0,peerBytes:0});
  vi.advanceTimersByTime(10000);const count=reports().length;vi.advanceTimersByTime(4000);expect(reports()).toHaveLength(count);
  relay.close();expect(vi.getTimerCount()).toBe(0);
 });
});
