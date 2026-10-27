import {openAnnotations} from './annotationDock';
import {test, expect, type Page} from '@playwright/test';

async function login(page: Page, name: string) {
  await page.goto('/'); await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill(name);
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
}

for (const fault of ['lookup', 'handshake'] as const) {
  test(`viewer recovers video and eligible annotation grant after stalled ${fault}`, async ({browser}) => {
    const contexts = await Promise.all([1, 2].map(() => browser.newContext({ignoreHTTPSErrors: true})));
    const [host, guest] = await Promise.all(contexts.map(c => c.newPage()));
    let release = () => {};
    try {
      await host.addInitScript(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
          const ctx = canvas.getContext('2d')!; let n = 0;
          setInterval(() => {ctx.fillStyle = ++n % 2 ? '#007c70' : '#164866'; ctx.fillRect(0, 0, 640, 360)}, 66);
          return canvas.captureStream(15);
        };
      });
      await guest.addInitScript(() => {
        const w = window as any, Original = window.WebSocket; w.reconnectSockets = [];
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) {
            const stall = w.hangNextSocket; w.hangNextSocket = false;
            super(stall ? `${location.origin.replace('https:', 'wss:')}/__test__/pending-ws` : url, protocols);
            w.reconnectSockets.push(this);
          }
        };
      });
      await login(host, 'BoundedHost');
      await host.getByRole('button', {name: '创建会议', exact: true}).click();
      await expect(host).toHaveURL(/\/m\//);
      await host.getByRole('button', {name: '共享屏幕', exact: true}).click();
      await login(guest, 'BoundedViewer'); await guest.goto(host.url());
      await expect.poll(async () => Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
      await host.getByRole('button', {name: '允许 BoundedViewer 批注', exact: true}).click();
      await openAnnotations(guest);await expect(guest.getByRole('button', {name: '画笔', exact: true})).toBeEnabled();
      let arrived: Promise<void> | undefined;
      if (fault === 'lookup') {
        let started!: () => void, lookups = 0;
        const pending = new Promise<void>(resolve => {release = resolve});
        arrived = new Promise<void>(resolve => {started = resolve});
        const id = new URL(host.url()).pathname.slice(3);
        await guest.route(`**/api/rooms/${id}`, async route => {
          if (++lookups !== 1) {await route.continue(); return}
          const response = await route.fetch(); started(); await pending;
          await route.fulfill({response}).catch(() => {});
        });
      }
      const disconnectedAt = Date.now();
      await guest.evaluate(stall => {
        (window as any).hangNextSocket = stall;
        (window as any).reconnectSockets[0].close();
      }, fault === 'handshake');
      await expect(guest.getByText('已连接', {exact: true})).not.toBeVisible();
      if (arrived) await arrived;
      else {
        await expect.poll(() => guest.evaluate(() => (window as any).reconnectSockets.length)).toBe(2);
        expect(await guest.evaluate(() => (window as any).reconnectSockets[1].readyState)).toBe(0);
      }
      await expect(guest.getByText('已连接', {exact: true})).toBeVisible({timeout: 15000});
      expect(Date.now() - disconnectedAt).toBeLessThan(28000);
      release();
      await expect.poll(async () => Number(await guest.getByTestId('frames').textContent())).toBeGreaterThan(0);
      await openAnnotations(guest);await expect(guest.getByRole('button', {name: '画笔', exact: true})).toBeEnabled();
      await expect(host.getByRole('button', {name: '撤销 BoundedViewer 批注', exact: true})).toBeVisible();
      // Exercise the restored grant through the server, not just the button state.
      await guest.getByRole('button', {name: '画笔', exact: true}).click();
      const box = await guest.getByTestId('annotation-surface').boundingBox();
      if (!box) throw new Error('missing annotation surface');
      await guest.mouse.move(box.x + box.width * .25, box.y + box.height * .35); await guest.mouse.down();
      await guest.mouse.move(box.x + box.width * .55, box.y + box.height * .45, {steps: 8}); await guest.mouse.up();
      await expect(host.getByTestId('annotation-strokes').locator('polyline,circle')).toHaveCount(1);
    } finally {release(); for (const context of contexts) await context.close()}
  });
}
