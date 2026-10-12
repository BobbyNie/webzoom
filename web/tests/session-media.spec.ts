import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:string){
 await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();
 await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible();
}
test('real VP8 screen frames and the same WSS connections survive token expiry',async({browser})=>{
 const hostContext=await browser.newContext({ignoreHTTPSErrors:true}),viewerContext=await browser.newContext({ignoreHTTPSErrors:true});
 try{
  const host=await hostContext.newPage(),viewer=await viewerContext.newPage();
  let hostSockets=0,viewerSockets=0,refreshes=0;
  host.on('websocket',()=>hostSockets++);viewer.on('websocket',()=>viewerSockets++);
  for(const page of [host,viewer])page.on('request',r=>{if(r.url().endsWith('/auth/refresh'))refreshes++});
  await host.addInitScript(()=>{
   (window as any).captureCount=0;
   navigator.mediaDevices.getDisplayMedia=async options=>{
    if(options?.audio!==false)throw new Error('audio must remain disabled');
    (window as any).captureCount++;
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const ctx=canvas.getContext('2d')!;let frame=0;
    setInterval(()=>{ctx.fillStyle=++frame%2?'#007c70':'#164866';ctx.fillRect(0,0,1280,720)},33);
    const stream=canvas.captureStream(30);(window as any).captured=stream;return stream;
   };
   navigator.mediaDevices.getUserMedia=async()=>{throw new Error('microphone/camera forbidden')};
   Object.defineProperty(window,'RTCPeerConnection',{value:class{constructor(){throw new Error('WebRTC forbidden')}}});
  });
  await login(host,'RenewHost');await host.getByRole('button',{name:'创建会议',exact:true}).click();
  await expect(host).toHaveURL(/\/m\//);const link=host.url();
  const initial=await (await hostContext.request.get('/api/me')).json();
  expect(Date.parse(initial.expiresAt)-Date.now()).toBeLessThan(15000);
  await host.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await login(viewer,'RenewViewer');await viewer.goto(link);
  await expect.poll(async()=>Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(0);
  const initialViewer=await (await viewerContext.request.get('/api/me')).json();
  const deadline=Math.max(Date.parse(initial.expiresAt),Date.parse(initialViewer.expiresAt));
  await host.waitForTimeout(Math.max(0,deadline-Date.now()+1500));
  expect((await hostContext.request.get('/api/me')).status()).toBe(200);
  expect((await viewerContext.request.get('/api/me')).status()).toBe(200);
  const after=await (await hostContext.request.get('/api/me')).json();
  expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(initial.expiresAt));
  const beforeFrames=Number(await viewer.getByTestId('frames').textContent());
  await expect.poll(async()=>Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(beforeFrames);
  expect(hostSockets).toBe(1);expect(viewerSockets).toBe(1);expect(refreshes).toBeGreaterThanOrEqual(2);
  expect(await host.evaluate(()=>({captures:(window as any).captureCount,audio:(window as any).captured.getAudioTracks().length,state:(window as any).captured.getVideoTracks()[0].readyState}))).toEqual({captures:1,audio:0,state:'live'});
  await expect(host.getByTestId('share-state')).toHaveText('正在共享');
 }finally{await hostContext.close();await viewerContext.close()}
});
