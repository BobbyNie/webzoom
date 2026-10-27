import {test, expect, type Page} from '@playwright/test';

async function create(page: Page, name: string, delayedPicker = false) {
  await page.addInitScript(delayed => {
    const w = window as any;
    const Original = window.WebSocket;
    w.raceSockets = []; w.raceRooms = [];
    window.WebSocket = class extends Original {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args); w.raceSockets.push(this);
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          const message = JSON.parse(event.data);
          if (message.type === 'room') w.raceRooms.push(message.room);
        });
      }
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d')!; let n = 0;
      setInterval(() => {ctx.fillStyle = ++n % 2 ? '#007c70' : '#164866'; ctx.fillRect(0, 0, 640, 360)}, 66);
      const stream = canvas.captureStream(15); w.raceStream = stream;
      if (delayed) await new Promise<void>(resolve => {w.resolvePicker = resolve});
      return stream;
    };
  }, delayedPicker);
  await page.goto('/'); await page.getByRole('link', {name: '使用公司账号登录'}).click();
  await page.getByLabel('用户名').fill(name); await page.getByRole('button', {name: '登录', exact: true}).click();
  await page.getByRole('button', {name: '创建会议', exact: true}).click();
  await expect(page).toHaveURL(/\/m\//);
  await expect(page.getByText('已连接', {exact: true})).toBeVisible();
  return new URL(page.url()).pathname.slice(3);
}

test('a picker opened before disconnect cannot start sharing on the replacement connection', async ({page}) => {
  const roomID = await create(page, 'PickerRace', true);
  let starts = 0;
  page.on('request', request => {if (request.url().endsWith('/actions') && request.postDataJSON()?.action === 'start') starts++});
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolvePicker)).toBe('function');
  await page.evaluate(() => (window as any).raceSockets.at(-1).close());
  await expect.poll(() => page.evaluate(() => (window as any).raceSockets.length)).toBe(2);
  await expect(page.getByText('已连接', {exact: true})).toBeVisible();
  await page.evaluate(() => (window as any).resolvePicker());
  await expect.poll(() => page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
  expect(starts).toBe(0);
  const snapshot = await (await page.request.get(`/api/rooms/${roomID}`)).json();
  expect(snapshot.active).toBe(false);
});

