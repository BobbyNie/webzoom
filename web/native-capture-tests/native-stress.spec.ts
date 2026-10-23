import {chromium,expect,test,type Browser,type Page} from '@playwright/test';
import {freemem} from 'node:os';
import {sustainedQuality,type EndurancePoint} from './enduranceQuality';
import {login,progress,snapshot,start,stop,finish} from '../relay-tests/relayHarness';
import {observe,nativeAPIs,pixel,displayedQuality,rtc} from './nativeHarness';
import {nativeDocument,motion,measurePipeline,pipeline} from './pipelineEvidence';
import {resourceProbe,sampleResources,type ResourceProbe} from './resourceEvidence';
import {stallProbe,stallSnapshot,type StallProbe} from './stallEvidence';
import {lifecycleProbe,lifecycleSnapshot,type LifecycleProbe} from './lifecycleEvidence';
const origin='https://127.0.0.1:20443';
const seconds=Number(process.env.RELAY_NATIVE_STRESS_SECONDS??300);
if(!Number.isInteger(seconds)||seconds<300||seconds>1800)throw Error('RELAY_NATIVE_STRESS_SECONDS must be 300–1800 real seconds');
const viewerCount=Number(process.env.RELAY_NATIVE_STRESS_VIEWERS??6);
if(viewerCount!==3&&viewerCount!==6)throw Error('RELAY_NATIVE_STRESS_VIEWERS must be 3 (diagnostic control) or 6 (original gate)');
const recaptureCycles=Number(process.env.RELAY_NATIVE_RECAPTURE_CYCLES??3);
if(!Number.isInteger(recaptureCycles)||recaptureCycles<3||recaptureCycles>12)throw Error('RELAY_NATIVE_RECAPTURE_CYCLES must be 3–12');
const diagnostics=process.env.RELAY_NATIVE_STALL_DIAGNOSTICS==='1';
const colors=[[210,40,50],[30,170,90],[40,80,210]];
test(`native dynamic endurance with ${viewerCount} viewers, browser memory counters and repeated exits`,async({},info)=>{
 test.setTimeout((seconds+(diagnostics?600:240)+Math.max(0,recaptureCycles-3)*40)*1000);
 const browsers:Browser[]=[],entries:{browser:Browser;page:Page}[]=[],errors:string[]=[],checks:unknown[]=[];
 const title=`WebZoom Native Endurance ${Date.now()}`;let owner:Page|undefined,source:Page|undefined,serial=0;
 const stallProbes:StallProbe[]=[],stalls:unknown[]=[],lifecycle:LifecycleProbe[]=[];
 const evidence:{channel:string;version:string}[]=[],probes:ResourceProbe[]=[],resources:unknown[]=[];let quality:ReturnType<typeof sustainedQuality>|undefined;
 const recordResources=async(phase:string)=>{if(diagnostics)stalls.push({phase,at:Date.now(),pages:await stallSnapshot(stallProbes)});resources.push({phase,at:new Date().toISOString(),availableSystemMemoryMiB:Math.round(freemem()/1048576),...await sampleResources(probes)});if(freemem()<256*1048576)throw Error('Stop endurance run: system available memory below 256 MiB')};
 const launch=async(channel:'chrome'|'msedge',capture=false)=>{
  if(freemem()<768*1024*1024)throw Error('Less than 768 MiB system memory available; stop adding test browsers');
  const browser=await chromium.launch({channel,headless:false,args:capture?[`--auto-select-tab-capture-source-by-title=${title}`]:[]});browsers.push(browser);evidence.push({channel,version:browser.version()});
  const context=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:null}),page=await context.newPage();await observe(page);lifecycle.push(await lifecycleProbe(page,'browser-'+evidence.length));if(diagnostics)stallProbes.push(await stallProbe(page,'browser-'+(evidence.length)));if(capture)await measurePipeline(page);page.on('pageerror',e=>errors.push(e.message));probes.push(await resourceProbe(browser,page,'browser-'+evidence.length));return {browser,page,context};
 };
 const viewers=()=>entries.map(e=>e.page);
 const topology=async()=>{await expect.poll(async()=>{const rows=await Promise.all(viewers().map(snapshot));return rows.filter(v=>v.role==='root').length===Math.ceil(entries.length/4)&&rows.every(v=>v.role==='root'||v.role==='peer')},{timeout:30000}).toBe(true)};
 const mark=async(index:number)=>{
  const rgb=colors[index%colors.length];await source!.evaluate(rgb=>{document.body.style.backgroundColor=`rgb(${rgb.join(',')})`},rgb);
  await expect.poll(async()=>{const pixels=await Promise.all(viewers().map(pixel));return pixels.every(p=>p.length===4&&rgb.every((value,i)=>Math.abs(p[i]-value)<35))},{timeout:20000,intervals:[100,250,500]}).toBe(true);
 };
 const addViewer=async()=>{const {browser,page}=await launch(serial%2?'chrome':'msedge');await login(page,`NativeEnduranceViewer${serial++}`);await page.goto(owner!.url());await expect(page.getByTestId('relay-panel')).toBeVisible();entries.push({browser,page})};
 try{
  const opened=await launch('chrome',true);owner=opened.page;await login(owner,'NativeEnduranceOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);await owner.getByRole('button',{name:'开启网页分流试验'}).click();
  source=await opened.context.newPage();if(diagnostics)stallProbes.push(await stallProbe(source,'source'));source.on('pageerror',e=>errors.push('source: '+e.message));await source.route('**/__native_endurance__',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:nativeDocument(title)}));await source.goto(`${origin}/__native_endurance__`);await motion(source,'high');
  for(let i=0;i<viewerCount;i++)await addViewer();await expect(owner.getByTestId('relay-member')).toHaveCount(viewerCount+1);
  const apis=await nativeAPIs(owner);for(const [name,implementation] of Object.entries(apis))expect(implementation,`${name} remains native`).toContain('[native code]');
  await start(owner);await topology();await progress(viewers());await mark(0);
  const before=await Promise.all(viewers().map(snapshot)),sourceBefore=await source.evaluate(()=>window.nativeSourceTicks!),began=Date.now(),samples:unknown[]=[];
  const pipelineBefore=await pipeline(owner);let lastPipeline=pipelineBefore,lastTicks=sourceBefore,lastSampleAt=0;
  const ratePoints:EndurancePoint[]=[{elapsedSeconds:0,frames:before.map(row=>row.frames)}];
  // Attach the live arrays before any long-running checks can throw: failure
  // reports must retain the samples already collected, not just successful runs.
  const continuousCheck={kind:'continuous native high motion',status:'running',configuredSeconds:seconds,before,pipelineBefore,samples,ratePoints};checks.push(continuousCheck);
  await recordResources('continuous-start');let sampleIndex=0,nextResource=Date.now()+60000,nextLog=Date.now()+60000;
  while(Date.now()-began<seconds*1000){
   await owner.waitForTimeout(Math.min(10000,Math.max(0,seconds*1000-(Date.now()-began))));await progress(viewers());await mark(++sampleIndex);
   const rows=await Promise.all(viewers().map(snapshot));for(let i=0;i<rows.length;i++){expect(rows[i].connections).toBe(before[i].connections);if(rows[i].role==='peer')expect(rows[i].centerBytes).toBe(0)}
   ratePoints.push({elapsedSeconds:(Date.now()-began)/1000,frames:rows.map(row=>row.frames)});
   const captured=await pipeline(owner),sourceState=await source.evaluate(()=>({ticks:window.nativeSourceTicks!,visibility:document.visibilityState,focused:document.hasFocus()})),elapsedSeconds=(Date.now()-began)/1000,span=elapsedSeconds-lastSampleAt;
   const rates={sourceHz:(sourceState.ticks-lastTicks)/span,capturedFps:(captured.captured-lastPipeline.captured)/span,queuedFps:(captured.queued-lastPipeline.queued)/span,sentFps:(captured.sent-lastPipeline.sent)/span};
   samples.push({source:sourceState,pipeline:captured,rates,elapsedSeconds,rows,owner:await displayedQuality(owner),availableSystemMemoryMiB:Math.round(freemem()/1048576)});
   console.log('Native stage sample '+JSON.stringify({seconds:Math.round(elapsedSeconds),...rates,visibility:sourceState.visibility,minimumViewerFrames:Math.min(...rows.map(row=>row.frames))}));
   lastPipeline=captured;lastTicks=sourceState.ticks;lastSampleAt=elapsedSeconds;
   if(Date.now()>=nextResource){await recordResources('continuous');nextResource=Date.now()+60000}
   if(Date.now()>=nextLog){console.log(`Native dynamic sharing: ${Math.round((Date.now()-began)/1000)} real seconds, ${viewerCount} viewers receiving`);nextLog=Date.now()+60000}
  }
  await recordResources('continuous-end');
  const duration=(Date.now()-began)/1000,after=await Promise.all(viewers().map(snapshot)),transports=await Promise.all(viewers().map(rtc));
  for(const rows of transports){expect(rows.length).toBeGreaterThan(0);for(const row of rows){expect(row.localProtocol).toBe('udp');expect(row.remoteProtocol).toBe('udp');expect(row.dataChannels.some(c=>c.state==='open'&&(c.bytesSent??0)+(c.bytesReceived??0)>0)).toBe(true)}}
  quality=sustainedQuality(ratePoints);
  const viewerFps=after.map((row,i)=>(row.frames-before[i].frames)/duration);
  Object.assign(continuousCheck,{status:'completed',seconds:duration,sourceUpdatesPerSecond:((await source.evaluate(()=>window.nativeSourceTicks!))-sourceBefore)/duration,viewerFps,minimumAverageViewerFps:Math.min(...viewerFps),after,pipelineAfter:await pipeline(owner),transports,apis});
  await source.screenshot({path:info.outputPath('native-stress-source.png'),fullPage:true});const peerIndex=after.findIndex(row=>row.role==='peer');await entries[peerIndex].page.screenshot({path:info.outputPath('native-stress-peer.png'),fullPage:true});
  await info.attach('native-stress-source',{path:info.outputPath('native-stress-source.png'),contentType:'image/png'});await info.attach('native-stress-peer',{path:info.outputPath('native-stress-peer.png'),contentType:'image/png'});
  if(diagnostics&&!quality.passed){
   // Diagnostic intervention only, AFTER the original six-viewer quality verdict
   // is fixed: remove half the viewer load without replacing capture or source.
   // Neither the failure nor the original quality result can become a pass here.
   for(let n=0;n<3;n++){const rows=await Promise.all(viewers().map(snapshot)),index=rows.findIndex(row=>row.role==='peer');const [closed]=entries.splice(index>=0?index:entries.length-1,1);await closed.browser.close()}
   // Remaining roots are intentionally not compacted by the server on leave.
   // Accept its stable existing tree here; keep the original six-viewer gate.
   await expect.poll(async()=>{const rows=await Promise.all(viewers().map(snapshot));return rows.some(row=>row.role==='root')&&rows.every(row=>row.role==='root'||row.role==='peer')},{timeout:30000}).toBe(true);
   await owner.waitForTimeout(10000);
   for(const phase of ['diagnostic load reduced to three','diagnostic load restored to six']){
    if(phase.includes('restored')){while(entries.length<6)await addViewer();await topology();await owner.waitForTimeout(10000)}
    const p0=await pipeline(owner),v0=await Promise.all(viewers().map(snapshot)),t0=Date.now(),ticks=await source.evaluate(()=>window.nativeSourceTicks!);
    await owner.waitForTimeout(60000);
    const elapsed=(Date.now()-t0)/1000,p1=await pipeline(owner),v1=await Promise.all(viewers().map(snapshot));
    checks.push({kind:phase,seconds:elapsed,viewerFps:v1.map((v,i)=>(v.frames-v0[i].frames)/elapsed),sourceHz:((await source.evaluate(()=>window.nativeSourceTicks!))-ticks)/elapsed,capturedFps:(p1.captured-p0.captured)/elapsed,sentFps:(p1.sent-p0.sent)/elapsed,pipeline:p1});await recordResources(phase);
   }
  }
  for(let cycle=0;cycle<3;cycle++){
   const beforeExit=await Promise.all(viewers().map(snapshot)),root=beforeExit.findIndex(row=>row.role==='root'),began=Date.now();
   const [closed]=entries.splice(root,1);await closed.browser.close();await topology();await progress(viewers());await mark(cycle+1);
   checks.push({kind:'actual root browser exit',cycle:cycle+1,confirmationMilliseconds:Date.now()-began,remaining:await Promise.all(viewers().map(snapshot))});
   await addViewer();await topology();await progress(viewers());await mark(cycle+2);await recordResources('after-root-replacement-'+(cycle+1));
  }
  const reload=entries[(await Promise.all(viewers().map(snapshot))).findIndex(row=>row.role==='peer')].page,beforeReload=Date.now();await reload.reload();await topology();await progress(viewers());await mark(1);checks.push({kind:'actual peer reload',confirmationMilliseconds:Date.now()-beforeReload,rows:await Promise.all(viewers().map(snapshot))});
  for(let cycle=0;cycle<recaptureCycles;cycle++){
   const attempt={kind:'native recapture attempt',cycle:cycle+1,status:'running',before:await Promise.all(viewers().map(snapshot)),at:Date.now()};checks.push(attempt);
   await stop(owner);await expect.poll(async()=>{const rows=await Promise.all(viewers().map(snapshot));return rows.every(row=>row.role==='off'&&row.openConnections===0)},{timeout:20000}).toBe(true);
   await start(owner);await topology();await progress(viewers());await mark(cycle);Object.assign(attempt,{kind:'stop and native recapture',status:'completed',rows:await Promise.all(viewers().map(snapshot))});
  }
  await stop(owner);await expect.poll(async()=>{const rows=await Promise.all(viewers().map(snapshot));return rows.every(row=>row.role==='off'&&row.openConnections===0)},{timeout:20000}).toBe(true);await owner.waitForTimeout(5000);await recordResources('after-final-stop');checks.push({kind:'final stop',rows:await Promise.all(viewers().map(snapshot))});
  expect(errors).toEqual([]);await finish(owner);expect(quality,JSON.stringify(quality)).toMatchObject({passed:true});
 }finally{
  // Keep live failure state too: a recovery assertion may fail AFTER a healthy
  // continuous segment, so the last successful checkpoint is not sufficient.
  const terminalPage=async(page:Page)=>page.isClosed()?{closed:true}:page.evaluate(()=>({at:Date.now(),visibility:document.visibilityState,alert:document.querySelector('.banner.error')?.textContent,notice:document.querySelector('.banner.notice')?.textContent,quality:document.querySelector('.quality-card')?.textContent,stage:document.querySelector('.stage-bottom')?.textContent,role:document.querySelector<HTMLElement>('[data-testid="relay-panel"]')?.dataset.role,counters:window.nativeStall,pipeline:window.nativePipeline,sourceTicks:window.nativeSourceTicks})).catch(error=>({error:String(error)}));
  const terminalState={owner:owner?await terminalPage(owner):null,source:source?await terminalPage(source):null,viewers:await Promise.all(entries.map(entry=>terminalPage(entry.page)))};
  await info.attach('native-stress-report',{body:JSON.stringify({scope:`One Windows PC, actual native getDisplayMedia tab capture, ${viewerCount} separate Chrome/Edge viewer processes; configured continuous high-motion DOM source followed by three real root browser exits/replacements, peer reload and ${recaptureCycles} native sharing restarts. No replacement capture media, corporate access or physical multi-device claims.`,configuredViewers:viewerCount,configuredSeconds:seconds,configuredRecaptures:recaptureCycles,browsers:evidence,checks,resources,quality,errors,terminalState,lifecycle:await lifecycleSnapshot(lifecycle),...(diagnostics?{stalls,diagnosticObservers:true}:{})},null,2),contentType:'application/json'});
  await Promise.allSettled(browsers.map(b=>b.close()));
 }
});
