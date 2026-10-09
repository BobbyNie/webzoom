import {test, expect, type Page} from '@playwright/test';

const identity = {user: {id: 'alice', name: 'Alice'}, csrf: 'test-csrf', expiresAt: new Date(Date.now() + 3600000).toISOString()};
const ownRoom = {id: 'owned-room', ownerId: 'alice', publisherId: 'bob', epoch: 2, active: true, quality: 0,
  createdAt: '2026-10-09T01:00:00Z', expiresAt: '2026-10-09T09:00:00Z', participants: [{id: 'bob', name: 'Bob'}]};
async function signedIn(page: Page) {
  await page.route('**/api/me', route => route.fulfill({json: identity}));
}

test('homepage shows owned meeting links without number counters', async ({page}) => {
  await signedIn(page);
  await page.route('**/api/rooms', route => route.fulfill({json: [ownRoom]}));
  await page.goto('/');
  const list = page.getByRole('region', {name: '我创建的会议', exact: true});
  await expect(list).toBeVisible();
  await expect(list.getByRole('link', {name: '进入会议', exact: true})).toHaveAttribute('href', '/m/owned-room');
  await expect(list.getByText('正在共享', {exact: true})).toBeVisible();
  await expect(list.getByRole('button', {name: '复制链接', exact: true})).toBeVisible();
  await expect(list.getByRole('button', {name: '结束会议', exact: true})).toBeVisible();
  await expect(list).not.toContainText(/会议数量|登录人数|参与人数|1 人|共 1/);
});

test('copy and confirmed end work without joining the meeting', async ({page}) => {
  await signedIn(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (text: string) => {
      (window as unknown as {copied: string}).copied = text;
    }}});
  });
  let ended = false;
  const mutations: {csrf?: string; body: unknown}[] = [];
  await page.route('**/api/rooms', route => route.fulfill({json: ended ? [] : [ownRoom]}));
  await page.route('**/api/rooms/owned-room/actions', async route => {
    mutations.push({csrf: route.request().headers()['x-csrf-token'], body: route.request().postDataJSON()});
    ended = true;
    await route.fulfill({json: ownRoom});
  });
  await page.goto('/');
  await page.getByRole('button', {name: '复制链接', exact: true}).click();
  expect(await page.evaluate(() => (window as unknown as {copied: string}).copied)).toBe(`${new URL(page.url()).origin}/m/owned-room`);
  await expect(page.getByRole('status').filter({hasText: '会议链接已复制'})).toBeVisible();
  await page.getByRole('button', {name: '结束会议', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '结束这场会议？'});
  await expect(dialog).toContainText('owned-ro');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(mutations).toEqual([]);
  await page.getByRole('button', {name: '结束会议', exact: true}).click();
  await dialog.getByRole('button', {name: '确认结束', exact: true}).click();
  await expect(page.getByText('你还没有未结束的会议。')).toBeVisible();
  expect(mutations).toEqual([{csrf: 'test-csrf', body: {action: 'end'}}]);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('pressure-test capacity error is explicit and expired login returns to sign-in', async ({page}) => {
  await signedIn(page);
  let failure = 429;
  await page.route('**/api/rooms', route => route.request().method() === 'POST'
    ? route.fulfill({status: failure, body: 'capacity reached'}) : route.fulfill({json: []}));
  await page.goto('/');
  await page.getByRole('button', {name: '创建会议', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('压力测试');
  await expect(page.getByRole('alert')).not.toContainText('会议人数或会议数量');
  failure = 401;
  await page.getByRole('button', {name: '创建会议', exact: true}).click();
  await expect(page.getByRole('link', {name: '使用公司账号登录'})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('登录已过期');
});

test('meeting participant names remain visible without a headcount badge', async ({page}) => {
  await signedIn(page);
  await page.route('**/api/rooms/owned-room', route => route.fulfill({json: ownRoom}));
  await page.routeWebSocket('**/api/rooms/owned-room/ws', ws => ws.send(JSON.stringify({type: 'room', room: ownRoom})));
  await page.goto('/m/owned-room');
  await expect(page.getByRole('heading', {name: '参与者', exact: true}).locator('..')).toHaveText('参与者');
  await expect(page.getByRole('listitem').getByText('Bob', {exact: true})).toBeVisible();
});

test('list distinguishes loading, failure and empty; refresh rechecks authentication', async ({page}) => {
  await signedIn(page);
  let response = 500;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/rooms', async route => {
    await gate;
    await route.fulfill(response === 200 ? {json: []} : {status: response, body: 'test failure'});
  });
  await page.goto('/');
  await expect(page.getByText('正在读取会议列表…')).toBeVisible();
  await expect(page.getByText('你还没有未结束的会议。')).not.toBeVisible();
  release();
  await expect(page.getByRole('alert')).toContainText('无法读取会议列表');
  await expect(page.getByText('你还没有未结束的会议。')).not.toBeVisible();
  response = 200;
  await page.getByRole('button', {name: '刷新列表'}).click();
  await expect(page.getByText('你还没有未结束的会议。')).toBeVisible();
  response = 401;
  await page.getByRole('button', {name: '刷新列表'}).click();
  await expect(page.getByRole('link', {name: '使用公司账号登录'})).toBeVisible();
});

for (const status of [403, 404]) {
  test(`end handles ${status} without reporting a false success`, async ({page}) => {
    await signedIn(page);
    let stale = false;
    await page.route('**/api/rooms', route => route.fulfill({json: stale && status === 404 ? [] : [ownRoom]}));
    await page.route('**/api/rooms/owned-room/actions', async route => {
      stale = true;
      await route.fulfill({status, body: 'test failure'});
    });
    await page.goto('/');
    await page.getByRole('button', {name: '结束会议', exact: true}).click();
    await page.getByRole('button', {name: '确认结束', exact: true}).click();
    if (status === 403) {
      await expect(page.getByRole('alert')).toContainText('没有结束此会议的权限');
      await expect(page.getByRole('link', {name: '进入会议'})).toBeVisible();
    } else {
      await expect(page.getByText('你还没有未结束的会议。')).toBeVisible();
      await expect(page.getByText('会议已结束或已过期。', {exact: true})).toBeVisible();
    }
  });
}
