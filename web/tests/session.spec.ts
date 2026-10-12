import {test,expect,type Page} from '@playwright/test';
const room={id:'renew-test',ownerId:'host',publisherId:'host',epoch:1,active:true,quality:0,participants:[{id:'host',name:'Host'},{id:'viewer',name:'Viewer'}]};
async function viewer(page:Page,status=200){
 let sockets=0,refreshes=0;
 await page.clock.install();
 await page.route('**/api/me',r=>r.fulfill({json:{user:{id:'viewer',name:'Viewer'},csrf:'test-csrf',expiresAt:new Date(Date.now()+9000).toISOString()}}));
 await page.route('**/api/rooms/renew-test',r=>r.fulfill({json:room}));
 await page.routeWebSocket('**/api/rooms/renew-test/ws',ws=>{sockets++;ws.send(JSON.stringify({type:'room',room}))});
 await page.route('**/auth/refresh',async r=>{
  refreshes++;expect(r.request().method()).toBe('POST');expect(r.request().headers()['x-csrf-token']).toBe('test-csrf');
  await r.fulfill(status===200?{json:{user:{id:'viewer',name:'Viewer'},csrf:'test-csrf',expiresAt:new Date(Date.now()+300000).toISOString()}}:{status,body:'refresh failed'});
 });
 await page.goto('/m/renew-test');await expect(page.getByText('你正在以听众身份参与')).toBeVisible();
 await expect(page.getByText('已连接',{exact:true})).toBeVisible();
 return {sockets:()=>sockets,refreshes:()=>refreshes};
}
test('passive viewer renews login without reopening the media connection',async({page})=>{
 const state=await viewer(page);await page.clock.runFor(4000);
 await expect.poll(state.refreshes).toBe(1);
 await page.clock.runFor(7000);
 expect(state.sockets()).toBe(1);
 await expect(page.getByText('已连接',{exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'使用公司账号登录'})).not.toBeVisible();
});
test('refresh rejection stops media and asks the user to log in',async({page})=>{
 await viewer(page,401);await page.clock.runFor(4000);
 await expect(page.getByRole('link',{name:'使用公司账号登录'})).toBeVisible();
 await expect(page.getByRole('alert')).toContainText('登录已过期');
});
test('temporary identity provider failure is visible without immediate logout',async({page})=>{
 await viewer(page,503);await page.clock.runFor(4000);
 await expect(page.getByRole('status')).toContainText('登录续期暂时失败');
 await expect(page.getByText('已连接',{exact:true})).toBeVisible();
});
