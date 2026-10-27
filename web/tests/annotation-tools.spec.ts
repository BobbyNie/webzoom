import {openAnnotations,annotationPanel,expectDockOutsideVideo} from './annotationDock';
import {test,expect,type Page,type Browser} from '@playwright/test';
async function login(page:Page,name:string){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill(name);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
async function fixture(browser:Browser,prefix:string){
 const contexts=await Promise.all([1,2].map(()=>browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}))),[owner,guest]=await Promise.all(contexts.map(c=>c.newPage()));
 const errors:string[]=[];for(const p of [owner,guest])p.on('pageerror',e=>errors.push(e.message));
 await owner.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d')!;let n=0;const render=()=>{ctx.fillStyle='#153d48';ctx.fillRect(0,0,1280,720);ctx.fillStyle='white';ctx.font='32px sans-serif';ctx.fillText('WebZoom annotation tools '+n++,60,80);requestAnimationFrame(render)};render();return c.captureStream(15)}});
 await login(owner,prefix+'Owner');await owner.getByRole('button',{name:'创建会议',exact:true}).click();await expect(owner).toHaveURL(/\/m\//);const link=owner.url();await owner.getByRole('button',{name:'共享屏幕',exact:true}).click();await login(guest,prefix+'Guest');await guest.goto(link);await expect.poll(async()=>Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
 await expect(owner.getByRole('button',{name:'展开工具栏',exact:true})).toBeVisible();await expect(owner.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);await expectDockOutsideVideo(owner);await openAnnotations(owner);await openAnnotations(guest);
 return {owner,guest,contexts,link,errors,grant:()=>owner.getByRole('button',{name:'允许 '+prefix+'Guest 批注',exact:true}).click(),close:async()=>{for(const c of contexts)await c.close();expect(errors).toEqual([])}};
}
const objects=(p:Page)=>p.getByTestId('annotation-strokes').locator('g[data-stroke-id]');
async function gesture(p:Page,tool='画笔',x=.2,y=.22,ex=.45,ey=.36){
 await p.getByRole('button',{name:tool,exact:true}).click();const b=await p.getByTestId('annotation-surface').boundingBox();if(!b)throw Error('No video');
 const fullscreen=await p.evaluate(()=>!!document.fullscreenElement);const stage=await p.locator('.screen-stage').boundingBox();
 await p.mouse.move(b.x+b.width*x,b.y+b.height*y);await p.mouse.down();await p.mouse.move(b.x+b.width*ex,b.y+b.height*ey,{steps:6});
 if(fullscreen){const during=await p.locator('.screen-stage').boundingBox();expect(during).toEqual(stage)}
 await p.mouse.up();
}


