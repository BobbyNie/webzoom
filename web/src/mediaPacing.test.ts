import {afterEach,expect,it,vi} from 'vitest';
import {Publisher} from './media';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
function setup(){
 let output!:EncodedVideoChunkOutputCallback,onError!:VideoEncoderInit['error'];
 let now=0,deliver:((result:ReadableStreamReadResult<VideoFrame>)=>void)|undefined;
 const created:unknown[]=[],sources:VideoFrame[]=[];const encode=vi.fn(),configure=vi.fn(),cloneClose=vi.fn(),drawImage=vi.fn(),getContext=vi.fn(()=>({drawImage})),canvas=()=>({width:0,height:0,getContext});
 vi.spyOn(performance,'now').mockImplementation(()=>now);
 vi.stubGlobal('document',{createElement:()=>canvas()});vi.stubGlobal('WebSocket',{OPEN:1});
 vi.stubGlobal('VideoEncoder',class {constructor(init:VideoEncoderInit){output=init.output;onError=init.error}state='configured';encodeQueueSize=0;configure=configure;reset(){}encode=encode;close(){this.state='closed'}});
 vi.stubGlobal('VideoFrame',class {constructor(source:unknown,_init:VideoFrameInit){created.push(source)}close=cloneClose});
 vi.stubGlobal('MediaStreamTrackProcessor',class {readable={getReader:()=>({read:()=>new Promise<ReadableStreamReadResult<VideoFrame>>(resolve=>{deliver=resolve}),cancel:async()=>deliver?.({done:true,value:undefined})})}});
 const stop=vi.fn(),applyConstraints=vi.fn(async(_constraints:MediaTrackConstraints)=>{}),track={stop,applyConstraints},stream={getVideoTracks:()=>[track],getTracks:()=>[track]} as unknown as MediaStream;
 const socket={readyState:1,bufferedAmount:0,send:vi.fn()} as unknown as WebSocket,failed=vi.fn();
 const publisher=new Publisher(stream,1,socket,()=>0,canvas() as unknown as HTMLCanvasElement,vi.fn(),failed);
 async function frame(time:number,width=640,height=360){now=time;const source={displayWidth:width,displayHeight:height,close:vi.fn()} as unknown as VideoFrame;sources.push(source);deliver!({done:false,value:source});await Promise.resolve();await Promise.resolve()}
 return {publisher,encode,frame,failed,error:(error:DOMException)=>onError(error),created,sources,drawImage,getContext,configure,cloneClose,stop,applyConstraints,send:()=>output({type:'key',byteLength:1,timestamp:now*1000,copyTo:()=>{}} as unknown as EncodedVideoChunk,{})};
}
it('does not lose a third of a 30 fps input to harmless scheduler jitter',async()=>{
 const s=setup();await s.publisher.start();
 // Genuine 30 fps source delivered with sub-millisecond/one-millisecond jitter.
 for(let i=0;i<30;i++)await s.frame(Math.round(i*1000/30)+(i%3===1?1:i%3===2?-1:0));
 expect(s.encode).toHaveBeenCalledTimes(30);expect(s.failed).not.toHaveBeenCalled();s.publisher.stop();
});
it('caps a 60 fps input at the configured target without duplicating frames',async()=>{
 const s=setup();await s.publisher.start();for(let i=0;i<60;i++)await s.frame(i*1000/60);
 expect(s.encode).toHaveBeenCalledTimes(30);s.publisher.stop();
});
it('does not build a catch-up burst after a long scheduling pause',async()=>{
 const s=setup();await s.publisher.start();for(const time of [0,1000,1001,1002,1003])await s.frame(time);
 expect(s.encode).toHaveBeenCalledTimes(2);s.publisher.stop();
});
it('encodes the captured VideoFrame directly instead of copying it through a second canvas',async()=>{
 const s=setup();await s.publisher.start();await s.frame(0);
 expect(s.created[0]).toBe(s.sources[0]);expect(s.drawImage).toHaveBeenCalledTimes(1);
 expect(s.sources[0].close).toHaveBeenCalledTimes(1);s.publisher.stop();
});
it('releases both native frame handles and stops capture when encoding throws',async()=>{
 const s=setup(),error=new Error('native encoder failed');s.encode.mockImplementation(()=>{throw error});
 await s.publisher.start();await s.frame(0);
 expect(s.cloneClose).toHaveBeenCalledTimes(1);expect(s.sources[0].close).toHaveBeenCalledTimes(1);
 expect(s.stop).toHaveBeenCalledTimes(1);expect(s.failed).toHaveBeenCalledWith(error);
});
it('releases captured frames skipped by pacing without allocating an encoder frame',async()=>{
 const s=setup();await s.publisher.start();await s.frame(0);await s.frame(1);
 expect(s.created).toHaveLength(1);expect(s.sources[1].close).toHaveBeenCalledTimes(1);s.publisher.stop();
});
it('keeps the capture resource native while configuring bounded output and preview dimensions',async()=>{
 const s=setup();await s.publisher.start();await s.frame(0,3200,1800);
 expect(s.configure).toHaveBeenCalledWith(expect.objectContaining({width:1920,height:1080,framerate:30}));
 expect(s.created[0]).toBe(s.sources[0]);expect(s.drawImage).toHaveBeenCalledWith(s.sources[0],0,0,1920,1080);s.publisher.stop();
});
it('reduces the native capture budget as well as encoder dimensions when congested',async()=>{
 const s=setup();await s.publisher.start();s.publisher.congested();await s.frame(3100);s.publisher.congested();await s.frame(3200);
 expect(s.applyConstraints).toHaveBeenCalledWith({width:{ideal:1280,max:1280},height:{ideal:720,max:720},frameRate:{max:30}});
 await s.frame(4200);await s.frame(65000);expect(s.applyConstraints).toHaveBeenCalledTimes(1);
 expect(s.configure).toHaveBeenLastCalledWith(expect.objectContaining({bitrate:3_000_000,framerate:30}));s.publisher.stop();
});
it('serializes native capture reconfiguration and does not apply again after stopping',async()=>{
 const s=setup();let resolve!:()=>void;s.applyConstraints.mockImplementation(()=>new Promise<void>(r=>{resolve=r}));
 await s.publisher.start();s.publisher.congested();await s.frame(3100);s.publisher.congested();await s.frame(3200);
 await s.frame(6300);s.publisher.congested();await s.frame(6400);expect(s.applyConstraints).toHaveBeenCalledTimes(1);
 s.publisher.stop();resolve();await Promise.resolve();await Promise.resolve();expect(s.applyConstraints).toHaveBeenCalledTimes(1);expect(s.failed).not.toHaveBeenCalled();
});
it('keeps native capture running on a rejected constraint and retries at a bounded rate',async()=>{
 const s=setup();s.applyConstraints.mockRejectedValue(new DOMException('unsupported capture limit','OverconstrainedError'));
 await s.publisher.start();s.publisher.congested();await s.frame(3100);s.publisher.congested();await s.frame(3200);
 for(let t=3300;t<8000;t+=100)await s.frame(t);
 expect(s.applyConstraints).toHaveBeenCalledTimes(1);expect(s.failed).not.toHaveBeenCalled();expect(s.stop).not.toHaveBeenCalled();
 await s.frame(9000);expect(s.applyConstraints).toHaveBeenCalledTimes(2);s.publisher.stop();
});

