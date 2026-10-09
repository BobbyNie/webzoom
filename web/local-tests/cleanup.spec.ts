import {test, expect} from '@playwright/test';
import {cleanupCreatedMeetings} from './support/meeting-cleanup';
import type {Identity, Room} from '../src/types';

// A separate context ensures this test cannot use a human's application session.
test('cleanup ends only recorded test rooms and keeps another owned room', async ({page}) => {
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.locator('#username').fill('alice');
  await page.locator('#password').fill('Local-demo-only-2026!');
  await page.locator('#kc-login').click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
  const me = await page.request.get('/api/me');
  const identity: Identity = await me.json();
  const headers = {'Origin': new URL(page.url()).origin, 'X-CSRF-Token': identity.csrf};
  const created: Room[] = [];
  try {
    // Seven retained meetings must be accepted with default load-test limits disabled.
    for (let i = 0; i < 7; i++) {
      const response = await page.request.post('/api/rooms', {headers, data: {}});
      expect(response.status()).toBe(201);
      created.push(await response.json());
    }
    const mine = created.slice(0, 6).map(room => room.id);
    await cleanupCreatedMeetings(page.context(), mine);
    for (const id of mine) expect((await page.request.get(`/api/rooms/${id}`)).status()).toBe(404);
    const survivor = created[6];
    expect((await page.request.get(`/api/rooms/${survivor.id}`)).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('article', {name: `会议 ${survivor.id}`, exact: true}).getByRole('link', {name: '进入会议'})).toHaveAttribute('href', `/m/${survivor.id}`);
    await page.screenshot({path: '../artifacts/local/owned-meetings.png', fullPage: true});
    // Repeated cleanup is idempotent.
    await cleanupCreatedMeetings(page.context(), mine);
  } finally {
    // Keep the stack clean even when the regression test is red.
    for (const room of created) {
      const response = await page.request.post(`/api/rooms/${room.id}/actions`, {headers, data: {action: 'end'}});
      expect([200, 404]).toContain(response.status());
    }
  }
});
