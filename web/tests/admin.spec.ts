import {test, expect} from '@playwright/test';
const identity={user:{id:'admin',name:'Admin'},csrf:'csrf',expiresAt:new Date(Date.now()+3600000).toISOString()};
const overview={instanceId:'one',sampledAt:'2026-10-12T00:00:00Z',startedAt:'2026-10-11T00:00:00Z',ingressBytes:1000000,egressBytes:2000000,rooms:[{id:'room-one',active:true,participants:3,createdAt:'2026-10-12T00:00:00Z',expiresAt:'2026-10-12T08:00:00Z',ingressBytes:1000000,egressBytes:2000000}]};
test('independent admin overview polls traffic and clears data on forbidden response',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({json:identity}));
 let calls=0, forbidden=false;
 await page.route('**/api/admin/overview',r=>{
  calls++;
  return forbidden?r.fulfill({status:403,body:'forbidden'}):r.fulfill({json:{...overview,sampledAt:calls===1?overview.sampledAt:'2026-10-12T00:00:05Z',egressBytes:calls===1?2000000:7000000}});
 });
 await page.goto('/admin');
 await expect(page.getByRole('heading',{name:'管理员总览'})).toBeVisible();
 await expect(page.getByTestId('room-count')).toHaveText('1');
 await expect(page.getByRole('row').filter({hasText:'room-one'})).toContainText('3');
 await expect(page.getByTestId('egress-rate')).toHaveText('8.00 Mbps',{timeout:10000});
 forbidden=true;
 await expect(page.getByRole('alert')).toContainText('没有管理员权限',{timeout:10000});
 await expect(page.getByText('room-one')).toHaveCount(0);
});
test('admin login returns to admin and anonymous access has no meeting data',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({status:401,body:'login required'}));
 await page.goto('/admin');
 await expect(page.getByRole('link',{name:'使用 SSO 登录'})).toHaveAttribute('href','/auth/login?next=%2Fadmin');
 await expect(page.getByRole('table')).toHaveCount(0);
});
test('empty overview and temporary error do not show stale metrics',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({json:identity}));
 let fail=false;
 await page.route('**/api/admin/overview',r=>fail?r.fulfill({status:503}):r.fulfill({json:{...overview,rooms:[]}}));
 await page.goto('/admin');
 await expect(page.getByText('当前没有有效会议。')).toBeVisible();
 fail=true;
 await expect(page.getByRole('alert')).toContainText('无法更新总览',{timeout:10000});
 await expect(page.getByTestId('room-count')).toHaveCount(0);
 fail=false;
 await expect(page.getByText('当前没有有效会议。')).toBeVisible({timeout:10000});
});
test('admin visible page renews session and clears overview on expiry',async({page})=>{
 await page.clock.install();
 await page.route('**/api/me',r=>r.fulfill({json:{...identity,expiresAt:new Date(Date.now()+9000).toISOString()}}));
 await page.route('**/api/admin/overview',r=>r.fulfill({json:overview}));
 let renewals=0;
 await page.route('**/auth/refresh',r=>{
  renewals++;expect(r.request().headers()['x-csrf-token']).toBe(identity.csrf);
  return r.fulfill({status:401,body:'expired'});
 });
 await page.goto('/admin');
 await expect(page.getByTestId('room-count')).toHaveText('1');
 await page.clock.runFor(4000);
 await expect.poll(()=>renewals).toBe(1);
 await expect(page.getByRole('link',{name:'使用 SSO 登录'})).toBeVisible();
 await expect(page.getByRole('table')).toHaveCount(0);
});
test('admin polling recovers after a request timeout',async({page})=>{
 await page.clock.install();
 await page.route('**/api/me',r=>r.fulfill({json:identity}));
 let calls=0;
 await page.route('**/api/admin/overview',r=>{calls++;if(calls>1)return r.fulfill({json:overview})});
 await page.goto('/admin');
 await expect.poll(()=>calls).toBe(1);
 await page.clock.runFor(16000);
 await expect(page.getByRole('alert')).toContainText('无法更新总览');
 await page.clock.runFor(6000);
 await expect(page.getByTestId('room-count')).toHaveText('1');
});
test('real OIDC login returns to admin and backend enforces configured subjects',async({page})=>{
 await page.goto('/admin');
 await page.getByRole('link',{name:'使用 SSO 登录'}).click();
 await page.getByLabel('用户名').fill('TestAdmin');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page).toHaveURL(/\/admin$/);
 await expect(page.getByTestId('room-count')).toBeVisible();
 const me=await (await page.request.get('/api/me')).json();
 const created=await page.request.post('/api/rooms',{headers:{'X-CSRF-Token':me.csrf,Origin:new URL(page.url()).origin},data:{}});
 expect(created.status()).toBe(201);
 const room=await created.json();
 await expect(page.getByRole('row').filter({hasText:room.id})).toContainText('未共享',{timeout:10000});
 await page.request.post('/api/rooms/'+room.id+'/actions',{headers:{'X-CSRF-Token':me.csrf,Origin:new URL(page.url()).origin},data:{action:'end'}});
 await expect(page.getByRole('row').filter({hasText:room.id})).toHaveCount(0,{timeout:10000});
});
