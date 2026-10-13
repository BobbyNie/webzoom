import {test, expect, type Page} from '@playwright/test';
import type {Identity} from '../src/types';
import {trackCreatedMeetings} from './support/meeting-cleanup';

async function login(page: Page, username: string): Promise<Identity> {
  await page.goto('/');
  await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await expect(page).toHaveURL(/\/idp\/realms\/webzoom-local\//);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('Local-demo-only-2026!');
  await page.locator('#kc-login').click();
  await expect(page.getByRole('button', {name: '创建会议', exact: true})).toBeVisible();
  const response = await page.request.get('/api/me');
  expect(response.status()).toBe(200);
  return response.json();
}

// This test uses the real Docker OIDC issuer and real time, not mocked refresh responses.
test('real Keycloak automatically renews host and passive viewer beyond initial expiry', async ({browser}) => {
  test.setTimeout(420000);
  const options = {baseURL: 'https://webzoom.localhost:8443', ignoreHTTPSErrors: true};
  const hostContext = await browser.newContext(options);
  const viewerContext = await browser.newContext(options);
  const host = await hostContext.newPage(), viewer = await viewerContext.newPage();
  const cleanup = await trackCreatedMeetings(host);
  const renewals: number[][] = [[], []], sockets = [0, 0], errors: string[] = [];
  const started = Date.now();
  for (const [index, page] of [host, viewer].entries()) {
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/auth/refresh') renewals[index].push(response.status());
    });
    page.on('websocket', () => sockets[index]++);
    page.on('pageerror', error => errors.push(error.message));
  }
  try {
    await host.addInitScript(() => {
      const state = {calls: 0, audioTracks: -1, audioRequested: false};
      Object.assign(window, {localCaptureState: state});
      navigator.mediaDevices.getDisplayMedia = async options => {
        state.calls++;
        state.audioRequested = options?.audio !== false;
        const canvas = document.createElement('canvas');
        canvas.width = 1280; canvas.height = 720;
        const context = canvas.getContext('2d')!;
        let frame = 0;
        setInterval(() => {
          context.fillStyle = ++frame % 30 < 15 ? '#008070' : '#164866';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = 'white'; context.font = '36px sans-serif';
          context.fillText(`Keycloak renewal / frame ${frame}`, 40, 100);
        }, 67);
        const stream = canvas.captureStream(15);
        state.audioTracks = stream.getAudioTracks().length;
        return stream;
      };
      navigator.mediaDevices.getUserMedia = async () => {throw new Error('audio/camera forbidden');};
      Object.defineProperty(window, 'RTCPeerConnection', {value: class {
        constructor() {throw new Error('WebRTC forbidden');}
      }});
    });
    const hostIdentity = await login(host, 'alice');
    // Fail quickly on an outdated deployment before waiting for its login to expire.
    const refresh = await host.request.post('/auth/refresh', {
      headers: {'Origin': new URL(host.url()).origin, 'X-CSRF-Token': hostIdentity.csrf}, data: {},
    });
    expect(refresh.status(), 'deployed application must provide protected session renewal').toBe(200);
    await host.getByRole('button', {name: '创建会议', exact: true}).click();
    await expect(host).toHaveURL(/\/m\//);
    const meeting = host.url();
    await host.getByRole('button', {name: '共享屏幕', exact: true}).click();
    const viewerIdentity = await login(viewer, 'bob');
    await viewer.goto(meeting);
    await expect.poll(async () => Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(10);
    const originalExpiry = Math.max(Date.parse(hostIdentity.expiresAt), Date.parse(viewerIdentity.expiresAt));
    const remaining = originalExpiry - Date.now();
    expect(remaining, 'local token expiry must leave enough time to observe automatic renewal').toBeGreaterThan(90000);
    expect(remaining, 'local token lifetime must stay short for this real-time test').toBeLessThanOrEqual(360000);
    while (Date.now() <= originalExpiry + 5000) {
      const frames = Number(await viewer.getByTestId('frames').textContent());
      await viewer.waitForTimeout(Math.min(30000, Math.max(1, originalExpiry + 5001 - Date.now())));
      await expect.poll(async () => Number(await viewer.getByTestId('frames').textContent())).toBeGreaterThan(frames);
      await expect(host.getByText('已连接', {exact: true})).toBeVisible();
      await expect(viewer.getByText('已连接', {exact: true})).toBeVisible();
    }
    for (const [index, page] of [host, viewer].entries()) {
      const response = await page.request.get('/api/me');
      expect(response.status(), 'login must remain valid beyond original expiry').toBe(200);
      const identity: Identity = await response.json();
      expect(Date.parse(identity.expiresAt)).toBeGreaterThan(originalExpiry);
      expect(renewals[index].length, 'each participant must renew automatically').toBeGreaterThan(0);
      expect(renewals[index].every(status => status === 200)).toBe(true);
    }
    expect(sockets).toEqual([1, 1]);
    expect(errors).toEqual([]);
    expect(await host.evaluate(() => (window as unknown as {localCaptureState: unknown}).localCaptureState))
      .toEqual({calls: 1, audioTracks: 0, audioRequested: false});
    await viewer.screenshot({path: '../artifacts/local/docker-viewer-renewed.png', fullPage: true});
    console.log(JSON.stringify({realKeycloak: true, beyondInitialExpiry: true,
      durationSeconds: Math.ceil((Date.now() - started) / 1000), automaticRenewals: renewals.map(values => values.length), mediaSockets: sockets}));
  } finally {
    try {await cleanup();} finally {await hostContext.close(); await viewerContext.close();}
  }
});
