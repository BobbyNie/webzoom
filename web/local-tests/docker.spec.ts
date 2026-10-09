import {test, expect, type Page} from '@playwright/test';
import {trackCreatedMeetings} from './support/meeting-cleanup';

async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await expect(page).toHaveURL(/\/idp\/realms\/webzoom-local\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('Local-demo-only-2026!');
  await page.locator('#kc-login').click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
}

async function syntheticScreen(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {captureOptions?: DisplayMediaStreamOptions};
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      w.captureOptions = options;
      const canvas = document.createElement('canvas');
      canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d')!;
      let frame = 0;
      setInterval(() => {
        ctx.fillStyle = ++frame % 60 < 30 ? '#008070' : '#164866';
        ctx.fillRect(0, 0, 1920, 1080);
        ctx.fillStyle = 'white'; ctx.font = '64px sans-serif';
        ctx.fillText(`WebZoom local Docker / frame ${frame}`, 80, 200);
      }, 33);
      return canvas.captureStream(30);
    };
    navigator.mediaDevices.getUserMedia = async () => {throw new Error('audio/camera forbidden');};
    Object.defineProperty(window, 'RTCPeerConnection', {value: class {
      constructor() {throw new Error('WebRTC forbidden');}
    }});
  });
}

test('real Keycloak login and Docker WSS share, transfer and stop', async ({browser}) => {
  const options = {baseURL: 'https://webzoom.localhost:8443', ignoreHTTPSErrors: true};
  const hostContext = await browser.newContext(options);
  const viewerContext = await browser.newContext(options);
  const host = await hostContext.newPage(), viewer = await viewerContext.newPage();
  const cleanup = await trackCreatedMeetings(host);
  const errors: string[] = [], urls: string[] = [], sockets: string[] = [];
  for (const page of [host, viewer]) {
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => urls.push(r.url()));
    page.on('websocket', ws => sockets.push(ws.url()));
    await syntheticScreen(page);
  }
  try {
    await login(host, 'alice');
    await host.getByRole('button', {name: '创建会议', exact: true}).click();
    await expect(host).toHaveURL(/\/m\//);
    const link = host.url();
    await host.getByRole('button', {name: '共享屏幕', exact: true}).click();
    await expect(host.getByTestId('share-state')).toHaveText('正在共享');
    await login(viewer, 'bob');
    await viewer.goto(link);
    await expect.poll(async () => Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(10);
    await expect(viewer.locator('canvas')).not.toHaveClass(/hidden/);
    await viewer.screenshot({path: '../artifacts/local/docker-viewer.png', fullPage: true});
    await viewer.getByRole('button', {name: '全屏观看', exact: true}).click();
    await expect(viewer.getByRole('button', {name: '退出全屏', exact: true})).toBeVisible();
    expect(await viewer.evaluate(() => document.fullscreenElement?.className)).toBe('stage-panel');
    const beforeFullscreenFrames = Number(await viewer.getByTestId('frames').textContent());
    await expect.poll(async () => Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(beforeFullscreenFrames + 10);
    await viewer.screenshot({path: '../artifacts/local/docker-viewer-fullscreen.png'});
    await viewer.getByRole('button', {name: '退出全屏', exact: true}).click();
    await expect.poll(() => viewer.evaluate(() => document.fullscreenElement === null)).toBe(true);
    expect(await host.evaluate(() => (window as unknown as {captureOptions: DisplayMediaStreamOptions}).captureOptions.audio)).toBe(false);
    await host.getByLabel('共享者').selectOption({label: 'Bob Local Demo'});
    await host.getByRole('button', {name: '转交共享权'}).click();
    await expect(viewer.getByRole('button', {name: '共享屏幕', exact: true})).toBeEnabled();
    await viewer.getByRole('button', {name: '共享屏幕', exact: true}).click();
    await expect.poll(async () => Number(await host.getByTestId('frames').textContent())).toBeGreaterThan(10);
    await viewer.getByRole('button', {name: '停止共享', exact: true}).click();
    await expect(host.getByTestId('share-state')).toHaveText('等待共享');
    await expect(host.locator('canvas')).toHaveClass(/hidden/);
    expect(errors).toEqual([]);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.every(u => u.startsWith('wss://webzoom.localhost:8443/'))).toBe(true);
    expect(urls.every(u => u.startsWith('https://webzoom.localhost:8443/'))).toBe(true);
    console.log(JSON.stringify({realKeycloak: true, dockerProxy: true, decodedFrames: true, audio: false, requests: urls.length, sockets: sockets.length}));
  } finally {
    try {await cleanup();} finally {await hostContext.close(); await viewerContext.close();}
  }
});

test('anonymous access is denied and browser capture cancellation stays idle', async ({page}) => {
  const cleanup = await trackCreatedMeetings(page);
  try {
    const response = await page.request.get('/api/me');
    expect(response.status()).toBe(401);
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {throw new DOMException('cancelled', 'NotAllowedError');};
    });
    await login(page, 'alice');
    await page.getByRole('button', {name: '创建会议', exact: true}).click();
    await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
    await expect(page.getByRole('alert')).toContainText('授权已取消');
    await expect(page.getByTestId('share-state')).toHaveText('等待共享');
  } finally {await cleanup();}
});
