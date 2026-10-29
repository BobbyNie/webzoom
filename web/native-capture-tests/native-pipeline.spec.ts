import {chromium,expect,test,type Browser,type Page} from '@playwright/test';
import {login,progress,snapshot,start,finish} from '../relay-tests/relayHarness';
import {observe,nativeAPIs,displayedQuality} from './nativeHarness';
import {measurePipeline,nativeDocument,pipeline,motion} from './pipelineEvidence';
const origin='https://127.0.0.1:20443';
test('measure native capture, encoding and delivery for low and high motion',async({},info)=>{
 const browsers:Browser[]=[],viewers:Page[]=[],errors:string[]=[],phases:unknown[]=[];let owner:Page|undefined,source:Page|undefined;
 const title=`WebZoom Native Pipeline ${Date.now()}`;
 try{
  const browser=await chromium.launch({channel:'chrome',headless:false,args:[`--auto-select-tab-capture-source-by-title=${title}`]});browsers.push(browser);
  const context=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:null});owner=await context.newPage();await observe(owner);await measurePipeline(owner);owner.on('pageerror',e=>errors.push(e.message));
  await login(owner,'PipelineOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);await expect(owner.getByRole('button',{name:'关闭本会议分流'})).toBeEnabled();
  source=await context.newPage();source.on('pageerror',e=>errors.push('source: '+e.message));await source.route('**/__native_pipeline__',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:nativeDocument(title)}));await source.goto(`${origin}/__native_pipeline__`);await expect.poll(()=>source!.evaluate(()=>window.nativeSourceTicks??-1),{timeout:5000}).toBeGreaterThan(3);
  for(let i=0;i<3;i++){const b=await chromium.launch({channel:i%2?'chrome':'msedge',headless:false});browsers.push(b);const c=await b.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:null});const page=await c.newPage();viewers.push(page);await observe(page);page.on('pageerror',e=>errors.push(e.message));await login(page,`PipelineViewer${i}`);await page.goto(owner.url());await expect(page.getByTestId('relay-panel')).toBeVisible()}
  for(const [name,fn] of Object.entries(await nativeAPIs(owner)))expect(fn,`${name} remains native`).toContain('[native code]');
  await motion(source,'high');await start(owner);await progress(viewers);
  for(const mode of ['high','low'] as const){
   await motion(source,mode);await owner.waitForTimeout(3000);const began=Date.now(),before=await pipeline(owner),vBefore=await Promise.all(viewers.map(snapshot)),sourceBefore=await source.evaluate(()=>window.nativeSourceTicks!);
   await owner.waitForTimeout(30000);
   const seconds=(Date.now()-began)/1000,after=await pipeline(owner),vAfter=await Promise.all(viewers.map(snapshot)),sourceAfter=await source.evaluate(()=>window.nativeSourceTicks!);
   phases.push({mode,seconds,sourceUpdatesPerSecond:(sourceAfter-sourceBefore)/seconds,captureFps:(after.captured-before.captured)/seconds,queuedFps:(after.queued-before.queued)/seconds,sentFps:(after.sent-before.sent)/seconds,viewerFps:vAfter.map((v,i)=>(v.frames-vBefore[i].frames)/seconds),before,after,owner:await displayedQuality(owner),viewers:await Promise.all(viewers.map(displayedQuality))});
  }
  // Exercise the real feedback -> publisher -> native applyConstraints path.
  // Only control feedback is induced; capture, pixels and codecs stay native.
  await motion(source,'high');
  const feedback=()=>viewers[0].evaluate(()=>{
   const socket=window.relayObservation?.sockets.find(s=>s.readyState===WebSocket.OPEN);
   if(!socket)throw Error('missing real meeting socket');socket.send(JSON.stringify({type:'feedback',level:1}));
  });
  await feedback();await owner.waitForTimeout(3300);await feedback();
  await expect.poll(async()=>{
   const counters=await pipeline(owner!);
   return counters.captureChanges.some(c=>!c.error&&c.settings?.height!==undefined&&c.settings.height<=720)&&counters.sourceHeight<=720;
  },{timeout:20000}).toBe(true);
  await progress(viewers);
  phases.push({kind:'native capture budget reduction via real feedback',pipeline:await pipeline(owner),owner:await displayedQuality(owner),viewers:await Promise.all(viewers.map(displayedQuality))});
  expect(errors).toEqual([]);await finish(owner);
 }finally{
  if(source&&!source.isClosed())phases.push({kind:'source diagnostics',state:await source.evaluate(()=>({ticks:window.nativeSourceTicks,viewport:{width:innerWidth,height:innerHeight},clock:document.querySelector('#clock')?.getBoundingClientRect().toJSON(),visibility:document.visibilityState,text:document.body.innerText}))});
  if(owner&&!owner.isClosed())phases.push({kind:'final diagnostics',pipeline:await pipeline(owner),owner:await owner.locator('body').innerText(),viewers:await Promise.all(viewers.filter(p=>!p.isClosed()).map(displayedQuality))});
  await info.attach('native-pipeline-report',{body:JSON.stringify({scope:'One PC, native getDisplayMedia on dedicated DOM tab. Native read/encode/send methods observed by forwarding wrappers; no replacement media.',phases,errors},null,2),contentType:'application/json'});await Promise.allSettled(browsers.map(b=>b.close()))}
});