test('a delayed old start reply cannot roll back the room or stop a newer share', async ({page}) => {
  const roomID = await create(page, 'StartReplyRace');
  const identity = await (await page.request.get('/api/me')).json();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(resolve => {release = resolve});
  const started = new Promise<void>(resolve => {received = resolve});
  await page.route(`**/api/rooms/${roomID}/actions`, async route => {
    if (route.request().postDataJSON()?.action !== 'start') {await route.continue(); return}
    const response = await route.fetch(); received(); await held;
    await route.fulfill({response});
  });
  try {
    await page.getByRole('button', {name: '共享屏幕', exact: true}).click(); await started;
    const headers = {'X-CSRF-Token': identity.csrf, Origin: new URL(page.url()).origin};
    const stop = await page.request.post(`/api/rooms/${roomID}/actions`, {headers, data: {action: 'stop'}});
    expect(stop.status()).toBe(200);
    const restart = await page.request.post(`/api/rooms/${roomID}/actions`, {headers, data: {action: 'start'}});
    expect(restart.status()).toBe(200); const current = await restart.json();
    await expect.poll(() => page.evaluate(() => (window as any).raceRooms.at(-1)?.epoch)).toBe(current.epoch);
    await expect(page.getByTestId('share-state')).toHaveText('正在共享');
    release();
    await expect.poll(() => page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
    await expect(page.getByRole('button', {name: '共享屏幕', exact: true})).toBeEnabled();
    const snapshot = await (await page.request.get(`/api/rooms/${roomID}`)).json();
    expect(snapshot.epoch).toBe(current.epoch); expect(snapshot.active).toBe(true);
    expect(await page.evaluate(() => (window as any).raceSockets.length)).toBe(1);
  } finally {release()}
});

test('an old track ended callback cannot stop its replacement publisher', async ({page}) => {
  const roomID = await create(page, 'EndedCallbackRace');
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const w = window as any, track = w.raceStream.getVideoTracks()[0];
    w.lateEnded = () => track.onended?.call(track, new Event('ended'));
  });
  await page.getByRole('button', {name: '停止共享', exact: true}).click();
  await expect(page.getByRole('button', {name: '共享屏幕', exact: true})).toBeEnabled();
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
  const before = await (await page.request.get(`/api/rooms/${roomID}`)).json();
  await page.evaluate(() => (window as any).lateEnded());
  // Exercise further frames after the obsolete event, not just a pre-event UI snapshot.
  const frames = Number(await page.getByTestId('frames').textContent());
  await expect.poll(async () => Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(frames);
  const after = await (await page.request.get(`/api/rooms/${roomID}`)).json();
  expect(after.epoch).toBe(before.epoch); expect(after.active).toBe(true);
  expect(await page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('live');
});

test('a lost start reply cancels the server share and allows a clean retry', async ({page}) => {
  const roomID = await create(page, 'LostStartReply');
  await page.route(`**/api/rooms/${roomID}/actions`, async route => {
    if (route.request().postDataJSON()?.action !== 'start') {await route.continue(); return}
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '共享屏幕', exact: true})).toBeEnabled();
  await expect.poll(async () => (await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  expect(await page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
  await page.unroute(`**/api/rooms/${roomID}/actions`);
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
});

test('a stalled start times out and its delayed request cannot resurrect sharing', async ({page}) => {
  const roomID = await create(page, 'StalledStart');
  let release!: () => void, arrived!: () => void, status = 0;
  const held = new Promise<void>(resolve => {release = resolve});
  const requested = new Promise<void>(resolve => {arrived = resolve});
  await page.route(`**/api/rooms/${roomID}/actions`, async route => {
    if (route.request().postDataJSON()?.action !== 'start') {await route.continue(); return}
    arrived(); await held;
    const response = await route.fetch(); status = response.status();
    await route.fulfill({response}).catch(() => {});
  });
  try {
    await page.getByRole('button', {name: '共享屏幕', exact: true}).click(); await requested;
    await expect(page.getByRole('button', {name: '共享屏幕', exact: true})).toBeEnabled({timeout: 15000});
    expect(await page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
    // Wait for the cancellation fence, then deliver the abandoned request as a delayed upstream would.
    await expect.poll(async () => (await (await page.request.get(`/api/rooms/${roomID}`)).json()).epoch).toBeGreaterThan(0);
    release(); await expect.poll(() => status).toBe(409);
    expect((await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  } finally {release()}
});

test('a failed stop request falls back to the live socket instead of leaving a phantom share', async ({page}) => {
  const roomID = await create(page, 'LostStopRequest');
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
  await page.route(`**/api/rooms/${roomID}/actions`, async route => {
    if (route.request().postDataJSON()?.action === 'stop') await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', {name: '停止共享', exact: true}).click();
  await expect.poll(async () => (await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  expect(await page.evaluate(() => (window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
  expect(await page.evaluate(() => (window as any).raceSockets.length)).toBe(1);
  await page.unroute(`**/api/rooms/${roomID}/actions`);
  await page.getByRole('button', {name: '共享屏幕', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止共享', exact: true})).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
});

test('retry stays locked until an abandoned start has a server cancellation acknowledgement', async ({page}) => {
  const roomID = await create(page, 'CancellationBarrier');
  await page.evaluate(() => {
    const w=window as any,socket=w.raceSockets.at(-1),send=socket.send.bind(socket);
    socket.send=(data:string)=>{
      if(typeof data==='string'&&JSON.parse(data).type==='cancel-start')w.releaseCancellation=()=>send(data);
      else send(data);
    };
  });
  await page.route(`**/api/rooms/${roomID}/actions`, async route => {
    if(route.request().postDataJSON()?.action!=='start'){await route.continue();return}
    await route.fetch();await route.abort('failed');
  });
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof(window as any).releaseCancellation)).toBe('function');
  await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeDisabled();
  await page.evaluate(()=>(window as any).releaseCancellation());
  await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeEnabled();
  await expect.poll(async()=>(await(await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  expect(await page.evaluate(()=>(window as any).raceSockets.length)).toBe(1);
});


test('a publisher disconnect leaves a persistent stop reason after reconnect and requires an explicit restart', async ({page}) => {
  const roomID=await create(page,'PublisherDisconnectNotice');
  let starts=0;
  page.on('request',request=>{if(request.url().endsWith('/actions')&&request.postDataJSON()?.action==='start')starts++});
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  await expect.poll(async()=>Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
  await page.evaluate(()=>(window as any).raceSockets.at(-1).close());
  const warning=page.getByTestId('share-interruption');
  await expect(warning).toContainText('共享连接已断开');
  await expect(warning).toContainText('发生于');
  await expect.poll(()=>page.evaluate(()=>(window as any).raceSockets.length)).toBe(2);
  await expect(page.getByText('已连接',{exact:true})).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(page.getByTestId('share-state')).toHaveText('共享已停止');
  await expect.poll(()=>page.evaluate(()=>(window as any).raceStream.getVideoTracks()[0].readyState)).toBe('ended');
  expect((await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  expect(starts).toBe(1);
  await page.getByRole('button',{name:'全屏观看',exact:true}).click();
  await expect(warning).toBeVisible();
  expect(await warning.evaluate(element=>document.fullscreenElement?.contains(element))).toBe(true);
  await page.getByRole('button',{name:'退出全屏',exact:true}).click();
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  await expect(warning).toHaveCount(0);
  await expect.poll(async()=>Number(await page.getByTestId('frames').textContent())).toBeGreaterThan(0);
  expect(starts).toBe(2);
});

test('a browser capture-ended event has a visible reason even inside native fullscreen', async ({page}) => {
  const roomID=await create(page,'CaptureEndedNotice');
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'全屏观看',exact:true}).click();
  // Canvas capture has no OS stop-sharing UI; simulate its native ended event explicitly.
  await page.evaluate(()=>{const track=(window as any).raceStream.getVideoTracks()[0];track.stop();track.dispatchEvent(new Event('ended'))});
  const warning=page.getByTestId('share-interruption');
  await expect(warning).toContainText('浏览器已结束屏幕采集');
  await expect(warning).toBeVisible();
  expect(await warning.evaluate(element=>document.fullscreenElement?.contains(element))).toBe(true);
  await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeEnabled();
  await expect.poll(async()=>(await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
  expect(await page.evaluate(()=>(window as any).raceSockets.length)).toBe(1);
  await page.screenshot({path:'../artifacts/local/sharing-interrupted-fullscreen.png'});
});

test('an external server stop is explained without pretending the connection was lost', async ({page}) => {
  const roomID=await create(page,'ServerStopNotice');
  const identity=await (await page.request.get('/api/me')).json();
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  const response=await page.request.post(`/api/rooms/${roomID}/actions`,{headers:{'X-CSRF-Token':identity.csrf,Origin:new URL(page.url()).origin},data:{action:'stop'}});
  expect(response.status()).toBe(200);
  await expect(page.getByTestId('share-interruption')).toContainText('服务器已停止或更新本次共享');
  await expect(page.getByText('已连接',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).raceSockets.length)).toBe(1);
  await page.getByRole('button',{name:'关闭共享中断提示'}).click();
  await expect(page.getByTestId('share-interruption')).toHaveCount(0);
});

test('a deliberate local stop and its old capture callback do not show a false interruption', async ({page}) => {
  await create(page,'IntentionalStopNotice');
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  await page.evaluate(()=>{const track=(window as any).raceStream.getVideoTracks()[0];(window as any).lateEnded=()=>track.onended?.call(track,new Event('ended'))});
  await page.getByRole('button',{name:'停止共享',exact:true}).click();
  await expect(page.getByRole('button',{name:'共享屏幕',exact:true})).toBeEnabled();
  await page.evaluate(()=>(window as any).lateEnded());
  await expect(page.getByTestId('share-interruption')).toHaveCount(0);
  await expect(page.getByTestId('share-state')).toHaveText('等待共享');
});

test('an encoder failure remains explained after the generic error is dismissed', async ({page}) => {
  await page.addInitScript(()=>{const Encoder=window.VideoEncoder;window.VideoEncoder=class extends Encoder{constructor(init:VideoEncoderInit){super(init);(window as any).failEncoder=()=>init.error(new DOMException('simulated encoder failure','EncodingError'))}}});
  const roomID=await create(page,'EncoderFailureNotice');
  await page.getByRole('button',{name:'共享屏幕',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止共享',exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).failEncoder());
  await expect(page.getByTestId('share-interruption')).toContainText('屏幕采集或编码发生错误');
  await page.getByRole('button',{name:'关闭错误提示'}).click();
  await expect(page.getByTestId('share-interruption')).toBeVisible();
  await expect.poll(async()=>(await (await page.request.get(`/api/rooms/${roomID}`)).json()).active).toBe(false);
});
