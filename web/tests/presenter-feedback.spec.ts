import {testBuild} from '../src/testBuild';
import {test, expect, type Page} from '@playwright/test';

async function login(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill(name);
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
}
async function capture(page: Page, surface = 'browser') {
  await page.addInitScript(surface => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d')!;
      function draw() {
        ctx.fillStyle = '#164866'; ctx.fillRect(0, 0, 1920, 1080);
        ctx.fillStyle = '#fff'; ctx.font = '60px sans-serif'; ctx.fillText('WebZoom feedback test', 100, 150);
        requestAnimationFrame(draw);
      }
      draw();
      const stream = canvas.captureStream(30), track = stream.getVideoTracks()[0];
      const original = track.getSettings.bind(track);
      track.getSettings = () => ({...original(), displaySurface: surface, width: 1920, height: 1080});
      return stream;
    };
  }, surface);
}
async function start(page: Page, name: string, surface = 'browser') {
  await capture(page, surface); await login(page, name);
  await page.getByRole('button', {name: '创建会议', exact: true}).click();
  await expect(page).toHaveURL(/\/m\//);
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '打开反馈小窗'})).toBeEnabled();
}
async function open(page: Page) {
  const event = page.context().waitForEvent('page');
  await page.getByRole('button', {name: '打开反馈小窗'}).click();
  const pip = await event; await pip.setViewportSize({width: 720, height: 520});
  await expect(pip.getByRole('button', {name: '完整画面', exact: true})).toBeVisible();
  return pip;
}
// A click handler deliberately destroys its own Document PiP target. Chromium
// can report that destruction before Playwright receives the input ACK on Linux.
// Accept only that exact close race; the caller still checks the owner/server
// outcome. Timeouts, detached elements, and unrelated action errors must fail.
async function clickClosingWindow(pip: Page, name: string) {
  const closed = pip.waitForEvent('close');
  await Promise.all([closed, pip.getByRole('button', {name, exact: true}).click().catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes('Target page, context or browser has been closed') || !pip.isClosed()) throw error;
  })]);
}
async function draw(page: Page) {
  await page.getByRole('button', {name: '画笔', exact: true}).click();
  const box = (await page.getByTestId('annotation-surface').boundingBox())!;
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, {steps: 6});
  await page.mouse.up();
}

