import {FrameGate,isStale,pack,unpack,type WireFrame,MAX_FRAME} from './protocol';
import {Adaptation,profiles} from './quality';

export const screenConstraints:DisplayMediaStreamOptions={audio:false,video:{width:{max:1920},height:{max:1080},frameRate:{max:30}},systemAudio:'exclude'};
export async function captureScreen(devices:MediaDevices=navigator.mediaDevices):Promise<MediaStream>{
 const stream=await devices.getDisplayMedia(screenConstraints);
 if(stream.getAudioTracks().length){stream.getTracks().forEach(t=>t.stop());throw new Error('浏览器返回了音频轨道。共享已停止。');}
 return stream;
}
export async function checkCapabilities():Promise<void>{
 if(!window.isSecureContext)throw new Error('需要通过可信 HTTPS 地址访问。');
 if(!/Chrome\//.test(navigator.userAgent)||/Android|Mobile/.test(navigator.userAgent))throw new Error('请使用桌面版 Chrome 或 Edge。');
 if(!navigator.mediaDevices?.getDisplayMedia||!('VideoEncoder' in window)||!('VideoDecoder' in window)||!('MediaStreamTrackProcessor' in window))throw new Error('此浏览器不支持屏幕采集或 WebCodecs。');
 const [enc,dec]=await Promise.all([VideoEncoder.isConfigSupported({codec:'vp8',width:1920,height:1080,bitrate:6_000_000,framerate:30,latencyMode:'realtime'}),VideoDecoder.isConfigSupported({codec:'vp8'})]);
 if(!enc.supported||!dec.supported)throw new Error('此浏览器不能使用 VP8 编码或解码。');
}
export interface MediaStats {width:number;height:number;fps:number;level:number;latency?:number;frames:number}
export class Publisher {
 private encoder:VideoEncoder;private reader:ReadableStreamDefaultReader<VideoFrame>|null=null;private canvas=document.createElement('canvas');
 private adaptation=new Adaptation();private seq=0;private epoch:number;private running=true;private lastFrame=-Infinity;private lastKey=-Infinity;private forceKey=true;private needKey=true;private configured='';private frameCount=0;private lastStats=performance.now();private intervalFrames=0;
 constructor(private stream:MediaStream,epoch:number,private socket:WebSocket,private serverOffset:()=>number,private preview:HTMLCanvasElement,private stats:(s:MediaStats)=>void,private failed:(e:Error)=>void){
  this.epoch=epoch;
  this.encoder=new VideoEncoder({output:(chunk)=>this.output(chunk),error:(e)=>this.failed(e)});
 }
 async start(){try{
  const processor=new MediaStreamTrackProcessor({track:this.stream.getVideoTracks()[0],maxBufferSize:1});
  this.reader=processor.readable.getReader();void this.pump();
 }catch(e){this.stop();throw e;}}
 private async pump(){try{
  while(this.running&&this.reader){const {value,done}=await this.reader.read();if(done)break;try{this.tick(performance.now(),value)}finally{value.close()}}
  if(this.running){this.stop();this.failed(new Error('屏幕采集已结束。'))}
 }catch(e){if(this.running){this.stop();this.failed(e instanceof Error?e:new Error(String(e)))}}}
 keyframe(){this.forceKey=true;}
 congested(){this.adaptation.congested(performance.now());}
 private output(chunk:EncodedVideoChunk){
  if(!this.running||this.socket.readyState!==WebSocket.OPEN)return;
  if(this.socket.bufferedAmount>512*1024||chunk.byteLength+32>MAX_FRAME){this.forceKey=true;this.needKey=true;this.congested();return;}
  if(this.needKey&&chunk.type!=='key'){this.forceKey=true;return;}
  this.needKey=false;const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
  this.socket.send(pack({epoch:this.epoch,sequence:++this.seq,timestamp:chunk.timestamp,key:chunk.type==='key',width:this.canvas.width,height:this.canvas.height,data}));
 }
 private tick(now:number,source:VideoFrame){
  if(!this.running)return;
  this.adaptation.stable(now);const p=profiles[this.adaptation.level];
  if(now-this.lastFrame<1000/p.fps-1||!source.displayWidth||!source.displayHeight)return;
  this.lastFrame=now;
  if(this.socket.bufferedAmount>512*1024){this.congested();this.forceKey=true;this.needKey=true;return;}
  if(this.encoder.encodeQueueSize>=2){this.congested();return;}
  try{
   const ratio=Math.min(p.width/source.displayWidth,p.height/source.displayHeight,1);
   const width=Math.max(2,Math.floor(source.displayWidth*ratio/2)*2),height=Math.max(2,Math.floor(source.displayHeight*ratio/2)*2);
   const config=`${width}:${height}:${p.bitrate}:${p.fps}`;
   if(config!==this.configured){this.encoder.reset();this.canvas.width=width;this.canvas.height=height;this.preview.width=width;this.preview.height=height;this.encoder.configure({codec:'vp8',width,height,bitrate:p.bitrate,framerate:p.fps,latencyMode:'realtime'});this.configured=config;this.forceKey=true;this.needKey=true;}
   this.canvas.getContext('2d',{alpha:false})!.drawImage(source,0,0,width,height);
   this.preview.getContext('2d',{alpha:false})!.drawImage(this.canvas,0,0);
   const frame=new VideoFrame(this.canvas,{timestamp:Math.round((Date.now()+this.serverOffset())*1000)});
   const key=this.forceKey||now-this.lastKey>=1000;
   try{this.encoder.encode(frame,{keyFrame:key});}finally{frame.close();}
   if(key){this.forceKey=false;this.lastKey=now;}
   this.frameCount++;this.intervalFrames++;
   if(now-this.lastStats>=1000){this.stats({width,height,fps:Math.round(this.intervalFrames*1000/(now-this.lastStats)),level:this.adaptation.level,frames:this.frameCount});this.intervalFrames=0;this.lastStats=now;}
  }catch(e){this.stop();this.failed(e instanceof Error?e:new Error(String(e)));}
 }
 stop(){if(!this.running)return;this.running=false;void this.reader?.cancel().catch(()=>{});this.reader=null;this.stream.getTracks().forEach(t=>t.stop());if(this.encoder.state!=='closed')this.encoder.close();}
}
export class Viewer {
 private gate=new FrameGate();private decoder:VideoDecoder|null=null;private dimensions='';private epoch=0;private frameCount=0;private intervalFrames=0;private lastStats=performance.now();private level=0;
 constructor(private canvas:HTMLCanvasElement,private offset:()=>number,private keyframe:()=>void,private congestion:()=>void,private stats:(s:MediaStats)=>void){}
 reset(epoch:number){this.epoch=epoch;this.gate.reset(epoch);if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();this.decoder=null;this.dimensions='';this.clear();}
 clear(){this.canvas.getContext('2d')?.clearRect(0,0,this.canvas.width,this.canvas.height);}
 setLevel(level:number){this.level=level;}
 receive(buffer:ArrayBuffer){
  let f:WireFrame;try{f=unpack(buffer);}catch{this.recover();return;}
  if(f.epoch!==this.epoch){this.keyframe();return;}
  if(isStale(f.timestamp,Date.now()+this.offset())){this.congestion();this.recover();return;}
  if(!this.gate.accept(f)){this.keyframe();return;}
  if(this.decoder&&this.decoder.decodeQueueSize>=3){this.congestion();this.recover();return;}
  try{
   const dims=`${f.width}:${f.height}`;
   if(dims!==this.dimensions||!this.decoder||this.decoder.state==='closed'){
    if(!f.key){this.recover();return;}
    if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();
    this.decoder=new VideoDecoder({output:(frame)=>this.render(frame),error:()=>this.recover()});
    this.decoder.configure({codec:'vp8',codedWidth:f.width,codedHeight:f.height,optimizeForLatency:true});this.dimensions=dims;
   }
   this.decoder.decode(new EncodedVideoChunk({type:f.key?'key':'delta',timestamp:f.timestamp,data:f.data}));
  }catch{this.recover();}
 }
 private render(frame:VideoFrame){try{
  const now=performance.now();this.canvas.width=frame.displayWidth;this.canvas.height=frame.displayHeight;this.canvas.getContext('2d',{alpha:false})!.drawImage(frame,0,0);
  this.frameCount++;this.intervalFrames++;const latency=Math.max(0,Date.now()+this.offset()-frame.timestamp/1000);
  if(latency>800)this.congestion();
  if(now-this.lastStats>=1000){this.stats({width:frame.displayWidth,height:frame.displayHeight,fps:Math.round(this.intervalFrames*1000/(now-this.lastStats)),latency,level:this.level,frames:this.frameCount});this.intervalFrames=0;this.lastStats=now;}
 }finally{frame.close();}}
 private recover(){this.reset(this.epoch);this.keyframe();}
 close(){this.reset(0);}
}
