import {test,expect,type Page} from '@playwright/test';
import {openRoom,start,progress,snapshot,finish} from './relayHarness';

async function watchHealthyViewer(page:Page){
 await page.evaluate(()=>{
  const state={clears:0,exits:0};(window as unknown as {lockObservation:typeof state}).lockObservation=state;
  const clear=CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect=function(...args:Parameters<typeof clear>){if(this.canvas.matches('canvas[aria-label="共享画面"]'))state.clears++;return clear.apply(this,args)};
 });
}
async function watchMembership(owner:Page,member:string){
 await owner.evaluate(member=>{
  const state={exits:0};(window as unknown as {membershipObservation:typeof state}).membershipObservation=state;
  for(const socket of window.relayObservation!.sockets)socket.addEventListener('message',event=>{
   if(typeof event.data!=='string')return;const msg=JSON.parse(event.data);
   if(msg.type==='room'&&!msg.room.participants.some((p:{id:string})=>p.id===member))state.exits++;
  });
 },member);
}
const clears=(page:Page)=>page.evaluate(()=>(window as unknown as {lockObservation:{clears:number}}).lockObservation.clears);
const exits=(page:Page)=>page.evaluate(()=>(window as unknown as {membershipObservation:{exits:number}}).membershipObservation.exits);
async function delayClock(page:Page,all=false){
 await page.evaluate(all=>{
  const state={probes:0,normal:0};(window as unknown as {clockObservation:typeof state}).clockObservation=state;
  const socket=window.relayObservation!.sockets.at(-1)!,handler=socket.onmessage!;
  socket.onmessage=function(event){
   if(typeof event.data==='string'){
    const msg=JSON.parse(event.data);
    if(msg.type==='clock'){
     if(msg.clientTime<0){state.probes++;if(all)return}else{state.normal++;return}
    }
   }
   handler.call(this,event);
  };
 },all);
}

async function peerPath(root:Page,leaf:Page){
 await expect.poll(async()=>{const value=await snapshot(leaf);return value.role==='peer'&&value.openConnections===1&&value.peerBytes>0&&value.centerBytes===0},{timeout:20000}).toBe(true);
 expect((await snapshot(root)).sentBytes).toBeGreaterThan(0);
}

