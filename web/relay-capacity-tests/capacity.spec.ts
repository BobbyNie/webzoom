import {test,expect,type Page} from '@playwright/test';
import {arch,cpus,freemem,platform,totalmem} from 'node:os';
import {finish,openRoom,progress,start,snapshot} from '../relay-tests/relayHarness';
import {assertTopology,boundedSeconds,sampler,summary,type Sample} from './measure';
const counts=(process.env.RELAY_CAPACITY_VIEWERS??'16,32,64').split(',').map(Number);
if(!counts.length||new Set(counts).size!==counts.length||counts.some(n=>![16,32,64].includes(n)))throw Error('RELAY_CAPACITY_VIEWERS accepts unique stages from 16,32,64 only');
const fallbacks=boundedSeconds('RELAY_CAPACITY_FALLBACKS',0,0,8);
const seconds=boundedSeconds('RELAY_CAPACITY_SECONDS',30,10,300);
for(const count of counts)test(`${count} viewer local Chromium capacity sample`,async({browser},info)=>{
 test.setTimeout(180000+count*5000+seconds*1000);
 const samples:Sample[]=[],room=await openRoom(browser,count,`Capacity${count}x`,()=>{if(freemem()<512*1024*1024)throw Error("Local available memory below 512 MiB; stopping to protect this computer, not a product capacity verdict")});let sample:Awaited<ReturnType<typeof sampler>>|undefined,startup:Sample|undefined;
 try{
  sample=await sampler(browser,room.pages);startup=await sample.take();
  await start(room.pages[0]);await progress(room.pages.slice(1),60000);
  samples.push(await sample.take());assertTopology(samples[0],count);
  const until=Date.now()+seconds*1000;
  while(Date.now()<until){
   await room.pages[0].waitForTimeout(Math.min(5000,until-Date.now()));
   const next=await sample.take(),previous=samples.at(-1)!;samples.push(next);assertTopology(next,count);
   expect(next.viewers.slice(1).every((v,i)=>v.frames>previous.viewers[i+1].frames)).toBe(true);
   expect(next.viewers.slice(1).every((v,i)=>v.connections===samples[0].viewers[i+1].connections)).toBe(true);
  }
  if(fallbacks){
   const candidates:Page[]=[];
   for(const page of room.pages.slice(1))if((await snapshot(page)).role==='peer'&&candidates.length<fallbacks)candidates.push(page);
   expect(candidates).toHaveLength(fallbacks);
   const before=await sample.take();
   await Promise.all(candidates.map(page=>page.evaluate(()=>{const active=window.relayObservation!.connections.find(c=>c.connectionState==='connected')!;window.RTCPeerConnection=class extends window.RTCPeerConnection{constructor(c?:RTCConfiguration){super(c);this.close();throw Error('test-only peer setup blocked')}};active.close()})));
   await expect.poll(async()=>Promise.all(candidates.map(snapshot)).then(rows=>rows.every(r=>r.role==='direct')),{timeout:30000}).toBe(true);
   await progress(room.pages.slice(1),60000);const after=await sample.take();
   expect(after.viewers.slice(1).every((v,i)=>v.frames>before.viewers[i+1].frames&&v.openSockets===1)).toBe(true);
   for(const page of candidates)expect((await snapshot(page)).centerBytes).toBeGreaterThan(0);
   await info.attach('capacity-fallback-report',{body:JSON.stringify({scope:'Explicit local RTC close and replacement-RTC setup failure on selected leaf viewers; actual server fallback, not corporate outage simulation',fallbacks,before,after},null,2),contentType:'application/json'});
  }
  expect(room.errors).toEqual([]);await finish(room.pages[0]);
 }finally{
  const report={scope:'One local Chromium instance, isolated sessions and loopback only; synthetic 1280x720 canvas at 30 fps, not 64 physical computers, high-entropy screen content or a corporate-network load test. CPU covers Chromium only; JS heap is not RSS/server memory or proof of no leaks.',viewers:count,requestedSeconds:seconds,
   machine:{platform:platform(),arch:arch(),logicalCPUs:cpus().length,totalMemoryBytes:totalmem(),freeMemoryBytes:freemem()},
   startup:startup&&samples.length?summary(startup,samples[0]):null,
   summary:samples.length>1?summary(samples[0],samples.at(-1)!):null,
   findings:samples.length>1&&summary(samples[0],samples.at(-1)!).minimumViewerFramesPerSecond<10?['Minimum viewer decode rate below 10 fps: connectivity/progress passed, NOT a smooth-playback capacity certification.']:[],samples,errors:room.errors};
  await info.attach('capacity-report',{body:JSON.stringify(report,null,2),contentType:'application/json'});
  await sample?.close();await room.close();
 }
});