test('local hide/collapse, confirmation, own history and eraser never destroy other users ink',async({browser})=>{
 const f=await fixture(browser,'ToolsHistory');const {owner,guest}=f;
 try{
  await f.grant();await gesture(owner);await owner.getByRole('button',{name:'画笔',exact:true}).hover();await expect(owner.getByRole('button',{name:'画笔',exact:true})).toHaveCSS('background-color','rgb(8, 127, 106)');await expect(owner.getByRole('button',{name:'画笔',exact:true})).toHaveCSS('color','rgb(255, 255, 255)');await expect(objects(guest)).toHaveCount(1);await gesture(guest,'矩形');await expect(objects(owner)).toHaveCount(2);
  await guest.getByRole('button',{name:'隐藏批注',exact:true}).click();await expect(guest.getByTestId('annotation-strokes')).toHaveAttribute('visibility','hidden');await expect(owner.getByTestId('annotation-strokes')).not.toHaveAttribute('visibility','hidden');await expect(objects(owner)).toHaveCount(2);
  await guest.getByRole('button',{name:'显示批注',exact:true}).click();await guest.getByRole('button',{name:'画笔',exact:true}).click();await guest.getByRole('button',{name:'收起工具栏',exact:true}).click();await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);await guest.getByRole('button',{name:'展开工具栏',exact:true}).click();await expect(guest.getByRole('button',{name:'观看',exact:true})).toHaveAttribute('aria-pressed','true');
  await annotationPanel(guest,'更多批注操作');await guest.getByRole('button',{name:'清除我的',exact:true}).click();await expect(guest.getByRole('alertdialog')).toBeVisible();await expect(objects(owner)).toHaveCount(2);await guest.getByRole('button',{name:'取消',exact:true}).click();await expect(objects(owner)).toHaveCount(2);
  await guest.getByRole('button',{name:'撤销',exact:true}).click();await expect(objects(owner)).toHaveCount(1);await guest.getByRole('button',{name:'重做',exact:true}).click();await expect(objects(owner)).toHaveCount(2);
  await guest.getByRole('button',{name:'橡皮擦',exact:true}).click();let b=await guest.getByTestId('annotation-surface').boundingBox();await guest.mouse.click(b!.x+b!.width*.2,b!.y+b!.height*.28);await expect(objects(owner)).toHaveCount(1);
  await guest.getByRole('button',{name:'撤销',exact:true}).click();await expect(objects(owner)).toHaveCount(2);
  await annotationPanel(guest,'更多批注操作');await guest.getByRole('button',{name:'清除我的',exact:true}).click();await guest.getByRole('button',{name:'确认清除',exact:true}).click();await expect(objects(owner)).toHaveCount(1);await expect(owner.getByRole('button',{name:'撤销',exact:true})).toBeEnabled();
  await owner.getByRole('button',{name:'撤销',exact:true}).click();await expect(objects(guest)).toHaveCount(0);
 }finally{await f.close()}
});

test('all new shapes, styles, escaped text, temporary ink and late join synchronize',async({browser})=>{
 const f=await fixture(browser,'ToolsShapes');const {owner,guest}=f;
 try{
  await annotationPanel(owner,'笔迹设置');await owner.getByLabel('批注颜色',{exact:true}).selectOption('#7c3aed');await owner.getByLabel('批注笔宽',{exact:true}).selectOption('6');
  for(const tool of ['直线','箭头','矩形','圆形','荧光笔'])await gesture(owner,tool);
  await expect(objects(guest)).toHaveCount(5);await expect(guest.getByTestId('annotation-strokes').locator('rect')).toHaveAttribute('stroke','#7c3aed');await expect(guest.getByTestId('annotation-strokes').locator('rect')).toHaveAttribute('stroke-width','6');await expect(guest.getByTestId('annotation-strokes').locator('ellipse')).toHaveCount(1);await expect(guest.getByTestId('annotation-strokes').locator('g[opacity="0.32"]')).toHaveCount(1);
  await owner.getByRole('button',{name:'文字',exact:true}).click();const b=await owner.getByTestId('annotation-surface').boundingBox();await owner.mouse.click(b!.x+b!.width*.15,b!.y+b!.height*.45);await owner.getByLabel('批注文字',{exact:true}).fill('<script>你好</script>');await owner.getByLabel('批注文字',{exact:true}).press('Control+z');await expect(objects(guest)).toHaveCount(5);await owner.getByLabel('批注文字',{exact:true}).fill('<script>你好</script>');await owner.getByRole('button',{name:'添加文字',exact:true}).click();await expect(guest.getByTestId('annotation-strokes').locator('text')).toHaveText('<script>你好</script>');await expect(guest.locator('.annotation-surface script')).toHaveCount(0);
  await gesture(owner,'临时笔');await expect(objects(guest)).toHaveCount(7);await expect(objects(guest)).toHaveCount(6,{timeout:8000});
  const lateContext=await browser.newContext({ignoreHTTPSErrors:true});f.contexts.push(lateContext);const late=await lateContext.newPage();await login(late,'ToolsShapesLate');await late.goto(f.link);await expect(objects(late)).toHaveCount(6);await expect(late.getByTestId('annotation-strokes').locator('text')).toHaveText('<script>你好</script>');
  await owner.screenshot({path:'test-results/annotation-tools-desktop.png',fullPage:true});
 }finally{await f.close()}
});

