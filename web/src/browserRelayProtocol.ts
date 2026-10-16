import {MAX_FRAME,unpack,isStale} from './protocol';
export const ENVELOPE_HEADER=104,MAX_ENVELOPE=MAX_FRAME+ENVELOPE_HEADER,CHUNK_HEADER=16,MAX_MESSAGE=16*1024;
export interface BrowserLink {id:string;peer:string;offerer:boolean}
export interface BrowserPlan {roomId:string;generation:number;epoch:number;active:boolean;role:'off'|'publisher'|'root'|'peer'|'direct'|'waiting';reason:string;links:BrowserLink[];publicKey?:JsonWebKey}
export interface BrowserSignal {generation:number;link:string;type:'offer'|'answer';sdp:string}
export function fragment(buffer:ArrayBuffer,maxMessage=MAX_MESSAGE):ArrayBuffer[]{
 if(buffer.byteLength<ENVELOPE_HEADER+32||buffer.byteLength>MAX_ENVELOPE)throw Error('frame size');
 const size=Math.min(MAX_MESSAGE,Math.floor(maxMessage))-CHUNK_HEADER;if(size<1||!Number.isFinite(size))throw Error('message size');
 const id=new DataView(buffer).getUint32(ENVELOPE_HEADER+12),parts:ArrayBuffer[]=[];
 for(let offset=0;offset<buffer.byteLength;offset+=size){
  const length=Math.min(size,buffer.byteLength-offset),part=new ArrayBuffer(CHUNK_HEADER+length),v=new DataView(part);
  v.setUint32(0,0x575a4331);v.setUint32(4,id);v.setUint32(8,buffer.byteLength);v.setUint32(12,offset);
  new Uint8Array(part,CHUNK_HEADER).set(new Uint8Array(buffer,offset,length));parts.push(part);
 }return parts;
}
// Ordered reliable channel: one bounded allocation, never an unbounded ID map.
export class Reassembler {
 private current:{id:number;next:number;until:number;buffer:ArrayBuffer}|null=null;
 clear(){this.current=null}
 receive(part:ArrayBuffer,now=performance.now()):ArrayBuffer|null{
  if(part.byteLength<=CHUNK_HEADER||part.byteLength>MAX_MESSAGE)throw Error('chunk size');
  const v=new DataView(part),id=v.getUint32(4),total=v.getUint32(8),offset=v.getUint32(12),length=part.byteLength-CHUNK_HEADER;
  if(v.getUint32(0)!==0x575a4331||total<=ENVELOPE_HEADER||total>MAX_ENVELOPE||offset+length>total)throw Error('chunk header');
  if(offset===0)this.current={id,next:0,until:now+1000,buffer:new ArrayBuffer(total)};
  const c=this.current;
  if(!c||c.id!==id||c.buffer.byteLength!==total||c.next!==offset||now>c.until){this.clear();return null}
  new Uint8Array(c.buffer,offset,length).set(new Uint8Array(part,CHUNK_HEADER));c.next+=length;
  if(c.next===total){this.current=null;return c.buffer}return null;
 }
}
export async function verifyEnvelope(buffer:ArrayBuffer,plan:BrowserPlan,key:CryptoKey,now:number):Promise<ArrayBuffer>{
 if(buffer.byteLength<=ENVELOPE_HEADER||buffer.byteLength>MAX_ENVELOPE)throw Error('envelope size');
 const v=new DataView(buffer);
 if(v.getUint32(0)!==0x575a5031||v.getUint32(4)!==plan.generation||new TextDecoder().decode(new Uint8Array(buffer,8,32))!==plan.roomId)throw Error('envelope binding');
 const raw=buffer.slice(ENVELOPE_HEADER),f=unpack(raw);
 if(f.epoch!==plan.epoch||isStale(f.timestamp,now)||f.timestamp/1000>now+5000)throw Error('expired frame');
 const signed=new Uint8Array(40+raw.byteLength);signed.set(new Uint8Array(buffer,0,40));signed.set(new Uint8Array(raw),40);
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,buffer.slice(40,104),signed))throw Error('frame signature');
 return raw;
}
export interface BrowserReport {generation:number;centerBytes:number;peerBytes:number;sentBytes:number;verifiedFrames:number;rejected:number;planFrames:number;mediaAgeMs:number}
export interface BrowserParticipant {user:{id:string;name:string};role:BrowserPlan['role'];reason:string;parent:string;children:number;report?:BrowserReport;reportedAt:number}
export interface BrowserOverview {generation:number;active:boolean;generatedAt:number;maxViewers:number;maxFanout:number;participants:BrowserParticipant[];receivedAt?:number}