test('native Document PiP shows remote strokes and named pointers, supports zoom, clears and closes safely', async ({browser}, testInfo) => {
  const a = await browser.newContext({ignoreHTTPSErrors: true}), b = await browser.newContext({ignoreHTTPSErrors: true});
  const owner = await a.newPage(), guest = await b.newPage();
  const errors: string[] = []; let mediaConnections = 0;
  owner.on('websocket', socket => { if (/\/api\/rooms\/[^/]+\/ws$/.test(socket.url())) mediaConnections++; });
  owner.on('pageerror', e => errors.push(e.message));
  try {
    await start(owner, 'FeedbackOwner');
    await expect(owner.getByTestId('test-build')).toContainText(testBuild.version);
    await login(guest, 'FeedbackGuest'); await guest.goto(owner.url());
    await expect.poll(async () => Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
    await expect(guest.getByRole('region', {name: '共享者反馈小窗'})).toHaveCount(0);
    await expect(owner.getByRole('region', {name: '原屏幕批注助手'})).toHaveCount(0);
    await owner.getByRole('button', {name: '允许 FeedbackGuest 批注', exact: true}).click();
    const pip = await open(owner); pip.on('pageerror', e => errors.push(e.message));
    await expect.poll(() => pip.getByTestId('feedback-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1920);
    await draw(guest);
    await expect(pip.getByTestId('feedback-strokes').locator('polyline')).toHaveCount(1);
    await guest.getByRole('button', {name: '指示光标', exact: true}).click();
    const box = (await guest.getByTestId('annotation-surface').boundingBox())!;
    await guest.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
    await expect(pip.getByTestId('feedback-pointer')).toHaveText('FeedbackGuest');
    const stage = (await pip.getByTestId('feedback-content').boundingBox())!;
    const dot = (await pip.locator('.feedback-laser').boundingBox())!;
    expect(Math.abs(dot.x + dot.width / 2 - (stage.x + stage.width * .7))).toBeLessThan(3);
    expect(Math.abs(dot.y + dot.height / 2 - (stage.y + stage.height * .4))).toBeLessThan(3);
    await pip.screenshot({path: testInfo.outputPath('feedback-overview.png')});
    await pip.getByRole('button', {name: '跟随指示 ×2', exact: true}).click();
    await expect(pip.getByLabel('放大区域在原画面中的位置')).toBeVisible();
    await pip.screenshot({path: testInfo.outputPath('feedback-focus.png')});
    await pip.setViewportSize({width: 360, height: 400});
    await pip.screenshot({path: testInfo.outputPath('feedback-small.png')});
    await pip.getByRole('button', {name: '仅标注', exact: true}).click();
    await expect(pip.getByTestId('feedback-video')).toHaveCount(0);
    await expect(pip.getByText('共享屏幕位置示意 · 不含业务画面')).toBeVisible();
    await expect(pip.getByTestId('feedback-strokes').locator('polyline')).toHaveCount(1);
    await owner.getByRole('button', {name: '清除全部', exact: true}).click();
    await expect(pip.getByTestId('feedback-strokes').locator('polyline')).toHaveCount(0);
    await owner.getByRole('button', {name: '撤销 FeedbackGuest 批注', exact: true}).click();
    await expect(guest.getByRole('button', {name: '画笔', exact: true})).toHaveCount(0);
    await expect(pip.getByTestId('feedback-pointer')).toHaveCount(0);
    await clickClosingWindow(pip, '关闭反馈小窗');
    await expect.poll(() => pip.isClosed()).toBe(true);
    await expect(owner.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
    await expect(owner.getByRole('button', {name: '打开反馈小窗'})).toBeEnabled();
    const reopened = await open(owner);
    expect(mediaConnections).toBe(1);
    const stopped = owner.waitForResponse(response => response.url().endsWith('/actions') && response.request().postDataJSON()?.action === 'stop');
    await clickClosingWindow(reopened, '停止共享');
    const response = await stopped;
    expect(response.ok()).toBe(true);
    expect((await response.json()).active).toBe(false);
    await expect.poll(() => reopened.isClosed()).toBe(true);
    await expect(owner.getByRole('button', {name: '共享屏幕', exact: true})).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await a.close(); await b.close(); }
});

test('whole-screen capture warns about recapture and provides a video-free mode', async ({page}) => {
  await start(page, 'FeedbackMonitor', 'monitor');
  await expect(page.getByText(/整屏共享可能把小窗也拍进去/)).toBeVisible();
  const pip = await open(page);
  await expect(pip.getByText(/整屏可能拍入此窗/)).toBeVisible();
  await pip.getByRole('button', {name: '仅标注', exact: true}).click();
  await expect(pip.getByTestId('feedback-video')).toHaveCount(0);
  await page.getByRole('button', {name: '停止共享', exact: true}).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
});

test('unsupported browsers retain sharing without a fake always-on-top popup', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', {value: undefined, configurable: true}));
  await capture(page); await login(page, 'FeedbackUnsupported');
  await page.getByRole('button', {name: '创建会议', exact: true}).click(); await expect(page).toHaveURL(/\/m\//);
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '打开反馈小窗'})).toBeDisabled();
  await expect(page.getByText(/当前浏览器或策略不支持置顶网页小窗/)).toBeVisible();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
});

test('PiP rejection is recoverable and does not stop screen sharing', async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', {value: {requestWindow: async () => {throw new DOMException('policy', 'NotAllowedError');}}, configurable: true}));
  await start(page, 'FeedbackRejected');
  await page.getByRole('button', {name: '打开反馈小窗'}).click();
  await expect(page.getByRole('alert')).toContainText('小窗未能打开');
  await expect(page.getByRole('button', {name: '打开反馈小窗'})).toBeEnabled();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
});

test('ending the meeting closes the native PiP window', async ({page}) => {
  await start(page, 'FeedbackEnd'); const pip = await open(page);
  await page.getByRole('button', {name: '结束会议', exact: true}).click();
  await page.getByRole('button', {name: '确认结束', exact: true}).click();
  await expect.poll(() => pip.isClosed()).toBe(true);
});


