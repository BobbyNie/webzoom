import {afterEach,expect,it,vi} from 'vitest';
import {Viewer} from './media';
import {pack} from './protocol';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()});
function setup(){
 const output:{callback?:VideoFrameOutputCallback}={};
 vi.stubGlobal('VideoDecoder',class {
  state='configured';decodeQueueSize=0;
  constructor(init:VideoDecoderInit){output.callback=init.output}
  configure(){}decode(){}close(){this.state='closed'}
 });
 vi.stubGlobal('EncodedVideoChunk',class {constructor(_init:EncodedVideoChunkInit){}});
 let width=0,height=0;const sizes={width:vi.fn(),height:vi.fn()},draw=vi.fn();
 const getContext=vi.fn(()=>({drawImage:draw,clearRect:vi.fn()}));
 const canvas={get width(){return width},set width(value:number){width=value;sizes.width(value)},get height(){return height},set height(value:number){height=value;sizes.height(value)},getContext};
 const viewer=new Viewer(canvas as unknown as HTMLCanvasElement,()=>0,vi.fn(),vi.fn(),vi.fn());viewer.reset(1);
 let sequence=0;
 function receive(w=640,h=360){
  const timestamp=Date.now()*1000;
  viewer.receive(pack({epoch:1,sequence:++sequence,timestamp,key:true,width:w,height:h,data:new Uint8Array([1])}));
  return timestamp;
 }
 function render(w=640,h=360){
  const timestamp=receive(w,h);
  const frame={displayWidth:w,displayHeight:h,timestamp,close:vi.fn()};
  output.callback!(frame as unknown as VideoFrame);return frame;
 }
 return {viewer,receive,render,sizes,draw,getContext};
}
it('reuses the viewer canvas backing store while resolution is unchanged',()=>{
 const {viewer,render,sizes,draw}=setup();
 const frames=[render(),render(),render()];
 expect(sizes.width).toHaveBeenCalledTimes(1);expect(sizes.height).toHaveBeenCalledTimes(1);
 expect(draw).toHaveBeenCalledTimes(3);for(const frame of frames)expect(frame.close).toHaveBeenCalledTimes(1);
 render(320,180);expect(sizes.width).toHaveBeenCalledTimes(2);expect(sizes.height).toHaveBeenCalledTimes(2);
 viewer.close();
});
it('releases the decoded frame even if canvas drawing fails',()=>{
 const {viewer,render,draw}=setup();draw.mockImplementationOnce(()=>{throw Error('drawing failed')});
 // Capture the frame passed to draw, even when rendering throws.
 expect(()=>render()).toThrow('drawing failed');
 expect((draw.mock.calls[0][0] as VideoFrame).close).toHaveBeenCalledTimes(1);viewer.close();
});

it('only successfully rendered frames refresh the playback watchdog',()=>{
 let now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);
 const {viewer,receive,render}=setup();expect(viewer.lastRenderedAt).toBe(100);
 now=1000;
 receive();
 expect(viewer.lastRenderedAt).toBe(100);
 now=2000;render();expect(viewer.lastRenderedAt).toBe(2000);viewer.close();
});
it('same-epoch recovery cannot repeatedly extend the first-frame grace period',()=>{
 let now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);
 const {viewer,render}=setup();now=200;render();
 now=1000;viewer.reset(1);expect(viewer.lastRenderedAt).toBe(200);
 now=2000;viewer.receive(new ArrayBuffer(1));expect(viewer.lastRenderedAt).toBe(200);
 now=5000;viewer.reset(2);expect(viewer.lastRenderedAt).toBe(5000);
 now=6000;viewer.reset(2);expect(viewer.lastRenderedAt).toBe(5000);viewer.close();
});
it('a failed canvas draw never counts as playback progress',()=>{
 let now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);
 const {viewer,render,draw}=setup();now=4000;
 draw.mockImplementationOnce(()=>{throw Error('drawing failed')});
 expect(()=>render()).toThrow('drawing failed');expect(viewer.lastRenderedAt).toBe(100);viewer.close();
});

it('does not let initial clear select an implicit transparent/readback-prone context',()=>{
 const {viewer,render,getContext}=setup();
 expect(getContext).toHaveBeenNthCalledWith(1,'2d',{alpha:false,willReadFrequently:false});
 render();viewer.clear();viewer.reset(2);viewer.close();
 for(const args of getContext.mock.calls)expect(args).toEqual(['2d',{alpha:false,willReadFrequently:false}]);
});
