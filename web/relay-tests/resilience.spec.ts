import {test,expect} from '@playwright/test';
import {finish,openRoom,progress,snapshot,start,stop} from './relayHarness';

test('four sharing epochs dispose old channels and resume actual decoded peer frames',async({browser},info)=>{
 test.setTimeout(180000);
 const room=await openRoom(browser,5,'Epoch');const [owner,...viewers]=room.pages,epochs=[];
 try{
  for(let epoch=0;epoch<4;epoch++){
   await start(owner);await progress(viewers);
   const active=await Promise.all(viewers.map(snapshot));
   expect(active.filter(p=>p.role==='root')).toHaveLength(2);expect(active.filter(p=>p.role==='peer')).toHaveLength(3);
   expect(active.filter(p=>p.role==='peer').every(p=>p.centerBytes===0&&p.peerBytes>0)).toBe(true);
   expect(active.reduce((sum,p)=>sum+p.openConnections,0)).toBe(6);
   await stop(owner);
   await expect.poll(async()=>Promise.all(viewers.map(snapshot)).then(rows=>rows.every(p=>p.openConnections===0))).toBe(true);
   // No stale data can restart the stopped decoder or keep forwarding.
   await expect.poll(async()=>Promise.all(viewers.map(snapshot)).then(rows=>rows.every(p=>p.role==='off'))).toBe(true);
   const stopped=await Promise.all(viewers.map(snapshot));await owner.waitForTimeout(1200);
   expect(await Promise.all(viewers.map(snapshot))).toEqual(stopped);
   epochs.push({epoch:epoch+1,active,stopped});
  }
  await finish(owner);expect(room.errors).toEqual([]);
 }finally{await info.attach('sharing-epochs',{body:JSON.stringify(epochs,null,2),contentType:'application/json'});await room.close()}
});

test('viewer control socket reconnects after a bounded offline interval without manual reload',async({browser},info)=>{
 test.setTimeout(120000);
 const room=await openRoom(browser,2,'Reconnect'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);const before=await snapshot(leaf);
  await room.contexts[2].setOffline(true);
  // Explicitly close the real WSS connection. Offline emulation does not sever UDP;
  // this verifies WSS/re-auth/rejoin, not physical Wi-Fi or ICE recovery.
  await leaf.evaluate(()=>window.relayObservation!.sockets.forEach(socket=>socket.close()));
  await expect.poll(async()=>(await snapshot(leaf)).openConnections).toBe(0);
  await owner.waitForTimeout(3500);await room.contexts[2].setOffline(false);
  await expect(leaf.getByTestId('relay-panel')).toHaveAttribute('data-role','peer',{timeout:30000});
  await progress([root,leaf]);const after=await snapshot(leaf);
  expect(after.openSockets).toBe(1);expect(after.openConnections).toBe(1);expect(after.centerBytes).toBe(0);
  expect(await leaf.evaluate(()=>window.relayObservation!.sockets.length)).toBeGreaterThan(1);
  await info.attach('control-reconnect',{body:JSON.stringify({before,after}),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.contexts[2].setOffline(false);await room.close()}
});


test('received peer bytes cannot hide a stalled decoder, and rendering resumes without reconnecting',async({browser},info)=>{
 test.setTimeout(90000);
 const room=await openRoom(browser,2,'RenderStall'),[owner,root,leaf]=room.pages;
 try{
  await start(owner);await progress([root,leaf]);
  await expect(leaf.getByTestId('actual-quality')).toContainText('fps');
  const before=await snapshot(leaf);
  await leaf.evaluate(()=>{
   const decode=VideoDecoder.prototype.decode;let paused=true;
   VideoDecoder.prototype.decode=function(chunk:EncodedVideoChunk){if(!paused)decode.call(this,chunk)};
   (window as unknown as {resumeDecoder:()=>void}).resumeDecoder=()=>{paused=false;VideoDecoder.prototype.decode=decode};
  });
  // Fault injection pauses decoder submissions only: actual peer transport and
  // the sender remain live. This is not a native-capture or physical-network test.
  await expect(leaf.getByTestId('share-state')).toHaveText('共享已中断',{timeout:12000});
  await expect(leaf.getByTestId('actual-quality')).toHaveText('当前未在共享');
  const stalled=await snapshot(leaf);
  expect(stalled.peerBytes).toBeGreaterThan(before.peerBytes);expect(stalled.centerBytes).toBe(0);
  expect(stalled.openConnections).toBe(1);expect(stalled.connections).toBe(before.connections);
  await progress([root]);
  await leaf.evaluate(()=>(window as unknown as {resumeDecoder:()=>void}).resumeDecoder());
  await progress([root,leaf]);
  await expect(leaf.getByTestId('share-state')).toHaveText('正在共享');
  await expect(leaf.getByTestId('actual-quality')).toContainText('fps');
  const recovered=await snapshot(leaf);
  expect(recovered.centerBytes).toBe(0);expect(recovered.openConnections).toBe(1);expect(recovered.connections).toBe(before.connections);
  await info.attach('render-stall-recovery',{body:JSON.stringify({scope:'Synthetic screen fixture, real local peer data channel, decoder-submission fault injection',before,stalled,recovered},null,2),contentType:'application/json'});
  expect(room.errors).toEqual([]);await finish(owner);
 }finally{await room.close()}
});
