import {test, expect, type Page} from '@playwright/test';

async function create(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, Original = window.WebSocket;
    w.reconnectSockets = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        const stall = w.hangNextSocket;
        w.hangNextSocket = false;
        super(stall ? `${location.origin.replace('https:', 'wss:')}/__test__/pending-ws` : url, protocols);
        w.reconnectSockets.push(this);
      }
    };
  });
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill('ReconnectDeadline');
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await page.getByRole('button', {name: '创建会议', exact: true}).click();
  await expect(page).toHaveURL(/\/m\//);
  await expect(page.getByText('已连接', {exact: true})).toBeVisible();
  return new URL(page.url()).pathname.slice(3);
}

// Real Chromium + local TLS/WSS + signed test OIDC. Only the fault is injected.
test('a stalled reconnect room lookup is abandoned and retried', async ({page}) => {
  const id = await create(page);
  let release!: () => void, started!: () => void, lookups = 0;
  const pending = new Promise<void>(resolve => {release = resolve});
  const arrived = new Promise<void>(resolve => {started = resolve});
  await page.route(`**/api/rooms/${id}`, async route => {
    if (++lookups !== 1) {await route.continue(); return}
    const response = await route.fetch();
    started(); await pending;
    await route.fulfill({response}).catch(() => {}); // Timed-out fetch may already be gone.
  });
  try {
    await page.evaluate(() => (window as any).reconnectSockets[0].close());
    await arrived;
    await expect(page.getByText('已连接', {exact: true})).not.toBeVisible();
    await expect(page.getByText('已连接', {exact: true})).toBeVisible({timeout: 15000});
    expect(lookups).toBe(2);
    expect(await page.evaluate(() => (window as any).reconnectSockets.length)).toBe(2);
    // A response to the abandoned lookup must not create an extra connection.
    release(); await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).reconnectSockets.length)).toBe(2);
  } finally {release()}
});

test('a native WebSocket handshake that never finishes is retired and retried', async ({page}) => {
  await create(page);
  await page.evaluate(() => {
    (window as any).hangNextSocket = true;
    (window as any).reconnectSockets[0].close();
  });
  await expect.poll(() => page.evaluate(() => (window as any).reconnectSockets.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).reconnectSockets[1].readyState)).toBe(0);
  await expect(page.getByText('已连接', {exact: true})).toBeVisible({timeout: 15000});
  expect(await page.evaluate(() => (window as any).reconnectSockets.length)).toBe(3);
  expect(await page.evaluate(() => (window as any).reconnectSockets[1].readyState)).toBe(3);
  // Queued events from the retired transport must not tear down its replacement.
  await page.evaluate(() => {
    const old = (window as any).reconnectSockets[1];
    old.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({type: 'room', room: {id: 'obsolete', epoch: 999}})}));
    old.dispatchEvent(new CloseEvent('close'));
  });
  await page.waitForTimeout(1400);
  await expect(page.getByText('已连接', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).reconnectSockets.length)).toBe(3);
});