test('delayed background clocks revalidate the existing WSS instead of repeatedly leaving the room',async({browser},info)=>{
 test.setTimeout(90000);const room=await openRoom(browser,2,'BackgroundClock'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);await peerPath(root,leaf);await owner.getByRole('button',{name:'允许 BackgroundClock2 批注',exact:true}).click();
  await watchMembership(owner,'BackgroundClock2');await watchHealthyViewer(root);const before=await snapshot(leaf);
  await delayClock(leaf);await owner.waitForTimeout(23000);await progress([root,leaf]);await peerPath(root,leaf);
  const clocks=await leaf.evaluate(()=>(window as unknown as {clockObservation:{probes:number;normal:number}}).clockObservation);
  const after=await snapshot(leaf);expect(clocks.probes).toBeGreaterThanOrEqual(2);expect(clocks.normal).toBeGreaterThan(3);
  expect(await exits(owner)).toBe(0);expect(await clears(root)).toBe(0);expect(after.openSockets).toBe(1);
  expect(await leaf.evaluate(()=>window.relayObservation!.sockets.length)).toBe(1);expect(after.connections).toBe(before.connections);
  await leaf.getByRole('button',{name:'展开工具栏',exact:true}).click();await expect(leaf.getByRole('button',{name:'画笔',exact:true})).toBeVisible();
  await info.attach('background-clock-proof',{body:JSON.stringify({scope:'Synthetic screen, real WSS/RTC; ordinary clock replies intentionally delayed, fresh probe replies delivered',before,after,clocks},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});

test('repeated browser lifecycle freezes do not eject a viewer or clear a healthy viewers canvas',async({browser},info)=>{
 test.setTimeout(120000);const room=await openRoom(browser,2,'LifecycleFreeze'),[owner,root,leaf]=room.pages;
 const cdp=await room.contexts[2].newCDPSession(leaf);
 try{
  await start(owner);await progress([root,leaf]);await peerPath(root,leaf);await watchMembership(owner,'LifecycleFreeze2');await watchHealthyViewer(root);
  const before=await snapshot(leaf);
  for(let round=0;round<2;round++){
   await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await owner.waitForTimeout(14000);await progress([root]);
   await cdp.send('Page.setWebLifecycleState',{state:'active'});await progress([root,leaf]);await peerPath(root,leaf);
  }
  const after=await snapshot(leaf);expect(await exits(owner)).toBe(0);expect(await clears(root)).toBe(0);
  expect(after.openSockets).toBe(1);expect(await leaf.evaluate(()=>window.relayObservation!.sockets.length)).toBe(1);
  await info.attach('browser-freeze-proof',{body:JSON.stringify({scope:'Chrome DevTools lifecycle freeze, not a physical Windows lock or network power-state test',before,after},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await cdp.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});await cdp.detach();await room.close()}
});

test('three genuine leaf reconnects update membership without resetting unaffected playback',async({browser},info)=>{
 test.setTimeout(120000);const room=await openRoom(browser,2,'MembershipChurn'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);await peerPath(root,leaf);await watchHealthyViewer(root);const before=await snapshot(root);
  for(let round=0;round<3;round++){
   await leaf.evaluate(()=>window.relayObservation!.sockets.at(-1)!.close());
   await expect.poll(()=>leaf.evaluate(()=>window.relayObservation!.sockets.length)).toBe(round+2);
   await expect(owner.getByTestId('relay-member')).toHaveCount(3);await progress([root,leaf]);await peerPath(root,leaf);
  }
  const after=await snapshot(root);expect(await clears(root)).toBe(0);expect(after.frames).toBeGreaterThan(before.frames);
  expect(await root.evaluate(()=>window.relayObservation!.sockets.length)).toBe(1);
  await info.attach('membership-churn-proof',{body:JSON.stringify({before,after,healthyViewerCanvasClears:await clears(root)},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});

test('a genuinely unresponsive foreground control connection still reconnects and recovers',async({browser})=>{
 test.setTimeout(90000);const room=await openRoom(browser,2,'SilentControl'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);await peerPath(root,leaf);await watchHealthyViewer(root);await delayClock(leaf,true);
  await expect.poll(()=>leaf.evaluate(()=>window.relayObservation!.sockets.length),{timeout:25000}).toBe(2);
  await progress([root,leaf]);await peerPath(root,leaf);expect((await snapshot(leaf)).openSockets).toBe(1);expect(await clears(root)).toBe(0);
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});


test('a suspended forwarding path uses budgeted source failover without ejecting the forwarder',async({browser},info)=>{
 test.setTimeout(90000);const room=await openRoom(browser,2,'FrozenRoot'),[owner,root,leaf]=room.pages;
 const cdp=await room.contexts[1].newCDPSession(root);
 try{
  await start(owner);await progress([root,leaf]);await peerPath(root,leaf);await watchMembership(owner,'FrozenRoot1');
  const before=await snapshot(leaf);
  // Lifecycle freeze alone did not stop RTC forwarding on this browser. Inject
  // the missing-media failure explicitly instead of assuming a physical lock.
  await root.evaluate(()=>{
   const send=RTCDataChannel.prototype.send;
   (window as unknown as {restoreForwarding:()=>void}).restoreForwarding=()=>{RTCDataChannel.prototype.send=send};
   RTCDataChannel.prototype.send=function(){};
  });
  await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await owner.waitForTimeout(16000);
  // The dependent has really stopped receiving, so budgeted failover is required.
  await progress([leaf]);const changed=await snapshot(leaf);expect(changed.role).toBe('direct');
  await cdp.send('Page.setWebLifecycleState',{state:'active'});await root.evaluate(()=>(window as unknown as {restoreForwarding:()=>void}).restoreForwarding());await progress([root,leaf]);
  expect(await exits(owner)).toBe(0);expect(await root.evaluate(()=>window.relayObservation!.sockets.length)).toBe(1);
  expect((await snapshot(root)).openSockets).toBe(1);
  await info.attach('frozen-forwarder-proof',{body:JSON.stringify({scope:'Explicit RTC send pause plus lifecycle freeze, not physical lock; a dependent viewer may stall before budgeted source failover',before,changed},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await cdp.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});await cdp.detach();await room.close()}
});
