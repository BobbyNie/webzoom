import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
async function capture(page:Page,surface:string){await page.addInitScript((surface)=>{
 navigator.mediaDevices.getDisplayMedia=async()=>{
  const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d')!;
  function draw(){ctx.fillStyle='#164866';ctx.fillRect(0,0,1920,1080);requestAnimationFrame(draw)}draw();
  const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];const original=track.getSettings.bind(track);
  track.getSettings=()=>({...original(),displaySurface:surface,width:1920,height:1080});return stream;
 };
},surface)}
test('presenter pairs a monitor, can revoke, and never exposes helper controls to guests',async({browser})=>{
 const a=await browser.newContext({ignoreHTTPSErrors:true}),b=await browser.newContext({ignoreHTTPSErrors:true});const owner=await a.newPage(),guest=await b.newPage();
 try{
  await capture(owner,'monitor');await login(owner,'OverlayOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await owner.getByRole('button',{name:'生成助手配对信息',exact:true}).click();
  await expect(owner.getByLabel(/一次性配对信息/)).toHaveValue(/^https:\/\/[^/]+\/#webzoom-overlay=[A-Za-z0-9_-]{43}$/);
  await expect(owner.getByLabel(/一次性配对信息/)).toHaveAttribute('type','password');
  await login(guest,'OverlayGuest');await guest.goto(link);await expect.poll(async()=>Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await expect(guest.getByRole('region',{name:'原屏幕批注助手'})).toHaveCount(0);
  await owner.getByRole('button',{name:'断开批注助手',exact:true}).click();await expect(owner.getByLabel(/一次性配对信息/)).toHaveCount(0);
  await owner.getByRole('button',{name:'停止共享',exact:true}).click();await expect(owner.getByRole('region',{name:'原屏幕批注助手'})).toHaveCount(0);
 }finally{await a.close();await b.close()}
});
test('tab capture cannot enable a desktop overlay',async({page})=>{
 await capture(page,'browser');await login(page,'OverlayTabOwner');await page.getByRole('button',{name:'创建会议',exact:true}).click();await expect(page).toHaveURL(/\/m\//);
 await page.getByRole('button',{name:'共享屏幕',exact:true}).click();await expect(page.getByText(/当前不是整屏共享/)).toBeVisible();await expect(page.getByRole('button',{name:'生成助手配对信息'})).toHaveCount(0);
});
