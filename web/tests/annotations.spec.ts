import {test,expect,type Page} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
async function fakeScreen(page:Page){await page.addInitScript(()=>{
 navigator.mediaDevices.getDisplayMedia=async()=>{const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d')!;let n=0;function draw(){ctx.fillStyle='#164866';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#fff';ctx.font='60px sans-serif';ctx.fillText('Annotation meeting '+n++,120,180);requestAnimationFrame(draw)}draw();return canvas.captureStream(30)};
})}
async function draw(page:Page){
 await page.getByRole('button',{name:'画笔',exact:true}).click();
 const surface=page.getByTestId('annotation-surface');const box=await surface.boundingBox();if(!box||box.width<1)throw new Error('missing video rectangle');
 await page.mouse.move(box.x+box.width*.25,box.y+box.height*.35);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.45,{steps:12});await page.mouse.up();
}
const strokes=(page:Page)=>page.getByTestId('annotation-strokes').locator('polyline,circle');

test('owner grants annotation; strokes, identity pointer, late join and clear synchronize',async({browser})=>{
 const contexts=await Promise.all([1,2,3].map(()=>browser.newContext({ignoreHTTPSErrors:true})));
 const [owner,guest,late]=await Promise.all(contexts.map(c=>c.newPage()));const errors:string[]=[];
 const traffic:string[]=[];for(const p of [owner,guest,late]){p.on('pageerror',e=>errors.push(e.message));p.on('websocket',ws=>{const record=(direction:string,payload:string|Buffer)=>{if(typeof payload==='string'&&payload.includes('annotation'))traffic.push(direction+':'+payload)};ws.on('framesent',event=>record('framesent',event.payload));ws.on('framereceived',event=>record('framereceived',event.payload))})}
 try{
  await fakeScreen(owner);await login(owner,'AnnotationOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await login(guest,'AnnotationGuest');await guest.goto(link);await expect.poll(async()=>Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);
  await owner.getByRole('button',{name:'允许 AnnotationGuest 批注',exact:true}).click();
  await draw(guest);await expect(strokes(owner)).toHaveCount(1);await expect(strokes(guest)).toHaveCount(1);
  // A completed stroke must not block the next gesture while its acknowledgement is already present.
  await draw(guest);await expect(strokes(owner)).toHaveCount(2);
  await guest.getByRole('button',{name:'指示光标',exact:true}).click();const box=await guest.getByTestId('annotation-surface').boundingBox();
  await guest.mouse.move(box!.x+box!.width*.6,box!.y+box!.height*.3);
  await expect(owner.getByTestId('annotation-pointer')).toContainText('AnnotationGuest');await owner.screenshot({path:'test-results/annotations-pointer.png',fullPage:true});
  await login(late,'AnnotationLate');await late.goto(link);await expect(strokes(late)).toHaveCount(2);
  await draw(owner);await expect(strokes(late)).toHaveCount(3);
  await guest.getByRole('button',{name:'清除我的',exact:true}).click();await expect(strokes(owner)).toHaveCount(1);await expect(strokes(late)).toHaveCount(1);
  await owner.screenshot({path:'test-results/annotations-owner.png',fullPage:true});
  await owner.getByRole('button',{name:'清除全部',exact:true}).click();await expect(strokes(guest)).toHaveCount(0);await expect(strokes(late)).toHaveCount(0);
  await owner.getByRole('button',{name:'撤销 AnnotationGuest 批注',exact:true}).click();await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);
  await expect(errors).toEqual([]);
 }catch(error){console.log('ANNOTATION TRACE',traffic.slice(-25));console.log('PAGE ERRORS',errors);await guest.screenshot({path:'test-results/annotations-debug-guest.png',fullPage:true});throw error}finally{for(const c of contexts)await c.close()}
});

