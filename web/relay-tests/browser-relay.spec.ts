import {test,expect,type Page,type BrowserContext} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
async function capture(page:Page){await page.addInitScript(()=>{
 navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d')!;let n=0;const draw=()=>{x.fillStyle=n++%60<30?'#008070':'#164866';x.fillRect(0,0,c.width,c.height);x.fillStyle='white';x.font='64px sans-serif';x.fillText('Peer relay '+n,80,180);requestAnimationFrame(draw)};draw();return c.captureStream(30)};
 navigator.mediaDevices.getUserMedia=async()=>{throw Error('camera/audio forbidden')};
})}
// Observe native connections without replacing their transport behavior.
async function observeConnections(page:Page){await page.addInitScript(()=>{
 const Native=window.RTCPeerConnection;
 const observed=(window as Window&{relayTestConnections?:RTCPeerConnection[]});
 observed.relayTestConnections=[];
 window.RTCPeerConnection=class extends Native {
  constructor(configuration?:RTCConfiguration){super(configuration);observed.relayTestConnections!.push(this)}
 };
})}
async function connectionCount(page:Page){return page.evaluate(()=>((window as Window&{relayTestConnections?:RTCPeerConnection[]}).relayTestConnections??[]).length)}
const bytes=async(p:Page,kind:string)=>Number(await p.getByTestId('relay-panel').getAttribute(`data-${kind}-bytes`));
async function frames(p:Page){await expect.poll(async()=>Number(await p.getByTestId('frames').textContent()),{timeout:25000}).toBeGreaterThan(5)}
async function role(p:Page,r:string){await expect(p.getByTestId('relay-panel')).toHaveAttribute('data-role',r,{timeout:20000})}
async function finish(p:Page){await p.getByRole('button',{name:'结束会议',exact:true}).click();await p.getByRole('button',{name:'确认结束'}).click()}

test('real DataChannels: one center copy, three peer viewers, root departure recovery and end',async({browser},info)=>{
 const contexts:BrowserContext[]=[],pages:Page[]=[],errors:string[]=[],binary=[0,0,0,0,0];
 try{
  for(let i=0;i<5;i++){const c=await browser.newContext({ignoreHTTPSErrors:true});contexts.push(c);const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>ws.on('framereceived',e=>{if(Buffer.isBuffer(e.payload))binary[i]+=e.payload.length}));await capture(p)}
  const [owner,root,leaf1,leaf2,leaf3]=pages;
  await login(owner,'AliceRelay');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const url=owner.url();
  await owner.getByRole('button',{name:'开启网页分流试验'}).click();await expect(owner.getByRole('button',{name:'关闭网页分流试验'})).toBeVisible();
  for(const [i,p] of [root,leaf1,leaf2,leaf3].entries()){await login(p,['BobRelay','CarolRelay','DanaRelay','EveRelay'][i]);await p.goto(url);await expect(p.getByTestId('relay-panel')).toBeVisible()}
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await role(root,'root');await role(leaf1,'peer');await role(leaf2,'peer');await role(leaf3,'peer');await frames(root);await frames(leaf1);await frames(leaf2);await frames(leaf3);
  await expect.poll(()=>bytes(root,'sent')).toBeGreaterThan(0);await expect.poll(()=>bytes(leaf1,'peer')).toBeGreaterThan(0);
  expect(binary[1]).toBeGreaterThan(0);expect(binary[2]).toBe(0);expect(binary[3]).toBe(0);expect(binary[4]).toBe(0);
  expect(await bytes(leaf1,'center')).toBe(0);expect(await bytes(leaf2,'center')).toBe(0);expect(await bytes(leaf3,'center')).toBe(0);
  await expect(owner.getByTestId('relay-overview')).toContainText('每个转发节点最多带 3 位观众');
  await expect(owner.locator('[data-testid="relay-member"][data-member-id="BobRelay"]')).toContainText('已安排向 3 人转发');
  for(const name of ['CarolRelay','DanaRelay','EveRelay']){
   const receiver=owner.locator(`[data-testid="relay-member"][data-member-id="${name}"]`);
   await expect(receiver).toHaveAttribute('data-role','peer');
   await expect(receiver).toHaveAttribute('data-receiving','true',{timeout:20000});
   await expect.poll(async()=>Number(await receiver.getAttribute('data-peer-bytes'))).toBeGreaterThan(0);
   await expect(receiver).toContainText('同伴：BobRelay');
  }
  await expect(leaf1.getByTestId('relay-overview')).toHaveCount(0);
  await owner.screenshot({path:'test-results/browser-relay/host-overview.png',fullPage:true});
  await leaf1.screenshot({path:'test-results/browser-relay/peer-viewer.png',fullPage:true});
  await info.attach('before-failover',{body:JSON.stringify({websocketBinaryBytes:binary,rootSent:await bytes(root,'sent'),peer1:await bytes(leaf1,'peer'),peer2:await bytes(leaf2,'peer'),peer3:await bytes(leaf3,'peer')}),contentType:'application/json'});
  await contexts[1].close();await role(leaf1,'root');await frames(leaf1);await frames(leaf2);await frames(leaf3);await expect.poll(()=>bytes(leaf1,'center')).toBeGreaterThan(0);
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
  const receiver=owner.getByTestId('relay-member').filter({hasText:'CarolFallback'});
  await expect(receiver).toHaveAttribute('data-role',limit===20?'waiting':'direct');
  await expect(receiver).toContainText('浏览器未能创建同伴连接');
  if(limit===200)await expect(receiver).toHaveAttribute('data-receiving','true',{timeout:20000});
  await finish(owner);
 }finally{
  if(admin&&!admin.isClosed()){const response=await admin.request.get('/api/me');if(response.ok()){const me=await response.json();await admin.request.post('/api/admin/bandwidth',{headers:{'X-CSRF-Token':me.csrf,Origin:new URL(admin!.url()).origin},data:{limitMbps:200}})}}
  for(const c of contexts)await c.close();
 }
});

