import {test,expect,type Page,type BrowserContext} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
async function capture(page:Page){await page.addInitScript(()=>{
 navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d')!;let n=0;const draw=()=>{x.fillStyle=n++%60<30?'#008070':'#164866';x.fillRect(0,0,c.width,c.height);x.fillStyle='white';x.font='64px sans-serif';x.fillText('Peer relay '+n,80,180);requestAnimationFrame(draw)};draw();return c.captureStream(30)};
 navigator.mediaDevices.getUserMedia=async()=>{throw Error('camera/audio forbidden')};
})}
const bytes=async(p:Page,kind:string)=>Number(await p.getByTestId('relay-panel').getAttribute(`data-${kind}-bytes`));
async function frames(p:Page){await expect.poll(async()=>Number(await p.getByTestId('frames').textContent()),{timeout:25000}).toBeGreaterThan(5)}
async function role(p:Page,r:string){await expect(p.getByTestId('relay-panel')).toHaveAttribute('data-role',r,{timeout:20000})}
async function finish(p:Page){await p.getByRole('button',{name:'结束会议',exact:true}).click();await p.getByRole('button',{name:'确认结束'}).click()}

test('real DataChannels: one center copy, two peer viewers, root departure recovery and end',async({browser},info)=>{
 const contexts:BrowserContext[]=[],pages:Page[]=[],errors:string[]=[],binary=[0,0,0,0];
 try{
  for(let i=0;i<4;i++){const c=await browser.newContext({ignoreHTTPSErrors:true});contexts.push(c);const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>ws.on('framereceived',e=>{if(Buffer.isBuffer(e.payload))binary[i]+=e.payload.length}));await capture(p)}
  const [owner,root,leaf1,leaf2]=pages;
  await login(owner,'AliceRelay');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const url=owner.url();
  await owner.getByRole('button',{name:'开启网页分流试验'}).click();await expect(owner.getByRole('button',{name:'关闭网页分流试验'})).toBeVisible();
  for(const [i,p] of [root,leaf1,leaf2].entries()){await login(p,['BobRelay','CarolRelay','DanaRelay'][i]);await p.goto(url);await expect(p.getByTestId('relay-panel')).toBeVisible()}
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await role(root,'root');await role(leaf1,'peer');await role(leaf2,'peer');await frames(root);await frames(leaf1);await frames(leaf2);
  await expect.poll(()=>bytes(root,'sent')).toBeGreaterThan(0);await expect.poll(()=>bytes(leaf1,'peer')).toBeGreaterThan(0);
  expect(binary[1]).toBeGreaterThan(0);expect(binary[2]).toBe(0);expect(binary[3]).toBe(0);
  expect(await bytes(leaf1,'center')).toBe(0);expect(await bytes(leaf2,'center')).toBe(0);
  await leaf1.screenshot({path:'test-results/browser-relay/peer-viewer.png',fullPage:true});
  await info.attach('before-failover',{body:JSON.stringify({websocketBinaryBytes:binary,rootSent:await bytes(root,'sent'),peer1:await bytes(leaf1,'peer'),peer2:await bytes(leaf2,'peer')}),contentType:'application/json'});
  await contexts[1].close();await role(leaf1,'root');await frames(leaf1);await frames(leaf2);await expect.poll(()=>bytes(leaf1,'center')).toBeGreaterThan(0);
  await finish(owner);await expect(leaf2.getByText('会议已结束或已过期。')).toBeVisible({timeout:15000});expect(errors).toEqual([]);
 }finally{for(const c of contexts)await c.close()}
});

for(const limit of [20,200])test(`blocked peer path: budget ${limit} gives ${limit===20?'waiting':'direct fallback'}`,async({browser})=>{
 const contexts:BrowserContext[]=[];let admin:Page|undefined;
 try{
  for(let i=0;i<3;i++)contexts.push(await browser.newContext({ignoreHTTPSErrors:true}));
  const owner=admin=await contexts[0].newPage(),root=await contexts[1].newPage(),leaf=await contexts[2].newPage();await capture(owner);
  await leaf.addInitScript(()=>{Object.defineProperty(window,'RTCPeerConnection',{value:class{constructor(){throw Error('simulated IT policy block')}}})});
  await login(owner,'TestAdmin');const me=await (await owner.request.get('/api/me')).json();expect((await owner.request.post('/api/admin/bandwidth',{headers:{'X-CSRF-Token':me.csrf,Origin:new URL(admin!.url()).origin},data:{limitMbps:limit}})).ok()).toBeTruthy();
  await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const url=owner.url();await owner.getByRole('button',{name:'开启网页分流试验'}).click();
  await login(root,'BobFallback');await root.goto(url);await expect(root.getByTestId('relay-panel')).toBeVisible();await login(leaf,'CarolFallback');await leaf.goto(url);await expect(leaf.getByTestId('relay-panel')).toBeVisible();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await role(leaf,limit===20?'waiting':'direct');await frames(root);
  if(limit===200){await frames(leaf);expect(await bytes(leaf,'peer')).toBe(0);await expect.poll(()=>bytes(leaf,'center')).toBeGreaterThan(0)}else{expect(await bytes(leaf,'center')).toBe(0);await expect(leaf.getByTestId('relay-panel')).toContainText('额度不足')}
  await finish(owner);
 }finally{
  if(admin&&!admin.isClosed()){const response=await admin.request.get('/api/me');if(response.ok()){const me=await response.json();await admin.request.post('/api/admin/bandwidth',{headers:{'X-CSRF-Token':me.csrf,Origin:new URL(admin!.url()).origin},data:{limitMbps:200}})}}
  for(const c of contexts)await c.close();
 }
});
