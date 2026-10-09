import {expect, type BrowserContext, type Page, type Route} from '@playwright/test';
import type {Identity, Room} from '../../src/types';

// Never enumerate and end every owned meeting: the same user may have human-created rooms.
export async function cleanupCreatedMeetings(context: BrowserContext, ids: string[]) {
  if (ids.length === 0) return;
  const response = await context.request.get('/api/me');
  expect(response.status(), 'test session must remain valid for cleanup').toBe(200);
  const identity: Identity = await response.json();
  const headers = {'Origin': new URL(response.url()).origin, 'X-CSRF-Token': identity.csrf};
  for (const id of new Set(ids)) {
    const path = `/api/rooms/${encodeURIComponent(id)}`;
    const end = await context.request.post(`${path}/actions`, {headers, data: {action: 'end'}});
    expect([200, 404], `end test-created meeting ${id}`).toContain(end.status());
    expect((await context.request.get(path)).status(), 'ended test link must be invalid').toBe(404);
  }
}

export async function trackCreatedMeetings(page: Page) {
  const ids = new Set<string>();
  const pending = new Set<Promise<void>>();
  const pattern = '**/api/rooms';
  // Read the real response before the app can navigate and discard its body.
  const record = (route: Route) => {
    const work = (async () => {
      if (route.request().method() !== 'POST') {await route.continue(); return;}
      const response = await route.fetch();
      if (response.status() === 201) {
        const room: Room = await response.json();
        ids.add(room.id);
      }
      await route.fulfill({response});
    })();
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  await page.route(pattern, record);
  return async () => {
    await page.unroute(pattern, record);
    await Promise.all([...pending]);
    await cleanupCreatedMeetings(page.context(), [...ids]);
  };
}
