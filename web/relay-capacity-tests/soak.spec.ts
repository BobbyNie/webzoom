import {test,expect} from '@playwright/test';
import {finish,openRoom,progress,start} from '../relay-tests/relayHarness';
import {assertTopology,boundedSeconds,sampler,summary,type Sample} from './measure';
const seconds=boundedSeconds('RELAY_SOAK_SECONDS',600,60,7200);
test('continuous relay endurance with actual decoded frames',async({browser},info)=>{
 test.setTimeout(seconds*1000+180000);
 const samples:Sample[]=[],room=await openRoom(browser,5,'Soak');let sample:Awaited<ReturnType<typeof sampler>>|undefined;
 try{
  await start(room.pages[0]);await progress(room.pages.slice(1));sample=await sampler(browser,room.pages);
  samples.push(await sample.take());assertTopology(samples[0],5);
  const until=Date.now()+seconds*1000;
  while(Date.now()<until){
   await room.pages[0].waitForTimeout(Math.min(10000,until-Date.now()));
   const next=await sample.take(),previous=samples.at(-1)!;samples.push(next);assertTopology(next,5);
   for(let i=1;i<next.viewers.length;i++){
    expect(next.viewers[i].frames,`viewer ${i} stopped decoding`).toBeGreaterThan(previous.viewers[i].frames);
    expect(next.viewers[i].connections,`viewer ${i} renegotiated unexpectedly`).toBe(samples[0].viewers[i].connections);
   }
  }
  expect(room.errors).toEqual([]);await finish(room.pages[0]);
 }finally{
  await info.attach('endurance-report',{body:JSON.stringify({scope:'Single-machine real elapsed-time local endurance; no sleep/freeze, Wi-Fi or corporate-network emulation. Test observation retains closed connection handles; heap growth alone is not a leak verdict.',requestedSeconds:seconds,summary:samples.length>1?summary(samples[0],samples.at(-1)!):null,samples,errors:room.errors},null,2),contentType:'application/json'});
  await sample?.close();await room.close();
 }
});
