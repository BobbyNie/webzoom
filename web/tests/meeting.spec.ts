import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible();}
async function fakeScreen(page:Page){await page.addInitScript(()=>{
 const w=window as unknown as {captureCalls:DisplayMediaStreamOptions[]};w.captureCalls=[];
 navigator.mediaDevices.getDisplayMedia=async(options)=>{w.captureCalls.push(options!);const c=document.createElement('canvas');c.width=1920;c.height=1080;const ctx=c.getContext('2d')!;let frame=0;function draw(){ctx.fillStyle=frame++%60<30?'#008070':'#164866';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#ffffff';ctx.font='64px sans-serif';ctx.fillText('WebZoom '+frame,100,180);requestAnimationFrame(draw);}draw();return c.captureStream(30);};
 navigator.mediaDevices.getUserMedia=async()=>{throw new Error('camera/microphone forbidden')};
 Object.defineProperty(window,'RTCPeerConnection',{value:class{constructor(){throw new Error('WebRTC forbidden')}}});
});}
test('login, create, share video, join late, transfer and end',async({browser})=>{
 const ownerContext=await browser.newContext({ignoreHTTPSErrors:true}),viewerContext=await browser.newContext({ignoreHTTPSErrors:true});
 const owner=await ownerContext.newPage(),viewer=await viewerContext.newPage();const errors:string[]=[];
 for(const p of [owner,viewer]){p.on('pageerror',e=>errors.push(e.message));await fakeScreen(p);}
 await login(owner,'Alice');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();
 await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await expect(owner.getByTestId('share-state')).toHaveText('正在共享');
 await login(viewer,'Bob');await viewer.goto(link);await expect(viewer.getByTestId('share-state')).toHaveText('正在共享');
 await expect.poll(()=>viewer.getByTestId('frames').textContent()).not.toBe('0');
 await viewer.screenshot({path:'test-results/meeting-viewer.png',fullPage:true});
 expect(await owner.evaluate(()=>(window as unknown as {captureCalls:DisplayMediaStreamOptions[]}).captureCalls[0].audio)).toBe(false);
 await owner.getByLabel('共享者').selectOption('Bob');await owner.getByRole('button',{name:'转交共享权'}).click();
 await expect(owner.getByTestId('share-state')).toHaveText('等待共享');await viewer.getByRole('button',{name:'共享屏幕',exact:true}).click();await expect.poll(()=>owner.getByTestId('frames').textContent()).not.toBe('0');
 await owner.getByRole('button',{name:'结束会议',exact:true}).click();await owner.getByRole('button',{name:'确认结束'}).click();await expect(viewer.getByText('会议已结束或已过期。')).toBeVisible();expect(errors).toEqual([]);
 await ownerContext.close();await viewerContext.close();
});
test('anonymous meeting access requires login and keeps return link',async({page})=>{await page.goto('/m/missing-room');await page.screenshot({path:'test-results/login.png',fullPage:true});await expect(page.getByRole('link',{name:'使用公司账号登录'})).toBeVisible();expect(await page.getByRole('link',{name:'使用公司账号登录'}).getAttribute('href')).toContain('next=');});

test('cancelled screen picker leaves the meeting idle',async({page})=>{
 await page.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException('cancelled','NotAllowedError')}});
 await login(page,'Carol');await page.getByRole('button',{name:'创建会议',exact:true}).click();
 await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('授权已取消');
 await expect(page.getByTestId('share-state')).toHaveText('等待共享');
 await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeEnabled();
});
test('publisher logout clears the viewer screen and denies anonymous APIs',async({browser})=>{
 const c1=await browser.newContext({ignoreHTTPSErrors:true}),c2=await browser.newContext({ignoreHTTPSErrors:true});
 const p=await c1.newPage(),v=await c2.newPage();await fakeScreen(p);await login(p,'David');await p.getByRole('button',{name:'创建会议',exact:true}).click();
 await expect(p).toHaveURL(/\/m\//);const link=p.url();await p.getByRole('button',{name:'共享屏幕',exact:true}).click();await login(v,'Eva');await v.goto(link);
 await expect.poll(()=>v.getByTestId('frames').textContent()).not.toBe('0');
 await p.getByRole('button',{name:'退出',exact:true}).click();await expect(v.getByTestId('share-state')).toHaveText('等待共享');
 await expect(v.locator('canvas')).toHaveClass(/hidden/);
 expect((await c1.request.get('/api/me')).status()).toBe(401);await c1.close();await c2.close();
});

test('viewer reconnects and browser stop clears the shared image',async({browser})=>{
 const c1=await browser.newContext({ignoreHTTPSErrors:true}),c2=await browser.newContext({ignoreHTTPSErrors:true});
 const p=await c1.newPage(),v=await c2.newPage();await fakeScreen(p);
 await p.addInitScript(()=>{const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async(o)=>{const s=await original(o);(window as any).testScreen=s;return s}});
 await v.addInitScript(()=>{const Original=window.WebSocket;(window as any).testSockets=[];window.WebSocket=class extends Original{constructor(...args:ConstructorParameters<typeof WebSocket>){super(...args);(window as any).testSockets.push(this)}}});
 const urls:string[]=[];for(const page of [p,v]){page.on('request',r=>urls.push(r.url()));page.on('websocket',s=>urls.push(s.url()));}
 await login(p,'Frank');await p.getByRole('button',{name:'创建会议',exact:true}).click();await expect(p).toHaveURL(/\/m\//);const link=p.url();
 await p.getByRole('button',{name:'共享屏幕',exact:true}).click();await expect(p.getByTestId('share-state')).toHaveText('正在共享');
 await login(v,'Grace');await v.goto(link);await expect.poll(()=>v.getByTestId('frames').textContent()).not.toBe('0');
 await v.evaluate(()=>{(window as any).testSockets.at(-1).close()});
 await expect.poll(()=>v.evaluate(()=>(window as any).testSockets.length)).toBe(2);
 await expect.poll(async()=>Number(await v.getByTestId('frames').textContent()),{timeout:10000}).toBeGreaterThan(0);
 await p.evaluate(()=>{const t=(window as any).testScreen.getVideoTracks()[0];t.stop();t.dispatchEvent(new Event('ended'))});
 await expect(v.getByTestId('share-state')).toHaveText('等待共享');await expect(v.locator('canvas')).toHaveClass(/hidden/);
 expect(urls.every(u=>u.startsWith('https://127.0.0.1:')||u.startsWith('wss://127.0.0.1:'))).toBe(true);
 await c1.close();await c2.close();
});

test('screen encoding does not depend on the visible-tab animation clock',async({page})=>{
 await page.addInitScript(()=>{
  navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1920;c.height=1080;const ctx=c.getContext('2d')!;let n=0;setInterval(()=>{ctx.fillStyle=++n%2?'#007c70':'#164866';ctx.fillRect(0,0,1920,1080)},33);return c.captureStream(30)};
  window.requestAnimationFrame=()=>{throw new Error('animation clock is unavailable in a hidden sharing tab')};
 });
 await login(page,'HiddenTab');await page.getByRole('button',{name:'创建会议',exact:true}).click();await expect(page).toHaveURL(/\/m\//);
 await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
 await expect.poll(async()=>Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
 await expect(page.getByTestId('share-state')).toHaveText('正在共享');
});
