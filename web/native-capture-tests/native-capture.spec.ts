import {chromium,expect,test,type Browser,type Page} from '@playwright/test';
import {login,progress,snapshot,start,stop,finish} from '../relay-tests/relayHarness';
import {observe,nativeAPIs,pixel,displayedQuality,rtc} from './nativeHarness';
const origin='https://127.0.0.1:20443';
const colors={red:[210,40,50],green:[30,170,90],blue:[40,80,210]} as const;

test('native tab capture across separate headed Chrome and Edge processes',async({},info)=>{
 const browsers:Browser[]=[],pages:Page[]=[],errors:string[]=[],checks:unknown[]=[],evidence:unknown[]=[];
 const title=`WebZoom Native Capture Evidence ${Date.now()}`;
 const launch=async(channel:'chrome'|'msedge',capture=false)=>{
  const browser=await chromium.launch({channel,headless:false,args:capture?[`--auto-select-tab-capture-source-by-title=${title}`]:[]});browsers.push(browser);
  const context=await browser.newContext({baseURL:origin,ignoreHTTPSErrors:true,viewport:{width:1280,height:720}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await observe(page);pages.push(page);
  evidence.push({channel,version:browser.version(),userAgent:await page.evaluate(()=>navigator.userAgent)});return page;
 };
 try{
  const owner=await launch('chrome',true);await login(owner,'NativeCaptureOwner');
  await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);
  await expect(owner.getByRole('button',{name:'关闭本会议分流'})).toBeEnabled();
  const source=await owner.context().newPage();
  await source.route('**/__native_capture_evidence__',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><style>body{margin:0;color:white;background:rgb(210,40,50);font:24px sans-serif}header{padding:28px;background:#0009}h1{font-size:32px;margin:0 0 12px}footer{position:fixed;bottom:0;padding:28px;background:#0009;width:100%;box-sizing:border-box}.bar{height:16px;background:white;animation:move 2s linear infinite}@keyframes move{from{width:5%}to{width:95%}}</style><header><h1>WebZoom · 原生浏览器标签页采集实测</h1><div id="stage">阶段 red</div></header><footer><p>独立测试页面 · 无公司数据 · 画面由浏览器实际绘制</p><p id="clock"></p><div class="bar"></div></footer><script>setInterval(()=>document.querySelector('#clock').textContent=new Date().toISOString(),100)</script></html>`}));
  await source.goto(`${origin}/__native_capture_evidence__`);
  for(let i=1;i<=3;i++){const viewer=await launch(i===2?'chrome':'msedge');await login(viewer,`NativeCaptureViewer${i}`);await viewer.goto(owner.url());await expect(viewer.getByTestId('relay-panel')).toBeVisible()}
  await expect(owner.getByTestId('relay-member')).toHaveCount(4);
  const apis=await nativeAPIs(owner);for(const [name,implementation] of Object.entries(apis))expect(implementation,`${name} must remain native`).toContain('[native code]');
  evidence.push({nativeAPIs:apis,sourceTitle:title,sourceURL:source.url()});
  const mark=async(name:keyof typeof colors,viewers:Page[])=>{
   const expected=Array.from(colors[name]),began=Date.now();
   await source.evaluate(({name,expected})=>{document.body.style.backgroundColor=`rgb(${expected.join(',')})`;document.querySelector('#stage')!.textContent=`阶段 ${name}`},{name,expected});
   await expect.poll(async()=>{const pixels=await Promise.all(viewers.map(pixel));return pixels.every(p=>p.length===4&&expected.every((value,i)=>Math.abs(p[i]-value)<35))},{timeout:20000,intervals:[100,250,500]}).toBe(true);
   checks.push({kind:'actual decoded pixel match',name,confirmationMilliseconds:Date.now()-began,pixels:await Promise.all(viewers.map(pixel)),snapshots:await Promise.all(viewers.map(snapshot))});
  };
  await start(owner);await progress(pages.slice(1));await mark('red',pages.slice(1));await mark('green',pages.slice(1));await mark('blue',pages.slice(1));
  const before=await Promise.all(pages.slice(1).map(snapshot));
  expect(before.filter(v=>v.role==='root')).toHaveLength(1);expect(before.filter(v=>v.role==='peer')).toHaveLength(2);
  expect(before.filter(v=>v.role==='peer').every(v=>v.centerBytes===0&&v.peerBytes>0)).toBe(true);
  const ownerBefore=await displayedQuality(owner),stableStart=Date.now();
  for(let interval=0;interval<6;interval++){await owner.waitForTimeout(10000);await progress(pages.slice(1));await mark(interval%2?'blue':'green',pages.slice(1))}
  const after=await Promise.all(pages.slice(1).map(snapshot)),seconds=(Date.now()-stableStart)/1000;
  for(let i=0;i<after.length;i++){expect(after[i].connections).toBe(before[i].connections);expect(after[i].frames).toBeGreaterThan(before[i].frames)}
  const transports=await Promise.all(pages.slice(1).map(rtc));
  for(const rows of transports)for(const row of rows){expect(row.localProtocol).toBe('udp');expect(row.remoteProtocol).toBe('udp');expect(row.dataChannels.some(c=>(c.bytesSent??0)+(c.bytesReceived??0)>0)).toBe(true)}
  checks.push({kind:'native capture steady period',seconds,minimumAverageViewerFps:Math.min(...after.map((v,i)=>(v.frames-before[i].frames)/seconds)),before,after,transports,ownerBefore,ownerAfter:await displayedQuality(owner),viewerQuality:await Promise.all(pages.slice(1).map(displayedQuality))});
  await source.screenshot({path:info.outputPath('native-source.png'),fullPage:true});await pages[2].screenshot({path:info.outputPath('native-peer-received.png'),fullPage:true});
  await info.attach('native-source',{path:info.outputPath('native-source.png'),contentType:'image/png'});await info.attach('native-peer-received',{path:info.outputPath('native-peer-received.png'),contentType:'image/png'});
  // Close the entire independent root browser process, not a mocked connection.
  const rootIndex=before.findIndex(v=>v.role==='root')+1,exitBegan=Date.now();await browsers[rootIndex].close();
  const survivors=pages.slice(1).filter((_,i)=>i+1!==rootIndex);
  await expect.poll(async()=>{const rows=await Promise.all(survivors.map(snapshot));return rows.filter(v=>v.role==='root').length===1&&rows.filter(v=>v.role==='peer').length===1},{timeout:30000}).toBe(true);
  await progress(survivors);await mark('red',survivors);
  const recovered=await Promise.all(survivors.map(snapshot));expect(recovered.find(v=>v.role==='peer')?.centerBytes).toBe(0);
  checks.push({kind:'actual root browser exit and automatic reroute',confirmationMilliseconds:Date.now()-exitBegan,recovered,transports:await Promise.all(survivors.map(rtc))});
  await stop(owner);await expect.poll(async()=>{const rows=await Promise.all(survivors.map(snapshot));return rows.every(v=>v.openConnections===0&&v.role==='off')}).toBe(true);
  await start(owner);await progress(survivors);await mark('green',survivors);
  checks.push({kind:'stop and new native capture',nativeAPIs:await nativeAPIs(owner),snapshots:await Promise.all(survivors.map(snapshot))});
  expect(errors).toEqual([]);await finish(owner);
 }finally{
  await info.attach('native-capture-report',{body:JSON.stringify({scope:'One Windows computer, four separate headed native Chrome/Edge processes and real getDisplayMedia tab capture. Local virtual OIDC and loopback only; NOT physical multi-device, LAN/corporate, whole-desktop/OS-picker or 64-user validation. Only the dedicated test tab is selected automatically; camera/microphone are not used. Pixel confirmation timing includes automation/polling and is not media latency.',browsers:evidence,checks,errors},null,2),contentType:'application/json'});
  await Promise.allSettled(browsers.map(browser=>browser.close()));
 }
});
