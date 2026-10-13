import {test,expect,type Page} from '@playwright/test';
const identity={user:{id:'admin',name:'Admin'},csrf:'csrf',expiresAt:new Date(Date.now()+3600000).toISOString()};
const makeRoom=(id:string)=>({id,active:true,participants:3,createdAt:'2026-10-12T00:00:00Z',expiresAt:'2026-10-12T08:00:00Z',ingressBytes:1,egressBytes:2});
const initial={instanceId:'one',sampledAt:'2026-10-12T00:00:00Z',startedAt:'2026-10-11T00:00:00Z',ingressBytes:1,egressBytes:2,rooms:['room-one','room-two','room-kept'].map(makeRoom)};
async function mockIdentity(page:Page){await page.route('**/api/me',r=>r.fulfill({json:identity}))}
test('admin bulk end requires selection and confirmation and ends only the selection',async({page})=>{
 await mockIdentity(page);
 let rooms=initial.rooms;const submissions:string[][]=[];
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...initial,rooms}}));
 await page.route('**/api/admin/rooms/end',r=>{
  expect(r.request().method()).toBe('POST');expect(r.request().headers()['x-csrf-token']).toBe('csrf');
  const ids=r.request().postDataJSON().roomIds as string[];submissions.push(ids);
  rooms=rooms.filter(room=>!ids.includes(room.id));
  return r.fulfill({json:{results:ids.map(id=>({id,status:'ended'}))}});
 });
 await page.goto('/admin');
 const end=page.getByRole('button',{name:'批量结束会议',exact:true});
 await expect(end).toBeDisabled();await page.getByLabel('选择会议 room-one',{exact:true}).check();
 await end.click();const dialog=page.getByRole('dialog');
 await expect(dialog).toContainText('所有参与者将断开连接');await expect(dialog).toContainText('room-one');
 await dialog.getByRole('button',{name:'取消',exact:true}).click();expect(submissions).toEqual([]);
 await end.click();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();expect(submissions).toEqual([]);
 await page.getByLabel('全选当前会议',{exact:true}).check();await expect(page.getByText('已选择 3 场会议。',{exact:true})).toBeVisible();
 await page.getByLabel('全选当前会议',{exact:true}).uncheck();await expect(end).toBeDisabled();
 await page.getByLabel('选择会议 room-one',{exact:true}).check();await page.getByLabel('选择会议 room-two',{exact:true}).check();
 await end.click();await dialog.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('已结束 2 场');
 expect(submissions).toEqual([['room-one','room-two']]);
 await expect(page.getByRole('row').filter({hasText:'room-kept'})).toBeVisible();
 await expect(page.getByTestId('room-count')).toHaveText('1');await expect(end).toBeDisabled();
});
test('admin selection never expands on polling and stale confirmation is cancelled',async({page})=>{
 await page.clock.install();await mockIdentity(page);
 let rooms=initial.rooms,instanceId='one';
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...initial,rooms,instanceId}}));
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 rooms=[...rooms,makeRoom('room-new')];await page.clock.runFor(6000);
 await expect(page.getByLabel('选择会议 room-new',{exact:true})).not.toBeChecked();
 await expect(page.getByText('已选择 3 场会议。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).not.toContainText('room-new');
 rooms=rooms.filter(r=>r.id!=='room-one');await page.clock.runFor(6000);
 await expect(dialog).not.toBeVisible();await expect(page.getByText('已选择 2 场会议。',{exact:true})).toBeVisible();
 instanceId='restarted';await page.clock.runFor(6000);
 await expect(page.getByRole('button',{name:'批量结束会议',exact:true})).toBeDisabled();
});
test('admin bulk batches use renewed CSRF and prevent duplicate submission while busy',async({page})=>{
 await page.clock.install();
 await page.route('**/api/me',r=>r.fulfill({json:{...identity,expiresAt:new Date(Date.now()+9000).toISOString()}}));
 let renewals=0;
 await page.route('**/auth/refresh',r=>{renewals++;return r.fulfill({json:{...identity,csrf:'renewed-csrf',expiresAt:new Date(Date.now()+3600000).toISOString()}})});
 const rooms=Array.from({length:101},(_,i)=>makeRoom(`room-${i}`));
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...initial,rooms}}));
 const submissions:{ids:string[];csrf:string}[]=[];let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});
 await page.route('**/api/admin/rooms/end',async r=>{
  const ids=r.request().postDataJSON().roomIds as string[];
  submissions.push({ids,csrf:r.request().headers()['x-csrf-token']});
  if(submissions.length===1)await gate;
  return r.fulfill({json:{results:ids.map(id=>({id,status:'ended'}))}});
 });
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('heading')).toBeInViewport();
 await expect(page.getByRole('button',{name:'确认结束选定会议',exact:true})).toBeInViewport();
 await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect.poll(()=>submissions.length).toBe(1);
 await expect(page.getByRole('button',{name:'正在结束…',exact:true})).toBeDisabled();
 await expect(page.getByLabel('全选当前会议',{exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toBeVisible();
 await page.clock.runFor(4000);await expect.poll(()=>renewals).toBe(1);
 release();await expect.poll(()=>submissions.length).toBe(2);
 expect(submissions.map(s=>s.ids.length)).toEqual([100,1]);
 expect(submissions.map(s=>s.csrf)).toEqual(['csrf','renewed-csrf']);
 await expect(page.getByRole('status')).toContainText('已结束 101 场');
});
test('admin batch timeout reports confirmed and uncertain results without stopping later rooms',async({page})=>{
 await page.clock.install();await mockIdentity(page);
 let rooms=Array.from({length:201},(_,i)=>makeRoom(`room-${i}`)),calls=0;
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...initial,rooms}}));
 await page.route('**/api/admin/rooms/end',r=>{
  calls++;if(calls===2)return;
  const ids=r.request().postDataJSON().roomIds as string[];
  rooms=rooms.filter(room=>!ids.includes(room.id));
  return r.fulfill({json:{results:ids.map(id=>({id,status:'ended'}))}});
 });
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();
 await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect.poll(()=>calls).toBe(2);await page.clock.runFor(16000);
 await expect(page.getByRole('alert')).toContainText('已结束 100 场');
 await expect(page.getByRole('alert')).toContainText('结果未确认 101 场');
 expect(calls).toBe(2);await expect(page.getByTestId('room-count')).toHaveText('101');
 await page.getByText('查看逐项结果',{exact:true}).click();
 await expect(page.getByRole('listitem').filter({hasText:'room-200：结果未确认'})).toBeVisible();
});
for(const status of [401,403])test(`admin mutation ${status} clears selection, dialog and metrics`,async({page})=>{
 await mockIdentity(page);await page.route('**/api/admin/overview',r=>r.fulfill({json:initial}));
 await page.route('**/api/admin/rooms/end',r=>r.fulfill({status,body:'denied'}));
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();
 await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText(status===401?'登录已失效':'没有管理员权限');
 await expect(page.getByRole('table')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText('room-one',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'批量结束会议',exact:true})).toHaveCount(0);
});
test('admin individual results distinguish ended and already absent meetings',async({page})=>{
 await mockIdentity(page);let rooms=initial.rooms;
 await page.route('**/api/admin/overview',r=>r.fulfill({json:{...initial,rooms}}));
 await page.route('**/api/admin/rooms/end',r=>{rooms=[makeRoom('room-kept')];return r.fulfill({json:{results:[{id:'room-one',status:'ended'},{id:'room-two',status:'not_found'}]}})});
 await page.goto('/admin');for(const id of ['room-one','room-two'])await page.getByLabel(`选择会议 ${id}`,{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('已结束 1 场；已结束或已过期 1 场；结果未确认 0 场');
 await page.getByText('查看逐项结果',{exact:true}).click();
 await expect(page.getByRole('listitem').filter({hasText:'room-one：已结束'})).toBeVisible();
 await expect(page.getByRole('listitem').filter({hasText:'room-two：已结束或已过期'})).toBeVisible();
});
test('real administrator ends other users selected meetings and disconnects participants',async({browser,page})=>{
 const ownerContext=await browser.newContext({ignoreHTTPSErrors:true}),viewerContext=await browser.newContext({ignoreHTTPSErrors:true});
 const owner=await ownerContext.newPage(),viewer=await viewerContext.newPage();
 const login=async(p:Page,name:string)=>{await p.goto('/');await p.getByRole('link',{name:'使用公司账号登录'}).click();await p.getByLabel('用户名').fill(name);await p.getByRole('button',{name:'登录',exact:true}).click();await expect(p.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()};
 try{
  await login(owner,'AdminBatchOwner');
  const identity=await (await owner.request.get('/api/me')).json(),origin=new URL(owner.url()).origin;
  const headers={'X-CSRF-Token':identity.csrf,Origin:origin};
  const rooms=[];
  for(let i=0;i<3;i++){
   const res=await owner.request.post('/api/rooms',{headers,data:{}});expect(res.status()).toBe(201);rooms.push(await res.json());
  }
  const denied=await owner.request.post('/api/admin/rooms/end',{headers,data:{roomIds:[rooms[0].id]}});expect(denied.status()).toBe(403);
  await owner.goto(`/m/${rooms[0].id}`);await login(viewer,'AdminBatchViewer');await viewer.goto(`/m/${rooms[0].id}`);
  await expect(viewer.getByText('已连接',{exact:true})).toHaveText('已连接');
  await page.goto('/admin');await page.getByRole('link',{name:'使用 SSO 登录'}).click();
  await page.getByLabel('用户名').fill('TestAdmin');await page.getByRole('button',{name:'登录',exact:true}).click();
  for(const room of rooms.slice(0,2))await page.getByLabel(`选择会议 ${room.id}`,{exact:true}).check();
  await page.getByRole('button',{name:'批量结束会议',exact:true}).click();await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已结束 2 场');
  await expect(owner.getByText('会议已结束或已过期。',{exact:true})).toBeVisible();
  await expect(viewer.getByText('会议已结束或已过期。',{exact:true})).toBeVisible();
  for(const room of rooms.slice(0,2))expect((await viewer.request.get(`/api/rooms/${room.id}`)).status()).toBe(404);
  expect((await viewer.request.get(`/api/rooms/${rooms[2].id}`)).status()).toBe(200);
  await expect(page.getByRole('row').filter({hasText:rooms[2].id})).toBeVisible();
  const renewed=await (await owner.request.get('/api/me')).json();
  await owner.request.post(`/api/rooms/${rooms[2].id}/actions`,{headers:{...headers,'X-CSRF-Token':renewed.csrf},data:{action:'end'}});
 }finally{await ownerContext.close();await viewerContext.close()}
});
test('temporary overview failure cancels pending confirmation and clears its selection',async({page})=>{
 await page.clock.install();await mockIdentity(page);let failing=false;
 await page.route('**/api/admin/overview',r=>failing?r.fulfill({status:503}):r.fulfill({json:initial}));
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();
 failing=true;await page.clock.runFor(6000);await expect(page.getByRole('dialog')).not.toBeVisible();
 await expect(page.getByRole('table')).toHaveCount(0);
 failing=false;await page.clock.runFor(6000);
 await expect(page.getByRole('button',{name:'批量结束会议',exact:true})).toBeDisabled();
});
test('admin expiry while a batch is pending prevents all later batches',async({page})=>{
 await page.clock.install();await mockIdentity(page);let denied=false,calls=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve});
 const rooms=Array.from({length:101},(_,i)=>makeRoom(`room-${i}`));
 await page.route('**/api/admin/overview',r=>denied?r.fulfill({status:401}):r.fulfill({json:{...initial,rooms}}));
 await page.route('**/api/admin/rooms/end',async r=>{
  calls++;await gate;
  await r.fulfill({json:{results:r.request().postDataJSON().roomIds.map((id:string)=>({id,status:'ended'}))}}).catch(()=>{});
 });
 await page.goto('/admin');await page.getByLabel('全选当前会议',{exact:true}).check();
 await page.getByRole('button',{name:'批量结束会议',exact:true}).click();await page.getByRole('button',{name:'确认结束选定会议',exact:true}).click();
 await expect.poll(()=>calls).toBe(1);denied=true;await page.clock.runFor(6000);
 await expect(page.getByRole('link',{name:'使用 SSO 登录'})).toBeVisible();
 release();await page.clock.runFor(16000);
 await expect(page.getByRole('table')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);expect(calls).toBe(1);
});
