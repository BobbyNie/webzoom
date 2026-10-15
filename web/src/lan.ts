import {lanErrorText} from './lan-errors';
// Same-origin, provisioned extension bridge. No cookies/tokens are passed to the helper.
export interface LANState {role:string;node:string;room:string;group?:string;generation:string;key?:string;public?:string;epoch:number;leaseMs:number;message?:string;token?:string}
const MAX=1048576+100, CHUNK=32768;
export function toBase64(bytes:Uint8Array){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s)}
export function fromBase64(s:string){const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0))}
export class NativeChunks {
 private id='';private index=0;private count=0;private parts:Uint8Array[]=[];private size=0;private at=0;
 add(v:{id:string;index:number;count:number;data:string},now=Date.now()):ArrayBuffer|null {
  if(typeof v.id!=='string'||v.id.length>80||!Number.isInteger(v.index)||!Number.isInteger(v.count)||v.count<1||v.count>33||v.index<0||v.index>=v.count||typeof v.data!=='string'||v.data.length>43692)throw Error('Invalid native chunk');
  if(v.index===0){this.id=v.id;this.index=0;this.count=v.count;this.parts=[];this.size=0;this.at=now}
  if(this.id!==v.id||this.index!==v.index||this.count!==v.count||now-this.at>1000)throw Error('Stale native frame');const b=fromBase64(v.data);if(!b.length||b.length>CHUNK||this.size+b.length>MAX)throw Error('Native frame too large');this.parts.push(b);this.size+=b.length;this.index++;if(this.index!==this.count)return null;const out=new Uint8Array(this.size);let offset=0;for(const part of this.parts){out.set(part,offset);offset+=part.length}this.parts=[];return out.buffer;
 }
}
export class LANClient {
 private channel=crypto.randomUUID();private serial=0;private disposed=false;private started=false;private failed=false;private busy=false;private state:LANState|null=null;private inbound=new NativeChunks();private pending:{id:string;index:number;resolve:()=>void;reject:()=>void}|null=null;private setupTimer:ReturnType<typeof setTimeout>;private waitingForKey=true;private lastKeyRequest=0;private lastCongestion=0;
 constructor(private control:(v:unknown)=>void,private video:(b:ArrayBuffer)=>void,private status:(s:string)=>void){window.addEventListener('message',this.message);this.status('正在连接局域网扩展…');this.setupTimer=setTimeout(()=>this.fail('未连接到扩展或辅助程序。请安装获批的 LAN 客户端；不会自动改为直连。'),5000);this.post({type:'connect'});}
 private post(message:unknown){if(!this.disposed)window.postMessage({source:'webzoom-lan-page-v1',channel:this.channel,message},location.origin)}
 private requestKey(){if(Date.now()-this.lastKeyRequest>=500){this.lastKeyRequest=Date.now();this.control({type:'keyframe'})}}
 private recover(){this.waitingForKey=true;this.requestKey();if(Date.now()-this.lastCongestion>=1000){this.lastCongestion=Date.now();this.control({type:'feedback',level:1})}}
 private command(op:string,extra:object={}){this.control({type:'lan',lan:{op,...extra}})}
 private fail(text:string){if(this.failed||this.disposed)return;this.failed=true;this.status(text);this.command('failed');this.post({type:'stop'});this.pending?.reject();this.pending=null;clearTimeout(this.setupTimer)}
 configure(s:LANState){this.state=s;if(this.started&&!this.failed){this.post({type:'configure',state:s});this.status(s.message??({relay:'局域网中继：本机接收一份并广播',receiver:'局域网接收：不从服务器单独下载视频',publisher:'局域网模式：共享者上传一份画面',probing:'正在探测广播连通性',unavailable:'局域网不可用：出口预算不足'}[s.role]??s.role))}}
 probe(state:LANState){if(this.started&&!this.failed)this.post({type:'probe',state})}
 private message=(event:MessageEvent)=>{
  const v=event.data;if(event.source!==window||event.origin!==location.origin||v?.source!=='webzoom-lan-extension-v1'||v.channel!==this.channel||this.disposed||this.failed)return;const m=v.message;if(!m||typeof m.type!=='string')return;
  switch(m.type){
   case 'connected':this.post({type:'start',origin:location.origin,protocol:1});break;
   case 'started':if(m.protocol!==1){this.fail('LAN 客户端版本不兼容，请通过获批渠道更新。');break}clearTimeout(this.setupTimer);this.started=true;this.command('ready');break;
   case 'heartbeat':if(this.started&&!this.failed)this.command('heartbeat');break;
   case 'configured':if(m.generation===this.state?.generation){this.waitingForKey=true;this.command('configured',{generation:m.generation});this.requestKey()}break;
   case 'seen':if(typeof m.node==='string'&&typeof m.token==='string')this.command('seen',{node:m.node,token:m.token});break;
   case 'keyframe':this.recover();break;
   case 'error':this.fail('局域网客户端停止：'+lanErrorText(m.code));break;
   case 'ack':{const pending=this.pending;if(pending&&pending.id===m.id&&pending.index===m.index)pending.resolve();break;}
   case 'chunk':try{const b=this.inbound.add(m);this.post({type:'ack',id:m.id,index:m.index});if(b&&m.id.startsWith(this.state?.generation+'-'))this.video(b)}catch{this.recover()}break;
  }
 };
 // Stop-and-wait IPC: never accumulate an unbounded Chrome/JSON queue.
 async receive(b:ArrayBuffer){if(this.failed||!this.started||this.state?.role!=='relay'||b.byteLength>MAX||b.byteLength<133)return;const bytes=new Uint8Array(b);if(String.fromCharCode(...bytes.subarray(0,4))!=='WZS1')return;const key=bytes[40]===1;if(this.busy){this.recover();return}if(this.waitingForKey&&!key)return;if(key)this.waitingForKey=false;this.busy=true;const id=String(++this.serial),count=Math.ceil(bytes.length/CHUNK);
  try{for(let index=0;index<count;index++){if(this.disposed||this.failed)break;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;reject(Error('Native ACK timed out'))},1000);this.pending={id,index,resolve:()=>{clearTimeout(timer);this.pending=null;resolve()},reject:()=>{clearTimeout(timer);reject(Error('Native disconnected'))}};this.post({type:'chunk',id,index,count,data:toBase64(bytes.subarray(index*CHUNK,(index+1)*CHUNK))})})}}catch{this.fail('本地媒体桥超时，LAN 视频已暂停；不会自动回退直连。')}finally{this.busy=false}
 }
 close(){this.post({type:'stop'});this.disposed=true;clearTimeout(this.setupTimer);this.pending?.reject();this.pending=null;window.removeEventListener('message',this.message)}
}
