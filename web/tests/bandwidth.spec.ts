import {test,expect,type Page} from '@playwright/test';
const identity={user:{id:'admin',name:'Admin'},csrf:'initial-csrf',expiresAt:new Date(Date.now()+3600000).toISOString()};
const bandwidth={limitMbps:200,totalMbps:12.5,blocked:false,windowSeconds:5};
const overview={instanceId:'one',sampledAt:'2026-10-13T00:00:00Z',startedAt:'2026-10-13T00:00:00Z',ingressBytes:0,egressBytes:0,rooms:[],bandwidth};
async function mock(page:Page){await page.route('**/api/me',r=>r.fulfill({json:identity}));await page.route('**/api/admin/overview',r=>r.fulfill({json:overview}))}

test('admin saves persistent limit and sees immediate server admission state',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await mock(page);let calls=0;
 await page.route('**/api/admin/bandwidth',r=>{calls++;expect(r.request().headers()['x-csrf-token']).toBe(identity.csrf);expect(r.request().postDataJSON()).toEqual({limitMbps:10});return r.fulfill({json:{...bandwidth,limitMbps:10,blocked:true}})});
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...overview,bandwidth:calls?{...bandwidth,limitMbps:10,blocked:true}:bandwidth}}));
 await page.goto('/admin');const panel=page.getByRole('region',{name:'总流量接入限制'});
 await expect(panel.getByLabel('总流量上限（Mbps）')).toHaveValue('200');await expect(panel).toContainText('12.50 Mbps');await expect(panel).toContainText('允许接入');
 await panel.getByLabel('总流量上限（Mbps）').fill('10');await panel.getByRole('button',{name:'保存上限'}).click();
 await expect(panel).toContainText('已保存，立即生效。服务重启后保留此设置。');await expect(panel).toContainText('暂停新建会议和新连接');expect(calls).toBe(1);
 await page.reload();await expect(page.getByLabel('总流量上限（Mbps）')).toHaveValue('10');
 expect(errors).toEqual([]);await page.screenshot({path:'../artifacts/bandwidth-admin.png',fullPage:true});
});

test('polling preserves unsaved draft, hides stale rate and resets on instance change',async({page})=>{
 await page.clock.install();await mock(page);let fail=false,instanceId='one';
 await page.route('**/api/admin/overview',r=>fail?r.fulfill({status:503}):r.fulfill({json:{...overview,instanceId}}));
 await page.goto('/admin');const input=page.getByLabel('总流量上限（Mbps）');await input.fill('350');await page.clock.runFor(6000);await expect(input).toHaveValue('350');
 fail=true;await page.clock.runFor(6000);await expect(input).toHaveValue('350');await expect(page.getByRole('button',{name:'保存上限'})).toBeDisabled();await expect(page.getByTestId('total-bandwidth-rate')).toHaveText('无法获取当前流量');
 fail=false;instanceId='two';await page.clock.runFor(6000);await expect(input).toHaveValue('200');
});

test('invalid limits never submit and failed storage does not claim success',async({page})=>{
 await mock(page);let calls=0;await page.route('**/api/admin/bandwidth',r=>{calls++;return r.fulfill({status:503,body:'cannot save bandwidth configuration'})});
 await page.goto('/admin');const panel=page.getByRole('region',{name:'总流量接入限制'});
 for(const value of ['','0','-1','1.5','1000001']){await panel.getByLabel('总流量上限（Mbps）').fill(value);await panel.getByRole('button',{name:'保存上限'}).click();await expect(panel.getByRole('alert')).toContainText('1 至 1000000 的整数')}
 expect(calls).toBe(0);await panel.getByLabel('总流量上限（Mbps）').fill('250');await panel.getByRole('button',{name:'保存上限'}).click();
 await expect(panel.getByRole('alert')).toContainText('无法确认保存结果');await expect(panel.getByRole('status')).toHaveCount(0);expect(calls).toBe(1);
});

