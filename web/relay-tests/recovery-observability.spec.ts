import {test,expect} from '@playwright/test';
import {finish,openRoom,progress,snapshot,start,stop,instrument,login} from './relayHarness';

for(const blocked of [false,true])test(`direct fallback probes a new root without cutting server supply: blocked=${blocked}`,async({browser},info)=>{
 test.setTimeout(150000);
 const prefix=blocked?'ProbeBlocked':'ProbeWorks',room=await openRoom(browser,4,prefix),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress(room.pages.slice(1));
  expect((await snapshot(leaf)).peerBytes).toBeGreaterThan(0);
  await leaf.evaluate(()=>window.relayObservation!.connections[0].close());
  await expect(leaf.getByTestId('relay-panel')).toHaveAttribute('data-role','direct',{timeout:25000});await progress([leaf]);
  const before=await snapshot(leaf),healthyBefore=await snapshot(room.pages[3]);
  await expect(owner.locator(`[data-member-id="${prefix}2"]`)).toContainText('画面接收正常 · 服务器直连');
  // Fill the original root's vacancy, then create an untried root.
  for(let i=5;i<=6;i++){
   const context=await browser.newContext({ignoreHTTPSErrors:true});room.contexts.push(context);
   const page=await context.newPage();room.pages.push(page);page.on('pageerror',e=>room.errors.push(e.message));await instrument(page);
   if(blocked&&i===6)await page.addInitScript(()=>{const send=RTCDataChannel.prototype.send;RTCDataChannel.prototype.send=function(this:RTCDataChannel,...args:Parameters<typeof send>){if(this.label==='webzoom-frames')return;return send.apply(this,args)} as typeof send});
   await login(page,`${prefix}${i}`);await page.goto(owner.url());await expect(page.getByTestId('relay-panel')).toBeVisible();
  }
  const newRoot=room.pages[6];await expect(newRoot.getByTestId('relay-panel')).toHaveAttribute('data-role','root');
  await expect(leaf.getByTestId('relay-panel')).toHaveAttribute('data-server-backup','true',{timeout:45000});
  const probing=await snapshot(leaf);expect(probing.centerBytes).toBeGreaterThan(before.centerBytes);
  if(blocked){
   // A live data channel with intentionally paused forwarding must not stop
   // server playback, nor be falsely counted as successful peer offload.
   await progress([leaf]);const during=await snapshot(leaf);expect(during.centerBytes).toBeGreaterThan(probing.centerBytes);
   await expect(leaf.getByTestId('relay-panel')).toHaveAttribute('data-role','direct',{timeout:20000});
   await progress([leaf]);expect((await snapshot(leaf)).peerBytes).toBe(before.peerBytes);
   await expect(owner.locator(`[data-member-id="${prefix}2"]`)).toContainText('同伴数据通道已打开，但未收到可验证画面');
  }else{
   await expect(leaf.getByTestId('relay-panel')).toHaveAttribute('data-server-backup','false',{timeout:15000});
   expect((await snapshot(leaf)).role).toBe('peer');await progress([leaf]);
   const committed=await snapshot(leaf);await leaf.waitForTimeout(2500);await progress([leaf]);
   const after=await snapshot(leaf);expect(after.centerBytes).toBe(committed.centerBytes);expect(after.peerBytes).toBeGreaterThan(committed.peerBytes);
  }
  const after=await snapshot(leaf),healthyAfter=await snapshot(room.pages[3]);
  expect(after.openSockets).toBe(1);expect(await leaf.evaluate(()=>window.relayObservation!.sockets.length)).toBe(1);
  expect(healthyAfter.connections).toBe(healthyBefore.connections);expect(healthyAfter.frames).toBeGreaterThan(healthyBefore.frames);
  await info.attach('make-before-break',{body:JSON.stringify({scope:'Synthetic local screen, real WSS/RTC; blocked test explicitly suppresses RTC sends',before,probing,after,healthyBefore,healthyAfter},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});

test('sharing counters reset separately from lifetime and diagnostic export is redacted on desktop and mobile',async({browser},info)=>{
 test.setTimeout(90000);const room=await openRoom(browser,2,'StatsPrivacy'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);expect((await snapshot(leaf)).peerBytes).toBeGreaterThan(0);
  await stop(owner);const lifetime=(await snapshot(leaf)).peerBytes;await start(owner);await progress([root,leaf]);
  await leaf.getByRole('button',{name:'复制诊断信息'}).click();
  const text=await leaf.getByLabel('脱敏诊断信息').inputValue(),data=JSON.parse(text);
  expect(data.local.lifetime.peerBytes).toBeGreaterThan(lifetime);expect(data.local.sharing.peerBytes).toBeGreaterThan(0);
  expect(data.local.sharing.peerBytes).toBeLessThan(data.local.lifetime.peerBytes);
  for(const secret of ['StatsPrivacy',new URL(owner.url()).pathname,'127.0.0.1','sdp','candidate:','token='])expect(text).not.toContain(secret);
  await leaf.getByLabel('流量统计范围').selectOption('lifetime');await expect(leaf.getByLabel('流量统计范围')).toHaveValue('lifetime');
  await expect(owner.locator('[data-testid="relay-member"][data-receiving="true"]')).toHaveCount(2);
  await owner.getByTestId('relay-panel').screenshot({path:info.outputPath('relay-dashboard-desktop.png')});
  await owner.setViewportSize({width:390,height:844});
  await expect(owner.getByRole('button',{name:'复制诊断信息'})).toBeVisible();
  await owner.getByTestId('relay-panel').screenshot({path:info.outputPath('relay-dashboard-mobile.png')});
  expect(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});
