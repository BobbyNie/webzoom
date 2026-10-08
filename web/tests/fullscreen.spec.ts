import {test, expect, type Page} from '@playwright/test';

async function openViewer(page: Page) {
  const room = {
    id: 'fullscreen-test', ownerId: 'host', publisherId: 'host', epoch: 1,
    active: true, quality: 0,
    participants: [{id: 'host', name: 'Host'}, {id: 'viewer', name: 'Viewer'}],
  };
  await page.route('**/api/me', route => route.fulfill({json: {
    user: {id: 'viewer', name: 'Viewer'}, csrf: 'test-only',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }}));
  await page.route('**/api/rooms/fullscreen-test', route => route.fulfill({json: room}));
  await page.routeWebSocket('**/api/rooms/fullscreen-test/ws', ws => {
    ws.send(JSON.stringify({type: 'room', room}));
  });
  await page.goto('/m/fullscreen-test');
  await expect(page.getByText('你正在以听众身份参与')).toBeVisible();
}

for (const width of [1440, 1920]) {
  test(`viewer fills browser fullscreen at ${width}px and can exit repeatedly`, async ({page}) => {
    await page.setViewportSize({width, height: 1080});
    await page.addInitScript(() => {
      const request = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function(options) {
        (window as unknown as {fullscreenOptions?: FullscreenOptions}).fullscreenOptions = options;
        return request.call(this, options);
      };
    });
    await openViewer(page);
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.getByRole('button', {name: '全屏观看', exact: true}).click();
      const exit = page.getByRole('button', {name: '退出全屏', exact: true});
      await expect(exit).toBeVisible();
      await expect(exit).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => {
        const root = document.fullscreenElement;
        const stage = document.querySelector('.screen-stage')!.getBoundingClientRect();
        const canvas = document.querySelector('canvas')!.getBoundingClientRect();
        return {
          native: !!root,
          controlsInside: root?.contains(document.querySelector('[aria-label="退出全屏"]')),
          stageFillsViewport: Math.abs(stage.width - innerWidth) <= 1 && Math.abs(stage.height - innerHeight) <= 1,
          canvasFillsStage: Math.abs(canvas.width - stage.width) <= 1 && Math.abs(canvas.height - stage.height) <= 1,
          pageChromeOutside: !root?.contains(document.querySelector('.app-header')) && !root?.contains(document.querySelector('.participants-panel')),
          fit: getComputedStyle(document.querySelector('canvas')!).objectFit,
          navigationUI: (window as unknown as {fullscreenOptions: FullscreenOptions}).fullscreenOptions.navigationUI,
        };
      })).toEqual({native: true, controlsInside: true, stageFillsViewport: true, canvasFillsStage: true, pageChromeOutside: true, fit: 'contain', navigationUI: 'hide'});
      if (repeat === 0) {
        await page.screenshot({path: `../artifacts/local/viewer-fullscreen-${width}.png`});
        await exit.click();
      } else {
        // Browser-initiated exit (for example Esc) must also update React state.
        await page.evaluate(() => document.exitFullscreen());
      }
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      await expect(page.getByRole('button', {name: '全屏观看', exact: true})).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('heading', {name: '参与者', exact: true})).toBeVisible();
    }
  });
}

test('fullscreen rejection shows an error without changing the viewer layout', async ({page}) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('test denial'));
  });
  await openViewer(page);
  await page.getByRole('button', {name: '全屏观看', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('浏览器未能进入全屏');
  await expect(page.getByRole('button', {name: '全屏观看', exact: true})).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});
