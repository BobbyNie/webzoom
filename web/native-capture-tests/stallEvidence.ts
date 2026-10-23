import type {Page,CDPSession} from '@playwright/test';
// Opt-in diagnostic observers: bounded counters, no media replacement, no extra
// capture consumer, no policy changes and no retained frames/canvas readbacks.
interface StallCounters {timerTicks:number;lastTimerAt:number;maximumTimerGapMs:number;longTasks:number;longTaskMs:number;maximumLongTaskMs:number;draws:number;drawMs:number;maximumDrawMs:number;readbacks:number;encodes:number;encodeMs:number;maximumEncodeMs:number}
declare global {interface Window {nativeStall?:StallCounters}}
export interface StallProbe {page:Page;label:string;session:CDPSession;warnings:string[]}
export async function stallProbe(page:Page,label:string):Promise<StallProbe>{
 const warnings:string[]=[];
 page.on('console',message=>{if(['warning','error'].includes(message.type())&&warnings.length<40)warnings.push(message.text().slice(0,1000))});
 await page.addInitScript(()=>{
  const c:StallCounters=window.nativeStall={timerTicks:0,lastTimerAt:performance.now(),maximumTimerGapMs:0,longTasks:0,longTaskMs:0,maximumLongTaskMs:0,draws:0,drawMs:0,maximumDrawMs:0,readbacks:0,encodes:0,encodeMs:0,maximumEncodeMs:0};
  setInterval(()=>{const now=performance.now();c.timerTicks++;c.maximumTimerGapMs=Math.max(c.maximumTimerGapMs,now-c.lastTimerAt);c.lastTimerAt=now},100);
  if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{for(const task of list.getEntries()){c.longTasks++;c.longTaskMs+=task.duration;c.maximumLongTaskMs=Math.max(c.maximumLongTaskMs,task.duration)}}).observe({entryTypes:['longtask']});
  const draw=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(this:CanvasRenderingContext2D,...args:unknown[]){const began=performance.now();try{return Reflect.apply(draw,this,args)}finally{const duration=performance.now()-began;c.draws++;c.drawMs+=duration;c.maximumDrawMs=Math.max(c.maximumDrawMs,duration)}};
  const readback=CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData=function(...args:Parameters<CanvasRenderingContext2D['getImageData']>){c.readbacks++;return readback.apply(this,args)};
  const encode=VideoEncoder.prototype.encode;
  VideoEncoder.prototype.encode=function(...args:Parameters<VideoEncoder['encode']>){const began=performance.now();try{return encode.apply(this,args)}finally{const duration=performance.now()-began;c.encodes++;c.encodeMs+=duration;c.maximumEncodeMs=Math.max(c.maximumEncodeMs,duration)}};
 });
 const session=await page.context().newCDPSession(page);await session.send('Performance.enable');
 return {page,label,session,warnings};
}
export async function stallSnapshot(probes:StallProbe[]){
 return Promise.all(probes.filter(probe=>!probe.page.isClosed()).map(async probe=>{
  const [state,metrics]=await Promise.all([
   probe.page.evaluate(()=>({at:Date.now(),performanceAt:performance.now(),visibility:document.visibilityState,focused:document.hasFocus(),wasDiscarded:(document as Document&{wasDiscarded?:boolean}).wasDiscarded,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},counters:window.nativeStall})),
   probe.session.send('Performance.getMetrics'),
  ]);
  return {label:probe.label,state,metrics:Object.fromEntries(metrics.metrics.filter(m=>['Timestamp','TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','ThreadTime','ProcessTime','JSHeapUsedSize','Documents','Nodes','Frames'].includes(m.name)).map(m=>[m.name,m.value])),warnings:[...probe.warnings]};
 }));
}
