import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Real MV3/content-script/native-host lookup, but no native registration or UDP.
test('packaged MV3 loads and missing native installation fails closed', async () => {
  const origin = 'https://127.0.0.1:8743';
  const artifacts = path.resolve('../artifacts/extension-browser');
  await mkdir(artifacts, { recursive: true });
  const temp = await mkdtemp(path.join(artifacts, 'run-'));
  const extension = path.join(temp, 'extension');
  await cp(path.resolve('../clients/chrome'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // Chrome match patterns do not contain ports; background.js checks exact origin.
  manifest.content_scripts = [{ matches: ['https://127.0.0.1/m/*'], js: ['content.js'], run_at: 'document_start', all_frames: false }];
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(extension, 'policy.js'), 'export const origin = ' + JSON.stringify(origin) + ';');
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    expect(worker.url()).toContain('hmeoffkckocfjcblblfhpmjcighdehfa/background.js');
    const popup = await context.newPage();
    await popup.goto(new URL('popup.html', worker.url()).href);
    await popup.getByRole('button', { name: '检查安装和网络' }).click();
    await expect(popup.getByRole('status')).toContainText('尚未安装辅助程序');
    const page = await context.newPage();
    await page.addInitScript(() => sessionStorage.setItem('webzoom-lan', 'true'));
    await page.goto(origin);
    await page.getByRole('link', { name: '使用公司账号登录' }).click();
    await page.getByLabel('用户名').fill('LAN-real-extension');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '创建会议', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '局域网客户端停止' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /使用局域网/ })).toBeChecked();
  } finally {
    await context.close();
  }
});