test('late joins retain healthy channels, bounded roots and real channel failure switches source',async({browser},info)=>{
 test.setTimeout(180000);
 const contexts:BrowserContext[]=[],pages:Page[]=[],errors:string[]=[],binary=[0,0,0,0,0,0];
 try{
  for(let i=0;i<6;i++){
   const c=await browser.newContext({ignoreHTTPSErrors:true});contexts.push(c);const p=await c.newPage();pages.push(p);
   p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>ws.on('framereceived',e=>{if(Buffer.isBuffer(e.payload))binary[i]+=e.payload.length}));await capture(p);await observeConnections(p);
  }
  const [owner]=pages;await login(owner,'AliceExpanded');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const url=owner.url();
  await owner.getByRole('button',{name:'开启网页分流试验'}).click();
  const names=['BobExpanded','CarolExpanded','DanaExpanded','EveExpanded','FayeExpanded'];
  for(let i=1;i<=3;i++){await login(pages[i],names[i-1]);await pages[i].goto(url);await expect(pages[i].getByTestId('relay-panel')).toBeVisible()}
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await frames(pages[2]);
  expect(await connectionCount(pages[2])).toBe(1);expect(await connectionCount(pages[3])).toBe(1);
  // Fifth and sixth participants join an already streaming room.
  for(let i=4;i<6;i++){
   await login(pages[i],names[i-1]);await pages[i].goto(url);await expect(pages[i].getByTestId('relay-panel')).toBeVisible();
   if(i===4){
    await role(pages[i],'peer');await frames(pages[i]);
    await expect(owner.locator('[data-testid="relay-member"][data-member-id="BobExpanded"]')).toContainText('已安排向 3 人转发');
   }
  }
  const roles:string[]=[];
  for(let i=1;i<6;i++){await frames(pages[i]);roles[i]=(await pages[i].getByTestId('relay-panel').getAttribute('data-role'))!}
  expect(roles.filter(r=>r==='root')).toHaveLength(2);expect(roles.filter(r=>r==='peer')).toHaveLength(3);
  await expect(owner.getByTestId('relay-member')).toHaveCount(6);
  for(let i=1;i<6;i++){
   const row=owner.locator(`[data-testid="relay-member"][data-member-id="${names[i-1]}"]`);
   await expect(row).toHaveAttribute('data-receiving','true',{timeout:25000});
   if(roles[i]==='peer'){expect(binary[i]).toBe(0);await expect.poll(async()=>Number(await row.getAttribute('data-peer-bytes'))).toBeGreaterThan(0)}
   else {expect(binary[i]).toBeGreaterThan(0);await expect(row).toContainText(/已安排向 [0-3] 人转发/)}
  }
  await expect(owner.locator('[data-testid="relay-member"][data-member-id="BobExpanded"]')).toContainText('已安排向 3 人转发');
  await expect(owner.locator('[data-testid="relay-member"][data-member-id="FayeExpanded"]')).toContainText('已安排向 0 人转发');
  // Neither unrelated late join may recreate either established viewer connection.
  expect(await connectionCount(pages[2])).toBe(1);expect(await connectionCount(pages[3])).toBe(1);
  const peerBefore=await bytes(pages[2],'peer'),healthyBefore=await bytes(pages[3],'peer');
  await pages[2].evaluate(()=>{
   const connections=(window as Window&{relayTestConnections?:RTCPeerConnection[]}).relayTestConnections!;
   connections[0].close();
  });
  const switched=owner.locator('[data-testid="relay-member"][data-member-id="CarolExpanded"]');
  await expect(switched).toContainText('同伴：FayeExpanded',{timeout:25000});
  await expect(switched).toHaveAttribute('data-receiving','true',{timeout:25000});
  await expect.poll(()=>bytes(pages[2],'peer')).toBeGreaterThan(peerBefore);
  await expect.poll(()=>bytes(pages[3],'peer')).toBeGreaterThan(healthyBefore);
  expect(await bytes(pages[2],'center')).toBe(0);
  expect(await connectionCount(pages[2])).toBe(2);expect(await connectionCount(pages[3])).toBe(1);
  await expect.poll(()=>bytes(pages[5],'sent')).toBeGreaterThan(0);
  await owner.screenshot({path:'test-results/browser-relay/expanded-host-overview.png',fullPage:true});
  await owner.getByTestId('relay-panel').screenshot({path:'test-results/browser-relay/expanded-panel.png'});
  await owner.setViewportSize({width:390,height:844});
  await expect(owner.getByTestId('relay-overview')).toBeVisible();
  expect(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await owner.screenshot({path:'test-results/browser-relay/mobile-host-overview.png',fullPage:true});
  await info.attach('six-participant-relay',{body:JSON.stringify({roles,websocketBinaryBytes:binary}),contentType:'application/json'});
  expect(errors).toEqual([]);await finish(owner);
 }finally{for(const c of contexts)await c.close()}
});


