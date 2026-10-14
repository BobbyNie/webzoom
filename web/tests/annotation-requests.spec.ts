import {test, expect, type Page} from '@playwright/test';

async function login(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill(name);
  await page.getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
}
async function capture(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d')!;
      const draw = () => {ctx.fillStyle = '#164866'; ctx.fillRect(0, 0, 1280, 720); requestAnimationFrame(draw)};
      draw(); return canvas.captureStream(15);
    };
  });
}
const requests = (page: Page) => page.getByRole('region', {name: '批注申请', exact: true});
const permission = (page: Page) => page.getByRole('region', {name: '我的批注权限', exact: true});

test('attendees request; host denies or approves individually and bulk approves only applicants', async ({browser}) => {
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext({ignoreHTTPSErrors: true})));
  const [host, a, b, bystander] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  for (const p of [host, a, b, bystander]) p.on('pageerror', e => errors.push(e.message));
  try {
    await capture(host); await login(host, 'RequestHost');
    await host.getByRole('button', {name: '创建会议', exact: true}).click(); await expect(host).toHaveURL(/\/m\//);
    const link = host.url();
    for (const [page, name] of [[a, 'ApplicantA'], [b, 'ApplicantB'], [bystander, 'Bystander']] as const) {
      await login(page, name); await page.goto(link); await expect(permission(page).getByRole('button', {name: '申请批注', exact: true})).toBeEnabled();
    }
    await a.getByRole('button', {name: '申请批注', exact: true}).click();
    await expect(permission(a)).toContainText('已申请，等待主持人同意');
    await expect(requests(host).getByRole('button', {name: '一键同意全部（1）', exact: true})).toBeEnabled();
    await requests(host).getByRole('button', {name: '拒绝 ApplicantA 的批注申请', exact: true}).click();
    await expect(permission(a)).toContainText('申请已结束');
    await a.getByRole('button', {name: '申请批注', exact: true}).click();
    await requests(host).getByRole('button', {name: '同意 ApplicantA 的批注申请', exact: true}).click();
    await expect(permission(a)).toContainText('你已获得批注权限');
    await host.getByRole('button', {name: '撤销 ApplicantA 批注', exact: true}).click();
    await a.getByRole('button', {name: '申请批注', exact: true}).click();
    await a.getByRole('button', {name: '取消申请', exact: true}).click();
    await expect(requests(host)).toContainText('暂无待处理申请');
    // Both applicants enter the queue; a non-applicant must stay unauthorized.
    await a.getByRole('button', {name: '申请批注', exact: true}).click();
    await b.getByRole('button', {name: '申请批注', exact: true}).click();
    await expect(requests(host).getByRole('button', {name: '一键同意全部（2）', exact: true})).toBeEnabled();
    await host.screenshot({path: 'test-results/annotation-requests-pending-host.png', fullPage: true});
    await a.screenshot({path: 'test-results/annotation-requests-pending-attendee.png', fullPage: true});
    await requests(host).getByRole('button', {name: '一键同意全部（2）', exact: true}).click();
    await expect(permission(a)).toContainText('你已获得批注权限');
    await expect(permission(b)).toContainText('你已获得批注权限');
    await expect(permission(bystander).getByRole('button', {name: '申请批注', exact: true})).toBeEnabled();
    await expect(requests(host)).toContainText('暂无待处理申请');
    await host.getByRole('button', {name: '共享屏幕', exact: true}).click();
    for (const p of [a, b]) await expect(p.getByRole('button', {name: '画笔', exact: true})).toBeVisible();
    await expect(bystander.getByRole('button', {name: '画笔', exact: true})).toHaveCount(0);
    // Verify an approved participant can actually draw through the authoritative WSS path.
    await a.getByRole('button', {name: '画笔', exact: true}).click();
    const box = await a.getByTestId('annotation-surface').boundingBox(); if (!box || !box.width) throw new Error('missing shared frame');
    await a.mouse.move(box.x + box.width * .3, box.y + box.height * .3); await a.mouse.down();
    await a.mouse.move(box.x + box.width * .6, box.y + box.height * .5, {steps: 5}); await a.mouse.up();
    await expect(host.getByTestId('annotation-strokes').locator('polyline,circle')).toHaveCount(1);
    await host.getByRole('button', {name: '撤销 ApplicantA 批注', exact: true}).click();
    await expect(a.getByRole('button', {name: '画笔', exact: true})).toHaveCount(0);
    await host.screenshot({path: 'test-results/annotation-requests-host.png', fullPage: true});
    expect(errors).toEqual([]);
  } finally {for (const c of contexts) await c.close()}
});

test('pending requests survive host reload; leaving removes them and forged approvals fail', async ({browser}) => {
  const c1 = await browser.newContext({ignoreHTTPSErrors: true}), c2 = await browser.newContext({ignoreHTTPSErrors: true});
  const host = await c1.newPage(), guest = await c2.newPage();
  try {
    await login(host, 'QueueHost'); await host.getByRole('button', {name: '创建会议', exact: true}).click(); await expect(host).toHaveURL(/\/m\//);
    const link = host.url(); await login(guest, 'QueueGuest'); await guest.goto(link);
    await guest.getByRole('button', {name: '申请批注', exact: true}).click();
    await expect(requests(host)).toContainText('QueueGuest');
    const status = await guest.evaluate(async () => {
      const me = await (await fetch('/api/me')).json();
      return (await fetch(`/api/rooms/${location.pathname.split('/').pop()}/actions`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf}, body: JSON.stringify({action: 'annotation-approve-all', target: ''})})).status;
    });
    expect(status).toBe(403);
    await host.reload(); await expect(requests(host).getByRole('button', {name: '同意 QueueGuest 的批注申请', exact: true})).toBeEnabled();
    await guest.getByRole('link', {name: '离开会议', exact: true}).click();
    await expect(requests(host)).toContainText('暂无待处理申请');
    await guest.goto(link); await expect(permission(guest).getByRole('button', {name: '申请批注', exact: true})).toBeEnabled();
    await expect(requests(host)).toContainText('暂无待处理申请');
  } finally {await c1.close(); await c2.close()}
});
