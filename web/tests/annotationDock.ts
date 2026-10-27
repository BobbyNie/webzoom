import {expect,type Page} from '@playwright/test';
export async function openAnnotations(page:Page){const toggle=page.getByRole('button',{name:'展开工具栏',exact:true});if(await toggle.count())await toggle.click()}
export async function annotationPanel(page:Page,name:'笔迹设置'|'更多批注操作'){await openAnnotations(page);const button=page.getByRole('button',{name,exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click()}
export async function expectDockOutsideVideo(page:Page){
 const stage=await page.locator('.screen-stage').boundingBox(),dock=await page.locator('.annotation-toolbar').boundingBox();
 expect(stage).not.toBeNull();expect(dock).not.toBeNull();expect(dock!.y).toBeGreaterThanOrEqual(stage!.y+stage!.height-1);
 expect(await page.locator('.screen-stage .annotation-toolbar').count()).toBe(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