test('transfer removes feedback access from the old presenter; the new presenter can open it', async ({browser}) => {
  const a = await browser.newContext({ignoreHTTPSErrors: true}), b = await browser.newContext({ignoreHTTPSErrors: true});
  try {
    const owner = await a.newPage(), guest = await b.newPage();
    await start(owner, 'FeedbackTransferOwner'); const pip = await open(owner);
    await capture(guest); await login(guest, 'FeedbackTransferGuest'); await guest.goto(owner.url());
    await expect.poll(async () => Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
    await owner.getByLabel('共享者', {exact: true}).selectOption('FeedbackTransferGuest');
    await owner.getByRole('button', {name: '转交共享权', exact: true}).click();
    await expect.poll(() => pip.isClosed()).toBe(true);
    await expect(owner.getByRole('region', {name: '共享者反馈小窗'})).toHaveCount(0);
    await guest.getByRole('button', {name: '共享屏幕', exact: true}).click();
    const next = await open(guest);
    await expect(next.getByRole('button', {name: '完整画面'})).toBeVisible();
    await expect(guest.getByRole('button', {name: '画笔', exact: true})).toHaveCount(0);
  } finally { await a.close(); await b.close(); }
});

test('a disconnected presenter cannot retain a stale PiP window', async ({page}) => {
  let disconnect = () => {};
  await page.routeWebSocket(/\/api\/rooms\/[^/]+\/ws$/, socket => {
    const server = socket.connectToServer();
    disconnect = () => { socket.close({code: 1001, reason: 'test disconnect'}); server.close(); };
  });
  await start(page, 'FeedbackDisconnect'); const pip = await open(page);
  disconnect();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(page.getByRole('region', {name: '共享者反馈小窗'})).toHaveCount(0);
});

test('late PiP resolution after stopping capture closes the orphan window', async ({page}) => {
  await page.addInitScript(() => {
    const win = window as unknown as {documentPictureInPicture: {requestWindow: (options: unknown) => Promise<Window>}; releasePiP?: () => void};
    const api = win.documentPictureInPicture, original = api.requestWindow.bind(api);
    api.requestWindow = async options => {
      const child = await original(options);
      await new Promise<void>(resolve => { win.releasePiP = resolve; });
      return child;
    };
  });
  await start(page, 'FeedbackLate');
  const event = page.context().waitForEvent('page');
  await page.getByRole('button', {name: '打开反馈小窗'}).click();
  const pip = await event;
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as {releasePiP?: unknown}).releasePiP)).toBe('function');
  await page.getByRole('button', {name: '停止共享', exact: true}).click();
  await page.evaluate(() => (window as unknown as {releasePiP: () => void}).releasePiP());
  await expect.poll(() => pip.isClosed()).toBe(true);
});

test('pointer expires in the PiP document even when a clear event is lost', async ({browser}) => {
  const a = await browser.newContext({ignoreHTTPSErrors: true}), b = await browser.newContext({ignoreHTTPSErrors: true});
  try {
    const owner = await a.newPage(), guest = await b.newPage();
    let dropPointerEvents = false;
    await owner.routeWebSocket(/\/api\/rooms\/[^/]+\/ws$/, socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (typeof message === 'string' && dropPointerEvents) {
          const event = JSON.parse(message);
          if (event.type === 'annotation' && event.annotation?.kind === 'pointer') return;
        }
        socket.send(message);
      });
    });
    await start(owner, 'FeedbackExpiryOwner');
    await login(guest, 'FeedbackExpiryGuest'); await guest.goto(owner.url());
    await expect.poll(async () => Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
    await owner.getByRole('button', {name: '允许 FeedbackExpiryGuest 批注', exact: true}).click();
    const pip = await open(owner);
    await guest.getByRole('button', {name: '指示光标', exact: true}).click();
    const box = (await guest.getByTestId('annotation-surface').boundingBox())!;
    await guest.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    await expect(pip.getByTestId('feedback-pointer')).toHaveCount(1);
    dropPointerEvents = true;
    await pip.bringToFront();
    await expect(pip.getByTestId('feedback-pointer')).toHaveCount(0, {timeout: 5000});
  } finally { await a.close(); await b.close(); }
});

test('leader admin overview and bandwidth remain available; real admin termination closes PiP', async ({page}) => {
  await start(page, 'TestAdmin');
  const roomID = new URL(page.url()).pathname.split('/').at(-1)!;
  const pip = await open(page);
  const admin = await page.context().newPage();
  await admin.goto('/admin');
  await expect(admin.getByRole('heading', {name: '管理员总览', exact: true})).toBeVisible();
  const limit = admin.getByLabel('总流量上限（Mbps）', {exact: true});
  await expect(limit).toHaveValue(/^[1-9]\d*$/);
  await expect(admin.getByRole('button', {name: '保存上限', exact: true})).toBeEnabled();
  await admin.getByLabel(`选择会议 ${roomID}`, {exact: true}).check();
  await admin.getByRole('button', {name: '批量结束会议', exact: true}).click();
  await admin.getByRole('dialog').getByRole('button', {name: '确认结束选定会议', exact: true}).click();
  await expect(admin.getByRole('status')).toContainText('已结束 1 场');
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(page.getByRole('region', {name: '共享者反馈小窗'})).toHaveCount(0);
});

test('expired login closes the presenter feedback and stops capture', async ({page}) => {
  await start(page, 'FeedbackExpired');
  const pip = await open(page);
  await page.route('**/auth/refresh', route => route.fulfill({status: 401, body: 'expired'}));
  await expect.poll(() => pip.isClosed(), {timeout: 15000}).toBe(true);
  await expect(page.getByRole('link', {name: '使用公司账号登录'})).toBeVisible();
  await expect(page.getByRole('region', {name: '共享者反馈小窗'})).toHaveCount(0);
});
