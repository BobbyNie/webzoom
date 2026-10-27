import {annotationPanel} from './annotationDock';
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
test('explicitly enabled export confirms and saves a real PNG, honoring local hidden annotations',async({page},testInfo)=>{
 test.skip(process.env.ANNOTATION_EXPORT_ENABLED!=='true','Downloads are opt-in; exercised in a dedicated enabled-policy run.');
 await page.addInitScript(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d')!;const render=()=>{ctx.fillStyle='#153d48';ctx.fillRect(0,0,1280,720);requestAnimationFrame(render)};render();return c.captureStream(15)}});
 await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill('ExportPolicyOwner');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'创建会议',exact:true}).click();await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
 await annotationPanel(page,'笔迹设置');await page.getByLabel('批注颜色',{exact:true}).selectOption('#7c3aed');await page.getByLabel('批注笔宽',{exact:true}).selectOption('6');await page.getByRole('button',{name:'矩形',exact:true}).click();const b=await page.getByTestId('annotation-surface').boundingBox();await page.mouse.move(b!.x+b!.width*.2,b!.y+b!.height*.22);await page.mouse.down();await page.mouse.move(b!.x+b!.width*.45,b!.y+b!.height*.36);await page.mouse.up();await expect(page.getByTestId('annotation-strokes').locator('rect')).toHaveCount(1);await annotationPanel(page,'更多批注操作');await expect(page.getByRole('button',{name:'保存截图',exact:true})).toBeEnabled();
 for(const hidden of [false,true]){
  if(hidden)await page.getByRole('button',{name:'隐藏批注',exact:true}).click();
  page.once('dialog',d=>d.accept());const promise=page.waitForEvent('download');await page.getByRole('button',{name:'保存截图',exact:true}).click();const download=await promise;expect(download.suggestedFilename()).toMatch(/^webzoom-.*\.png$/);const path=testInfo.outputPath(hidden?'hidden.png':'annotations.png');await download.saveAs(path);const bytes=await readFile(path);expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  const data=await page.evaluate(async base64=>{const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d')!;ctx.drawImage(image,0,0);return {width:image.width,height:image.height,pixel:Array.from(ctx.getImageData(256,200,1,1).data)}},bytes.toString('base64'));
  expect(data.width).toBe(1280);expect(data.height).toBe(720);expect(data.pixel).toEqual(hidden?[21,61,72,255]:[124,58,237,255]);
 }
});
