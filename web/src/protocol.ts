export const HEADER = 32;
export const MAX_FRAME = 1 << 20;
export interface WireFrame { epoch:number; sequence:number; timestamp:number; key:boolean; width:number; height:number; data:Uint8Array<ArrayBuffer> }
export function pack(f:WireFrame):ArrayBuffer {
 const out=new ArrayBuffer(HEADER+f.data.byteLength),v=new DataView(out);
 new Uint8Array(out).set([87,90,48,49]);v.setUint8(4,f.key?1:0);
 v.setUint32(8,f.epoch);v.setUint32(12,f.sequence);v.setBigUint64(16,BigInt(Math.round(f.timestamp)));
 v.setUint16(24,f.width);v.setUint16(26,f.height);new Uint8Array(out,HEADER).set(f.data);return out;
}
export function unpack(b:ArrayBuffer):WireFrame {
 if(b.byteLength<=HEADER||b.byteLength>MAX_FRAME)throw new Error('无效画面长度');
 const v=new DataView(b);
 if(v.getUint32(0)!==0x575a3031||v.getUint8(4)>1||v.getUint8(5)||v.getUint16(6)||v.getUint32(28))throw new Error('无效画面格式');
 const width=v.getUint16(24),height=v.getUint16(26);
 if(!width||!height||width>1920||height>1080)throw new Error('不支持的画面尺寸');
 return {epoch:v.getUint32(8),sequence:v.getUint32(12),timestamp:Number(v.getBigUint64(16)),key:!!v.getUint8(4),width,height,data:new Uint8Array(b,HEADER)};
}
export class FrameGate {
 private epoch=0; private sequence:number|null=null; private waiting=true;
 reset(epoch:number){this.epoch=epoch;this.sequence=null;this.waiting=true;}
 accept(f:WireFrame):boolean {
  if(f.epoch!==this.epoch)return false;
  if(this.sequence!==null&&f.sequence<=this.sequence)return false;
  if(this.sequence!==null&&f.sequence!==this.sequence+1)this.waiting=true;
  if(this.waiting&&!f.key)return false;
  this.waiting=false;this.sequence=f.sequence;return true;
 }
}
export function isStale(timestampMicros:number,serverNowMillis:number):boolean{return serverNowMillis-timestampMicros/1000>1000;}
