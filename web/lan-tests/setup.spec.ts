import {test,expect,type Page} from '@playwright/test';
async function login(page:Page){await page.goto('/');await page.getByRole('link',{name:'使用公司账号登录'}).click();await page.getByLabel('用户名').fill('LAN-setup');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'创建会议',exact:true})).toBeVisible()}
const info={enabled:true,available:true,origin:'https://approved.example',port:34567,sha256:'a'.repeat(64)};
test('first visit shows internal download and exact installation steps, no automatic download',async({page})=>{
 let downloads=0;await page.route('**/api/lan/client',route=>route.fulfill({json:info}));await page.route('**/api/lan/client/setup.exe',route=>{downloads++;return route.fulfill({contentType:'application/octet-stream',headers:{'Content-Disposition':'attachment; filename="WebZoom-LAN-Setup.exe"'},body:'MZ-test'})});
 await login(page);await expect(page.getByRole('link',{name:'① 下载 Windows 安装程序'})).toHaveAttribute('href','/api/lan/client/setup.exe');
 await expect(page.getByText('尚未连接到 Chrome 插件，请按下面步骤完成安装。')).toBeVisible({timeout:10000});expect(downloads).toBe(0);
 await expect(page.getByRole('button',{name:'启用局域网分流',exact:true})).toBeDisabled();
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'① 下载 Windows 安装程序'}).click();const saved=await download;expect(saved.suggestedFilename()).toBe('WebZoom-LAN-Setup.exe');expect(await saved.failure()).toBeNull();expect(downloads).toBe(1);
 await expect(page.getByText(/下载已请求/)).toBeVisible();await expect(page.getByText(/加载已解压的扩展程序/)).toBeVisible();
});
test('automatically checks installation without entering LAN or claiming broadcast success',async({page})=>{
 await page.route('**/api/lan/client',route=>route.fulfill({json:info}));
 await page.addInitScript(()=>window.addEventListener('message',event=>{const v=event.data;if(v?.source==='webzoom-lan-setup-page-v1')window.postMessage({source:'webzoom-lan-setup-extension-v1',channel:v.channel,message:{type:'diagnostic',ok:true,port:34567,code:'local_ready',protocol:1,broadcastVerified:false}},location.origin)}));
 await login(page);await expect(page.getByText('本机安装检查通过。多人广播还需要在会议中验证。')).toBeVisible();await expect(page.getByRole('button',{name:'启用局域网分流',exact:true})).toBeEnabled();expect(await page.evaluate(()=>sessionStorage.getItem('webzoom-lan'))).toBeNull();
});
test('missing approved port is an administrator action, not a per-user guessing form',async({page})=>{
 await page.route('**/api/lan/client',route=>route.fulfill({json:{...info,available:false,port:0,reason:'port_not_configured'}}));await login(page);await expect(page.getByRole('alert').filter({hasText:'管理员还没有统一配置'})).toBeVisible();await expect(page.getByRole('link',{name:'① 下载 Windows 安装程序'})).toHaveCount(0);
});