it('restores the native capture budget only after sustained successful encoded sends',async()=>{
 const s=setup();await s.publisher.start();s.publisher.congested();await s.frame(3100);s.publisher.congested();await s.frame(3200);
 for(let i=0;i<=29*30;i++){await s.frame(4000+i*1000/30);s.send()}
 expect(s.applyConstraints).toHaveBeenCalledTimes(1);
 for(let i=0;i<=2*30;i++){await s.frame(33000+i*1000/30);s.send()}
 expect(s.applyConstraints).toHaveBeenLastCalledWith({width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{max:30}});
 expect(s.applyConstraints).toHaveBeenCalledTimes(2);s.publisher.stop();
});

it('declares a write-only opaque preview context from its first use',async()=>{
 const s=setup();await s.publisher.start();await s.frame(0);
 expect(s.getContext).toHaveBeenNthCalledWith(1,'2d',{alpha:false,willReadFrequently:false});
 s.publisher.stop();
});

it('ignores a delayed encoder error after the publisher has stopped',async()=>{
 const s=setup();await s.publisher.start();s.publisher.stop();s.error(new DOMException('old encoder','OperationError'));
 expect(s.failed).not.toHaveBeenCalled();expect(s.stop).toHaveBeenCalledTimes(1);
});
it('reports an active encoder failure once and releases capture before notifying the caller',async()=>{
 const s=setup(),error=new DOMException('encoder failed','OperationError');await s.publisher.start();
 s.failed.mockImplementation(()=>expect(s.stop).toHaveBeenCalledTimes(1));s.error(error);s.error(error);
 expect(s.failed).toHaveBeenCalledExactlyOnceWith(error);expect(s.stop).toHaveBeenCalledTimes(1);
});