for(const status of [401,403])test(`setting denial ${status} clears administrator data`,async({page})=>{
 await mock(page);await page.route('**/api/admin/bandwidth',r=>r.fulfill({status}));await page.goto('/admin');await page.getByRole('button',{name:'保存上限'}).click();
 await expect(page.getByRole('region',{name:'总流量接入限制'})).toHaveCount(0);await expect(page.getByTestId('room-count')).toHaveCount(0);await expect(page.getByRole('alert')).toContainText(status===401?'登录已失效':'没有管理员权限');
});

test('setting timeout recovers and duplicate submissions are blocked',async({page})=>{
 await page.clock.install();await mock(page);let calls=0;await page.route('**/api/admin/bandwidth',r=>{calls++;if(calls>1)return r.fulfill({json:bandwidth})});
 await page.goto('/admin');const button=page.getByRole('button',{name:'保存上限'});await button.click();await expect(page.getByRole('button',{name:'正在保存…'})).toBeDisabled();await expect.poll(()=>calls).toBe(1);
 await page.clock.runFor(16000);await expect(page.getByRole('region',{name:'总流量接入限制'}).getByRole('alert')).toContainText('无法确认保存结果');await expect(button).toBeEnabled();await button.click();
 await expect(page.getByText('已保存，立即生效。服务重启后保留此设置。')).toBeVisible();expect(calls).toBe(2);
});

test('bandwidth save uses renewed CSRF token',async({page})=>{
 await page.clock.install();await mock(page);await page.route('**/api/me',r=>r.fulfill({json:{...identity,expiresAt:new Date(Date.now()+9000).toISOString()}}));let renewed=false;
 await page.route('**/auth/refresh',r=>{renewed=true;return r.fulfill({json:{...identity,csrf:'renewed-csrf',expiresAt:new Date(Date.now()+3600000).toISOString()}})});
 await page.route('**/api/admin/bandwidth',r=>{expect(r.request().headers()['x-csrf-token']).toBe('renewed-csrf');return r.fulfill({json:bandwidth})});
 await page.goto('/admin');await expect(page.getByLabel('总流量上限（Mbps）')).toBeVisible();await page.clock.runFor(4000);await expect.poll(()=>renewed).toBe(true);await page.getByRole('button',{name:'保存上限'}).click();
 await expect(page.getByText('已保存，立即生效。服务重启后保留此设置。')).toBeVisible();
});

test('creation explains bandwidth denial without showing a load-test limit',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({json:identity}));await page.route('**/api/rooms',r=>r.request().method()==='GET'?r.fulfill({json:[]}):r.fulfill({status:503,headers:{'X-WebZoom-Error':'bandwidth_limit'},body:'bandwidth limit exceeded'}));
 await page.goto('/');await page.getByRole('button',{name:'创建会议',exact:true}).click();await expect(page.getByRole('alert')).toContainText('总媒体流量已超过上限');await expect(page.getByRole('alert')).not.toContainText('压力测试');
});

test('waiting for bandwidth does not exhaust reconnection attempts and resumes',async({page})=>{
 await page.clock.install();await page.route('**/api/me',r=>r.fulfill({json:identity}));let denied=true,calls=0;
 await page.route('**/api/rooms/bandwidth-room',r=>{calls++;return denied?r.fulfill({status:503,headers:{'X-WebZoom-Error':'bandwidth_limit'},body:'bandwidth limit exceeded'}):r.fulfill({json:{id:'bandwidth-room',ownerId:'other',publisherId:'other',participants:[],active:false,epoch:0,quality:0,createdAt:'2026-10-13T00:00:00Z',expiresAt:'2026-10-13T08:00:00Z'}})});
 await page.routeWebSocket(/\/api\/rooms\/bandwidth-room\/ws(?:\?.*)?$/,()=>{});await page.goto('/m/bandwidth-room');await expect(page.getByText('总媒体流量已超过上限。暂不允许创建会议或接入会议。')).toBeVisible();
 for(let i=0;i<10;i++){await page.clock.runFor(5001);await expect.poll(()=>calls).toBe(i+2)}
 await expect(page.getByText('会议已结束',{exact:true})).toHaveCount(0);denied=false;await page.clock.runFor(5001);await expect(page.getByText('已连接',{exact:true})).toBeVisible();await expect(page.getByText('总媒体流量已超过上限。暂不允许创建会议或接入会议。')).toHaveCount(0);
});