test('annotations work in fullscreen; new share clears strokes without granting publisher annotation',async({browser})=>{
 const c1=await browser.newContext({ignoreHTTPSErrors:true}),c2=await browser.newContext({ignoreHTTPSErrors:true});const owner=await c1.newPage(),guest=await c2.newPage();
 try{
  await fakeScreen(owner);await fakeScreen(guest);await login(owner,'FullscreenAnnotationOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await login(guest,'FullscreenAnnotationGuest');await guest.goto(link);await expect.poll(async()=>Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await owner.getByRole('button',{name:'全屏观看',exact:true}).click();await expect.poll(()=>owner.evaluate(()=>!!document.fullscreenElement)).toBe(true);
  await draw(owner);await expect(strokes(guest)).toHaveCount(1);
  await owner.getByRole('button',{name:'退出全屏',exact:true}).click();await expect.poll(()=>owner.evaluate(()=>!!document.fullscreenElement)).toBe(false);
  await owner.getByLabel('共享者', {exact:true}).selectOption('FullscreenAnnotationGuest');await owner.getByRole('button',{name:'转交共享权'}).click();
  await expect(guest.getByTestId('share-state')).toHaveText('等待共享');await guest.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect.poll(async()=>Number(await owner.getByTestId('frames').textContent())).toBeGreaterThan(0);await expect(strokes(owner)).toHaveCount(0);
  await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);await expect(owner.getByRole('button',{name:'画笔',exact:true})).toBeVisible();
 }finally{await c1.close();await c2.close()}
});


test('a finished stroke does not block the next gesture while draw acknowledgements are delayed',async({browser})=>{
 const c1=await browser.newContext({ignoreHTTPSErrors:true}),c2=await browser.newContext({ignoreHTTPSErrors:true});
 const owner=await c1.newPage(),guest=await c2.newPage();let releaseAcknowledgements=()=>{};
 await guest.routeWebSocket(/\/api\/rooms\/[^/]+\/ws$/,socket=>{
  const server=socket.connectToServer();const pending:(string|Buffer)[]=[];let hold=true;
  server.onMessage(message=>{
   if(hold&&typeof message==='string'){
    const event=JSON.parse(message);
    if(event.type==='annotation'&&event.annotation?.kind==='draw'){pending.push(message);return}
   }
   socket.send(message);
  });
  socket.onMessage(message=>server.send(message));
  releaseAcknowledgements=()=>{hold=false;for(const message of pending)socket.send(message);pending.length=0};
 });
 try{
  await fakeScreen(owner);await login(owner,'DelayedAnnotationOwner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();
  await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await login(guest,'DelayedAnnotationGuest');await guest.goto(link);
  await expect.poll(async()=>Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await owner.getByRole('button',{name:'允许 DelayedAnnotationGuest 批注',exact:true}).click();
  await draw(guest);await expect(strokes(owner)).toHaveCount(1);await expect(strokes(guest)).toHaveCount(0);
  await draw(guest);await expect(strokes(owner)).toHaveCount(2);await expect(strokes(guest)).toHaveCount(0);
  await expect(guest.getByTestId('annotation-pending').locator('polyline,circle')).toHaveCount(2);
  // Hold all echoes: accepted gestures remain bounded instead of silently dropping or growing forever.
  for(let i=0;i<6;i++)await draw(guest);
  await expect(strokes(owner)).toHaveCount(8);await draw(guest);
  await expect(guest.getByRole('status')).toHaveText('网络确认较慢，请稍候再绘制。');
  await expect(guest.getByTestId('annotation-pending').locator('polyline,circle')).toHaveCount(8);
  releaseAcknowledgements();await expect(strokes(guest)).toHaveCount(8);
  await expect(guest.getByTestId('annotation-pending').locator('polyline,circle')).toHaveCount(0);
  await draw(guest);await expect(strokes(owner)).toHaveCount(9);await expect(strokes(guest)).toHaveCount(9);
 }finally{await c1.close();await c2.close()}
});
