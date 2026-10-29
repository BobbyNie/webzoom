import {expect,type Browser,type BrowserContext,type Page} from '@playwright/test';
export interface Observation {connections:RTCPeerConnection[];sockets:WebSocket[]}
declare global {interface Window {relayObservation?:Observation}}
export async function login(page:Page,name:string){
 await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();
 await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible();
}
export async function instrument(page:Page,capture=false){
 await page.addInitScript(({capture})=>{
  const observation:Observation=window.relayObservation={connections:[],sockets:[]};
  const NativePeer=window.RTCPeerConnection,NativeSocket=window.WebSocket;
  window.RTCPeerConnection=class extends NativePeer {constructor(config?:RTCConfiguration){super(config);observation.connections.push(this)}};
  window.WebSocket=class extends NativeSocket {constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);observation.sockets.push(this)}};
  navigator.mediaDevices.getUserMedia=async()=>{throw Error('camera/audio forbidden')};
  if(capture)navigator.mediaDevices.getDisplayMedia=async()=>{
   const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
   const ctx=canvas.getContext('2d')!,stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];let frame=0;
   const draw=()=>{if(track.readyState!=='live')return;ctx.fillStyle=frame%60<30?'#008070':'#164866';ctx.fillRect(0,0,1280,720);ctx.fillStyle='white';ctx.font='64px sans-serif';ctx.fillText(`Relay verification ${frame++}`,80,180);requestAnimationFrame(draw)};
   draw();return stream;
  };
 },{capture});
}
export async function snapshot(page:Page){
 return page.evaluate(()=>{
  const panel=document.querySelector<HTMLElement>('[data-testid="relay-panel"]');
  const n=(name:string)=>Number(panel?.getAttribute(`data-${name}-bytes`)??0);
  const observation=window.relayObservation;
  return {role:panel?.dataset.role??'missing',frames:Number(document.querySelector('[data-testid="frames"]')?.textContent??0),centerBytes:n('center'),peerBytes:n('peer'),sentBytes:n('sent'),rejected:Number(panel?.dataset.rejected??0),connections:observation?.connections.length??0,openConnections:observation?.connections.filter(c=>c.connectionState==='connected').length??0,openSockets:observation?.sockets.filter(s=>s.readyState===WebSocket.OPEN).length??0};
 });
}
export async function progress(pages:Page[],timeout=30000){
 const before=await Promise.all(pages.map(snapshot));
 await expect.poll(async()=>{
  const after=await Promise.all(pages.map(snapshot));
  return after.every((v,i)=>v.frames>before[i].frames+2);
 },{timeout,intervals:[500,1000]}).toBe(true);
}
export async function openRoom(browser:Browser,viewers:number,prefix:string,beforeJoin?:()=>void){
 const contexts:BrowserContext[]=[],pages:Page[]=[],errors:string[]=[];
 // Return partial setup only after cleaning it up if login/join fails.
 try{
  for(let i=0;i<=viewers;i++){
   beforeJoin?.();
   const context=await browser.newContext({ignoreHTTPSErrors:true});contexts.push(context);
   const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(`${i}: ${error.message}`));
   await instrument(page,i===0);await login(page,`${prefix}${i}`);
   if(i===0){await page.getByRole('button',{name:'创建会议',exact:true}).click();await expect(page).toHaveURL(/\/m\//);await expect(page.getByRole('button',{name:'关闭本会议分流'})).toBeEnabled()}
   else {await page.goto(pages[0].url());await expect(page.getByTestId('relay-panel')).toBeVisible()}
  }
  await expect(pages[0].getByTestId('relay-member')).toHaveCount(viewers+1);
  return {contexts,pages,errors,close:async()=>{for(const context of contexts)await context.close()}};
 }catch(error){for(const context of contexts)await context.close();throw error}
}
export async function start(owner:Page){await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await expect(owner.getByRole('button',{name:'停止共享',exact:true})).toBeVisible()}
export async function stop(owner:Page){await owner.getByRole('button',{name:'停止共享',exact:true}).click();await expect(owner.getByRole('button',{name:'共享屏幕',exact:true})).toBeVisible()}
export async function finish(owner:Page){await owner.getByRole('button',{name:'结束会议',exact:true}).click();await owner.getByRole('button',{name:'确认结束'}).click()}