test('focus, zoom, read-only panning, docked toolbar/resize, fullscreen and shortcuts remain usable',async({browser})=>{
 const f=await fixture(browser,'ToolsViewing');const {owner,guest}=f;
 try{
  await owner.getByRole('button',{name:'专注观看',exact:true}).click();await expect(owner.locator('.participants-panel')).toBeHidden();await owner.getByRole('button',{name:'显示参与者',exact:true}).click();
  for(let i=0;i<4;i++)await owner.getByRole('button',{name:'放大画面',exact:true}).click();await expect(owner.getByLabel('画面缩放比例')).toHaveText('200%');
  await gesture(owner,'箭头',.3,.3,.4,.4);await expect(objects(guest)).toHaveCount(1);const points=await owner.getByTestId('annotation-strokes').locator('line').evaluate(e=>[e.getAttribute('x1'),e.getAttribute('y1'),e.getAttribute('x2'),e.getAttribute('y2')]);expect(points.map(Number)).toEqual([300,300,400,400]);
  await guest.getByRole('button',{name:'放大画面',exact:true}).click();await guest.getByRole('button',{name:'拖动画面',exact:true}).click();const b=await guest.locator('.screen-stage').boundingBox();await guest.mouse.move(b!.x+b!.width*.4,b!.y+b!.height*.3);await guest.mouse.down();await guest.mouse.move(b!.x+b!.width*.45,b!.y+b!.height*.35);await guest.mouse.up();await expect(guest.locator('.screen-canvas')).not.toHaveCSS('transform','matrix(1.25, 0, 0, 1.25, 0, 0)');await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);
  await owner.getByRole('button',{name:'适应窗口',exact:true}).click();await owner.getByRole('button',{name:'观看',exact:true}).click();await owner.locator('.screen-stage').click({position:{x:80,y:60}});await owner.keyboard.press('p');await expect(owner.getByRole('button',{name:'画笔',exact:true})).toHaveAttribute('aria-pressed','true');await owner.keyboard.press('Escape');await expect(owner.getByRole('button',{name:'观看',exact:true})).toHaveAttribute('aria-pressed','true');
  await expectDockOutsideVideo(owner);await owner.screenshot({path:'test-results/annotation-dock-desktop.png',fullPage:true});
  await owner.getByRole('button',{name:'隐藏批注',exact:true}).click();await owner.getByRole('button',{name:'收起工具栏',exact:true}).click();await expect(owner.locator('.annotation-hidden-note')).toHaveCount(0);await expect(owner.locator('.annotation-toolbar button')).toHaveCount(1);await expect(objects(owner)).toHaveCount(1);await expectDockOutsideVideo(owner);await owner.screenshot({path:'test-results/annotation-dock-collapsed.png',fullPage:true});
  await owner.getByRole('button',{name:'展开工具栏',exact:true}).click();await owner.getByRole('button',{name:'显示批注',exact:true}).click();
  await owner.setViewportSize({width:390,height:844});await expect(owner.getByRole('button',{name:'展开工具栏',exact:true})).toBeVisible();await expectDockOutsideVideo(owner);await openAnnotations(owner);await expectDockOutsideVideo(owner);await owner.screenshot({path:'test-results/annotation-tools-mobile.png',fullPage:true});await owner.getByRole('button',{name:'收起工具栏',exact:true}).click();
  await owner.setViewportSize({width:1440,height:1000});await owner.getByRole('button',{name:'展开工具栏',exact:true}).click();await owner.getByRole('button',{name:'全屏观看',exact:true}).click();await expect.poll(()=>owner.evaluate(()=>!!document.fullscreenElement)).toBe(true);await gesture(owner,'直线');await expect(objects(guest)).toHaveCount(2);await expectDockOutsideVideo(owner);await owner.screenshot({path:'test-results/annotation-dock-fullscreen.png'});await annotationPanel(owner,'更多批注操作');await expectDockOutsideVideo(owner);await owner.getByRole('button',{name:'更多批注操作',exact:true}).press('Escape');await expect(owner.getByRole('group',{name:'更多批注选项',exact:true})).toHaveCount(0);await expect(owner.getByRole('button',{name:'更多批注操作',exact:true})).toBeFocused();await owner.getByRole('button',{name:'结束会议',exact:true}).click();await expect.poll(()=>owner.evaluate(()=>!!document.fullscreenElement)).toBe(false);await expect(owner.getByRole('dialog',{name:'结束这场会议？',exact:true})).toBeVisible();await owner.getByRole('button',{name:'取消',exact:true}).click();await expect(objects(guest)).toHaveCount(2);
 }finally{await f.close()}
});

