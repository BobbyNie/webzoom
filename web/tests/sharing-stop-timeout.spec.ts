import {test,expect} from '@playwright/test';

test('a timed-out stop falls back and its late HTTP request cannot stop the next share',async({page})=>{
 await page.addInitScript(()=>{
  navigator.mediaDevices.getDisplayMedia=async()=>{
   const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
   const context=canvas.getContext('2d')!;let frame=0;
   const stream=canvas.captureStream(15),timer=setInterval(()=>{
    if(stream.getVideoTracks()[0].readyState!=='live'){clearInterval(timer);return}
    context.fillStyle=++frame%2?'#007c70':'#164866';context.fillRect(0,0,640,360);
   },66);return stream;
  };
 });
 await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();
 await page.getByLabel('用户名').fill('StopDeadline');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'创建会议',exact:true}).click();
 await expect(page.getByText('已连接',{exact:true})).toBeVisible();
 const roomID=new URL(page.url()).pathname.slice(3);
 await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
 await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
 let release!:()=>void,arrived!:()=>void,status=0;
 const held=new Promise<void>(resolve=>{release=resolve}),requested=new Promise<void>(resolve=>{arrived=resolve});
 await page.route(`**/api/rooms/${roomID}/actions`,async route=>{
  if(route.request().postDataJSON()?.action!=='stop'){await route.continue();return}
  arrived();await held;const response=await route.fetch();status=response.status();
  await route.fulfill({response}).catch(()=>{});
 });
 try{
  const started=Date.now();await page.getByRole('button',{name:'停止共享',exact:true}).click();await requested;
  await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeEnabled({timeout:6000});
  expect(Date.now()-started).toBeGreaterThanOrEqual(1800);
  expect((await(await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  const current=await(await page.request.get(`/api/rooms/${roomID}`)).json();
  release();await expect.poll(()=>status).toBe(409);
  const after=await(await page.request.get(`/api/rooms/${roomID}`)).json();
  expect(after.epoch).toBe(current.epoch);expect(after.active).toBe(true);
  await expect.poll(async()=>Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
 }finally{release()}
});