test('owner marks missing receiver reports stale even while real peer media keeps flowing',async({browser})=>{
 test.setTimeout(90000);
 const contexts:BrowserContext[]=[];
 try{
  for(let i=0;i<3;i++)contexts.push(await browser.newContext({ignoreHTTPSErrors:true}));
  const owner=await contexts[0].newPage(),root=await contexts[1].newPage(),leaf=await contexts[2].newPage();await capture(owner);
  await leaf.addInitScript(()=>{
   const send=WebSocket.prototype.send;
   WebSocket.prototype.send=function(data){
    if((window as Window&{pauseRelayReports?:boolean}).pauseRelayReports&&typeof data==='string'){
     try{const m=JSON.parse(data);if(m.type==='browser'&&m.browser?.kind==='report')return}catch{/* Ignore non-JSON traffic. */}
    }
    return send.call(this,data);
   };
  });
  await login(owner,'AliceStale');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const url=owner.url();
  await owner.getByRole('button',{name:'开启网页分流试验'}).click();
  await login(root,'BobStale');await root.goto(url);await expect(root.getByTestId('relay-panel')).toBeVisible();
  await login(leaf,'CarolStale');await leaf.goto(url);await expect(leaf.getByTestId('relay-panel')).toBeVisible();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await role(leaf,'peer');await frames(leaf);
  const row=owner.locator('[data-testid="relay-member"][data-member-id="CarolStale"]');
  await expect(row).toHaveAttribute('data-receiving','true',{timeout:25000});
  await leaf.evaluate(()=>{(window as Window&{pauseRelayReports?:boolean}).pauseRelayReports=true});
  const before=await bytes(leaf,'peer');
  await expect(row).toContainText('上报中断，状态待确认',{timeout:15000});
  await expect(row).toHaveAttribute('data-receiving','false');expect(await bytes(leaf,'peer')).toBeGreaterThan(before);
  await leaf.evaluate(()=>{(window as Window&{pauseRelayReports?:boolean}).pauseRelayReports=false});
  await expect(row).toHaveAttribute('data-receiving','true',{timeout:10000});await finish(owner);
 }finally{for(const c of contexts)await c.close()}
});
