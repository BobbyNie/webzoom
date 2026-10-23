import {expect,type Browser,type Page} from '@playwright/test';
import {snapshot} from '../relay-tests/relayHarness';
export function boundedSeconds(name:string,fallback:number,min:number,max:number){
 const value=process.env[name]===undefined?fallback:Number(process.env[name]);
 if(!Number.isInteger(value)||value<min||value>max)throw Error(`${name} must be an integer in ${min}..${max}`);
 return value;
}
export async function sampler(browser:Browser,pages:Page[]){
 const sessions=await Promise.all(pages.map(async p=>{const s=await p.context().newCDPSession(p);await s.send('Performance.enable');return s}));
 const browserSession=await browser.newBrowserCDPSession();
 return {
  async take(){
   const startedAt=Date.now();
   const [viewers,metrics,processes,response]=await Promise.all([
    Promise.all(pages.map(snapshot)),
    Promise.all(sessions.map(async s=>{const {metrics}=await s.send('Performance.getMetrics');return Object.fromEntries(metrics.map(m=>[m.name,m.value]))})),
    browserSession.send('SystemInfo.getProcessInfo'),
    pages[0].request.get('/metrics',{headers:{Authorization:'Bearer test-metrics'}}),
   ]);
   expect(response.ok()).toBe(true);
   const server=Object.fromEntries((await response.text()).split('\n').filter(line=>/^webzoom_\w+ \d+$/.test(line)).map(line=>{const [name,value]=line.split(' ');return [name,Number(value)]}));
   return {startedAt,finishedAt:Date.now(),viewers,server,
    rendererHeapBytes:metrics.reduce((sum,m)=>sum+(m.JSHeapUsedSize??0),0),
    rendererTaskSeconds:metrics.reduce((sum,m)=>sum+(m.TaskDuration??0),0),
    chromiumProcesses:processes.processInfo.map(p=>({id:p.id,cpuTime:p.cpuTime})),
   };
  },
  async close(){for(const s of sessions)await s.detach();await browserSession.detach()},
 };
}
export type Sample=Awaited<ReturnType<Awaited<ReturnType<typeof sampler>>['take']>>;
export function assertTopology(sample:Sample,count:number){
 const viewers=sample.viewers.slice(1),roots=Math.ceil(count/4);
 expect(viewers.filter(p=>p.role==='root')).toHaveLength(roots);
 expect(viewers.filter(p=>p.role==='peer')).toHaveLength(count-roots);
 expect(viewers.every(p=>p.openSockets===1)).toBe(true);
 for(const viewer of viewers){
  expect(viewer.frames).toBeGreaterThan(0);
  if(viewer.role==='root')expect(viewer.openConnections).toBeLessThanOrEqual(3);
  if(viewer.role==='peer'){expect(viewer.peerBytes).toBeGreaterThan(0);expect(viewer.centerBytes).toBe(0);expect(viewer.openConnections).toBe(1)}
 }
 expect(viewers.reduce((sum,v)=>sum+v.openConnections,0)).toBe(2*(count-roots));
 expect(sample.server.webzoom_connections).toBe(count+1);
}
export function summary(first:Sample,last:Sample){
 const seconds=(last.startedAt-first.startedAt)/1000;
 const delta=(key:string)=>(last.server[key]??0)-(first.server[key]??0);
 return {seconds,ingressMbps:delta('webzoom_ingress_bytes_total')*8/seconds/1e6,egressMbps:delta('webzoom_egress_bytes_total')*8/seconds/1e6,
  droppedFrames:delta('webzoom_dropped_frames_total'),congestionReports:delta('webzoom_congestion_reports_total'),
  // Observed surviving/new Chromium process CPU seconds per wall second, NOT server CPU. Exited processes are not measurable here.
  chromiumCpuCores:last.chromiumProcesses.reduce((sum,p)=>sum+Math.max(0,p.cpuTime-(first.chromiumProcesses.find(old=>old.id===p.id)?.cpuTime??0)),0)/seconds,
  rendererTaskSecondsPerSecond:(last.rendererTaskSeconds-first.rendererTaskSeconds)/seconds,
  rendererHeapStartBytes:first.rendererHeapBytes,rendererHeapEndBytes:last.rendererHeapBytes,
  minimumViewerFramesPerSecond:Math.min(...last.viewers.slice(1).map((v,i)=>(v.frames-first.viewers[i+1].frames)/seconds)),
 };
}
