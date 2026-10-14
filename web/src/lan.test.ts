import {describe,it,expect,vi,afterEach} from 'vitest';
import {LANClient,NativeChunks,toBase64,fromBase64,type LANState} from './lan';
describe('LAN bounded native bridge',()=>{
 it('round trips maximum signed frame with chunks below 64 KiB JSON',()=>{const raw=new Uint8Array(1048676).fill(128);const chunks=new NativeChunks();let result:ArrayBuffer|null=null;const count=Math.ceil(raw.length/32768);for(let i=0;i<count;i++){const v={id:'generation-frame',index:i,count,data:toBase64(raw.subarray(i*32768,(i+1)*32768))};expect(JSON.stringify(v).length).toBeLessThan(65536);result=chunks.add(v,100)}expect(new Uint8Array(result!)).toEqual(raw)});
 it('rejects reordered, oversized, expired and malformed IPC',()=>{const v={id:'1',index:0,count:2,data:toBase64(new Uint8Array([1]))};const c=new NativeChunks();c.add(v,100);expect(()=>c.add({...v,index:1},1200)).toThrow();expect(()=>new NativeChunks().add({...v,count:100000})).toThrow();expect(()=>new NativeChunks().add({...v,index:1})).toThrow();expect(()=>new NativeChunks().add({...v,data:'!'})).toThrow();expect(()=>new NativeChunks().add({...v,data:'a'.repeat(100000)})).toThrow()});
 it('handles all binary byte values',()=>{const b=Uint8Array.from({length:256},(_,i)=>i);expect(fromBase64(toBase64(b))).toEqual(b)})
});

describe('LAN client authorization lifetime',()=>{
 afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
 function bridge(){
  vi.useFakeTimers();const sent:any[]=[];const controls:any[]=[];const video=vi.fn();const status=vi.fn();let listener:(e:any)=>void=()=>{};
  const w={addEventListener:(_:string,fn:any)=>{listener=fn},removeEventListener:()=>{listener=()=>{}},postMessage:(v:any)=>sent.push(v)};
  vi.stubGlobal('window',w);vi.stubGlobal('location',{origin:'https://meeting.example'});vi.stubGlobal('crypto',{randomUUID:()=> 'test-channel'});
  const client=new LANClient(v=>controls.push(v),video,status);
  const message=(m:any)=>listener({source:w,origin:'https://meeting.example',data:{source:'webzoom-lan-extension-v1',channel:'test-channel',message:m}});
  return {client,message,sent,controls,video,status};
 }
 it('requires helper protocol version and never revives a failed bridge',()=>{
  const b=bridge();b.message({type:'connected'});expect(b.sent.at(-1).message.protocol).toBe(1);
  b.message({type:'started',protocol:2});expect(b.controls.at(-1).lan.op).toBe('failed');
  b.message({type:'started',protocol:1});b.message({type:'heartbeat'});expect(b.controls.some(v=>v.lan?.op==='ready')).toBe(false);b.client.close();
 });
 it('discards old-generation and post-disconnect native video',()=>{
  const b=bridge();b.message({type:'started',protocol:1});
  const s:LANState={role:'receiver',node:'node',room:'room',generation:'current',epoch:1,leaseMs:4000};b.client.configure(s);
  const chunk={type:'chunk',id:'old-1',index:0,count:1,data:toBase64(new Uint8Array([1,2]))};
  b.message(chunk);expect(b.video).not.toHaveBeenCalled();b.message({...chunk,id:'current-1'});expect(b.video).toHaveBeenCalledTimes(1);
  b.message({type:'error'});b.message({...chunk,id:'current-2'});expect(b.video).toHaveBeenCalledTimes(1);b.client.close();
 });
});