test('permission revoke cancels a text draft, blocks edits, and export stays off by default',async({browser})=>{
 const f=await fixture(browser,'ToolsPermissions');const {owner,guest}=f;
 try{
  await f.grant();await guest.getByRole('button',{name:'文字',exact:true}).click();const b=await guest.getByTestId('annotation-surface').boundingBox();await guest.mouse.click(b!.x+b!.width*.2,b!.y+b!.height*.2);await guest.getByLabel('批注文字',{exact:true}).fill('unsent');
  owner.once('dialog',d=>d.accept());await owner.getByRole('button',{name:'收回所有批注权限',exact:true}).click();await expect(guest.getByLabel('批注文字',{exact:true})).toHaveCount(0);await expect(guest.getByRole('button',{name:'画笔',exact:true})).toHaveCount(0);await guest.keyboard.press('p');await expect(objects(owner)).toHaveCount(0);await expect(guest.getByRole('button',{name:'申请批注',exact:true})).toBeVisible();
  await annotationPanel(owner,'更多批注操作');await annotationPanel(guest,'更多批注操作');await expect(owner.getByRole('button',{name:'保存截图',exact:true})).toHaveCount(0);await expect(guest.getByRole('button',{name:'保存截图',exact:true})).toHaveCount(0);
 }finally{await f.close()}
});


test('a small touch screen can choose a tool and draw without the toolbar covering the whole image',async({browser})=>{
 const f=await fixture(browser,'ToolsTouch');const touchContext=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});const touch=await touchContext.newPage();
 try{
  await login(touch,'TouchArtist');await touch.goto(f.link);await expect.poll(async()=>Number(await touch.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await f.owner.getByRole('button',{name:'允许 TouchArtist 批注',exact:true}).click();await touch.getByRole('button',{name:'展开工具栏',exact:true}).tap();await touch.getByRole('button',{name:'文字',exact:true}).tap();await expect(touch.getByRole('button',{name:'文字',exact:true})).toHaveAttribute('aria-pressed','true');await touch.getByRole('button',{name:'画笔',exact:true}).tap();
  await expect(touch.getByRole('button',{name:'画笔',exact:true})).toHaveCSS('background-color','rgb(8, 127, 106)');
  const box=await touch.getByTestId('annotation-surface').boundingBox(),toolbar=await touch.locator('.annotation-toolbar').boundingBox();expect(toolbar!.y).toBeGreaterThanOrEqual(box!.y+box!.height-1);await expectDockOutsideVideo(touch);
  const x=box!.x+box!.width*.2,y=box!.y+box!.height*.1;expect(y).toBeLessThan(toolbar!.y);
  const session=await touchContext.newCDPSession(touch);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=5;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+i*8,y:y+i*2}]});
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect(objects(f.owner)).toHaveCount(1);await expect(objects(f.guest)).toHaveCount(1);
  await touch.screenshot({path:'test-results/annotation-tools-touch.png',fullPage:true});await session.detach();
 }finally{await touchContext.close();await f.close()}
});
