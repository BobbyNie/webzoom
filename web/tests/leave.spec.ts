import {test, expect, type Page, type WebSocketRoute} from '@playwright/test';

async function viewer(page: Page) {
  const room = {
    id: 'leave-test', ownerId: 'host', publisherId: 'host', epoch: 1,
    active: false, quality: 0, annotators: ['viewer'],
    participants: [{id: 'host', name: 'Host'}, {id: 'viewer', name: 'Viewer'}],
  };
  const sockets: WebSocketRoute[] = [], commands: string[] = [];
  await page.route('**/api/me', route => route.fulfill({json: {
    user: {id: 'viewer', name: 'Viewer'}, csrf: 'test-only',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }}));
  await page.route('**/api/rooms', route => route.fulfill({json: []}));
  await page.route('**/api/rooms/leave-test', route => route.fulfill({json: room}));
  await page.routeWebSocket(/\/api\/rooms\/leave-test\/ws(?:\?.*)?$/, socket => {
    sockets.push(socket);
    socket.onMessage(message => {commands.push(JSON.parse(message.toString()).type)});
    socket.send(JSON.stringify({type: 'room', room}));
  });
  await page.goto('/m/leave-test');
  await expect(page.getByText('已连接', {exact: true})).toBeVisible();
  return {sockets, commands};
}

test('stalled leave request still navigates home and falls back to the socket', async ({page}) => {
  const state = await viewer(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve});
  await page.route('**/api/rooms/leave-test/actions', async route => {
    expect(route.request().postDataJSON()).toEqual({action: 'leave'});
    expect(route.request().headers()['x-csrf-token']).toBe('test-only');
    await pending;
    await route.abort().catch(() => {}); // The browser already aborted at the deadline.
  });
  try {
    const started = Date.now();
    await page.getByRole('link', {name: '离开会议', exact: true}).click();
    await expect(page).toHaveURL(/\/$/, {timeout: 5000});
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
    await expect.poll(() => state.commands.filter(type => type === 'leave').length).toBe(1);
    expect(state.sockets).toHaveLength(1);
  } finally {release()}
});

test('socket loss while leaving does not reconnect before delayed HTTP completion', async ({page}) => {
  const state = await viewer(page);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve});
  const requestStarted = new Promise<void>(resolve => {started = resolve});
  await page.route('**/api/rooms/leave-test/actions', async route => {
    started(); await pending;
    await route.fulfill({json: {ok: true}});
  });
  try {
    await page.getByRole('link', {name: '离开会议', exact: true}).click();
    await requestStarted;
    await state.sockets[0].close({code: 1001, reason: 'test transport exit'});
    // The first reconnect normally occurs within 1250ms.
    await page.waitForTimeout(1400);
    expect(state.sockets).toHaveLength(1);
    expect(new URL(page.url()).pathname).toBe('/m/leave-test');
    release();
    await expect(page).toHaveURL(/\/$/);
    expect(state.commands).not.toContain('leave');
  } finally {release()}
});
