import {test,expect,chromium} from '@playwright/test';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// This exercises real Chrome -> real native EXE framing and actionable errors.
// The fixture selects 0.0.0.0 (never a real adapter), so no UDP socket or broadcast starts.
test('real native process self-check and meeting failure are delivered through MV3',async()=>{
 const host=process.env.WEBZOOM_TEST_NATIVE_HOST;
 if(!host||!/^com\.webzoom\.lan_test_[a-f0-9]{32}$/.test(host)) throw Error('Run scripts/Test-LanNativeBridge.ps1 to provision the isolated test host.');
 const origin='https://127.0.0.1:8743';
 const base=path.resolve('../artifacts/native-browser');await mkdir(base,{recursive:true});
 const temp=await mkdtemp(path.join(base,'run-')),extension=path.join(temp,'extension');
 await cp(path.resolve('../clients/chrome'),extension,{recursive:true});
 const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
 manifest.content_scripts=[{matches:['https://127.0.0.1/m/*'],js:['content.js'],run_at:'document_start',all_frames:false}];
 await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
 await writeFile(path.join(extension,'policy.js'),'export const origin = '+JSON.stringify(origin)+';');
 for(const file of ['background.js','diagnostic-client.js']) {
  const script=await readFile(path.join(extension,file),'utf8');
  await writeFile(path.join(extension,file),script.replaceAll("'com.webzoom.lan'",JSON.stringify(host)));
 }
 const context=await chromium.launchPersistentContext(path.join(temp,'profile'),{channel:'chromium',headless:true,ignoreHTTPSErrors:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
 try{
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  expect(worker.url()).toContain('hmeoffkckocfjcblblfhpmjcighdehfa/background.js');
  const popup=await context.newPage();await popup.goto(new URL('popup.html',worker.url()).href);
  await popup.getByRole('button',{name:'检查安装和网络'}).click();
  await expect(popup.getByRole('status')).toContainText('找不到安装时选择的唯一网卡');
  await expect(popup.getByRole('status')).toContainText('不要自行关闭公司 VPN');
  const page=await context.newPage();await page.addInitScript(()=>sessionStorage.setItem('webzoom-lan','true'));
  await page.goto(origin);await page.getByRole('link',{name:'使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill('LAN-native-process');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'创建会议',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'局域网客户端停止'})).toContainText('获批网卡不可用');
  await expect(page.getByRole('checkbox',{name:/使用局域网/})).toBeChecked();
 }finally{await context.close()}
});
