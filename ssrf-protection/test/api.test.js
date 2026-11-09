// Tests the whole service: the URL check, the guards in Puppeteer and
// Playwright, the egress proxy and the limits, with real browsers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { startProxy, startServers, startUdpCounter } from './helpers.js';

// Short limits, so that the tests run fast. Set them before the import.
process.env.JOB_TIMEOUT_MS = '3000';
const { createApp } = await import('../src/app.js');
const { closeBrowsers, launchBrowsers } = await import('../src/render.js');

let servers;
let proxy;
let api;
let baseUrl;

before(async () => {
  servers = await startServers();
  proxy = await startProxy();
  await launchBrowsers(proxy.url, [servers.secureOriginFlag]);
  api = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${api.address().port}`;
});

beforeEach(() => {
  servers.reset();
  proxy.blocked.length = 0;
});

after(async () => {
  api.close();
  await closeBrowsers();
  proxy.proxy.closeAllConnections();
  proxy.proxy.close();
  await servers.close();
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function pdfPages(res) {
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  return (await PDFDocument.load(bytes)).getPageCount();
}

const routes = ['/pdf', '/screenshot'];

test('renders a public page to PDF and PNG', async () => {
  assert.equal(await pdfPages(await post('/pdf', { url: `${servers.pub.url}/` })), 1);
  const res = await post('/screenshot', { url: `${servers.pub.url}/` });
  assert.equal(res.status, 200);
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(res.headers.get('x-blocked-requests'), '0');
});

test('returns 403 for the metadata address and other internal URLs', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd']) {
    const res = await post('/pdf', { url });
    assert.equal(res.status, 403, url);
    const body = await res.json();
    assert.match(body.error, /^Blocked: /);
    assert.equal(body.code, 'BLOCKED_BY_POLICY');
  }
});

for (const route of routes) {
  test(`${route}: blocks frames and images in supplied HTML`, async () => {
    const targets = [`${servers.internal.url}/frame`, ...servers.metadata.aliases.map((address) =>
      `http://${address.includes(':') ? `[${address}]` : address}:${servers.metadata.port}/latest/meta-data/`)];
    const html = targets.map((src) => `<iframe src="${src}"></iframe><img src="${src}">`).join('');
    const res = await post(route, { html });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-blocked-requests'), String(targets.length * 2));
    assert.deepEqual(servers.internal.hits, []);
    assert.deepEqual(servers.metadata.hits, []);
  });

  test(`${route}: the proxy blocks a name that resolves to an internal address`, async () => {
    const metadataUrl = `http://metadata.test:${servers.metadata.port}/latest/meta-data/`;
    const res = await post(route, { url: metadataUrl });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /egress proxy/);
    const frame = await post(route, { html: `<iframe src="${metadataUrl}"></iframe>` });
    assert.equal(frame.status, 200);
    assert.deepEqual(servers.metadata.hits, []);
    assert.ok(proxy.blocked.some((block) => block.target.startsWith('metadata.test')));
  });

  test(`${route}: blocks a redirect to an internal address`, async () => {
    const to = encodeURIComponent(`${servers.internal.url}/after-redirect`);
    const res = await post(route, { url: `${servers.pub.url}/redirect?to=${to}` });
    assert.equal(res.status, 403);
    assert.deepEqual(servers.internal.hits, []);
  });

  test(`${route}: a page that moves itself inside gives 403, not an image of the error page`, async () => {
    const to = encodeURIComponent(`${servers.internal.url}/from-script`);
    const res = await post(route, { url: `${servers.pub.url}/script-redirect?to=${to}` });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'BLOCKED_BY_POLICY');
    assert.deepEqual(servers.internal.hits, []);
  });

  test(`${route}: a page with status 404 gives 502, not an image of the page`, async () => {
    const res = await post(route, { url: `${servers.pub.url}/not-found` });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /status 404/);
  });

  test(`${route}: blocks a WebSocket to an internal address`, async () => {
    const to = encodeURIComponent(`ws://127.0.0.1:${servers.internal.port}/socket`);
    const res = await post(route, { url: `${servers.pub.url}/websocket?to=${to}` });
    assert.equal(res.status, 200);
    assert.ok(servers.pub.hits.includes('GET /done?name=ws'), 'the page made its attempt');
    assert.deepEqual(servers.internal.hits, []);
    assert.ok(proxy.blocked.some((block) => block.target === `127.0.0.1:${servers.internal.port}`));
  });

  test(`${route}: a service worker cannot reach an internal address`, async () => {
    const res = await post(route, { url: `${servers.pub.url}/service-worker` });
    assert.equal(res.status, 200);
    if (route === '/pdf') {
      // Puppeteer: the worker starts, and the proxy blocks its request.
      assert.ok(servers.pub.hits.includes('GET /sw.js'));
      assert.ok(proxy.blocked.some((block) => block.target === `127.0.0.1:${servers.internal.port}`));
    } else {
      // Playwright with serviceWorkers: 'block': the worker never starts.
      assert.ok(!servers.pub.hits.includes('GET /sw.js'));
    }
    assert.deepEqual(servers.internal.hits, []);
  });

  test(`${route}: WebRTC sends no UDP packets`, async () => {
    const udp = await startUdpCounter();
    const res = await post(route, { url: `${servers.pub.url}/webrtc?port=${udp.port}` });
    assert.equal(res.status, 200);
    assert.ok(servers.pub.hits.includes('GET /done?name=webrtc'), 'ICE gathering ended');
    udp.close();
    assert.equal(udp.packets, 0);
  });

  test(`${route}: stops a page with an endless loop at the deadline`, async () => {
    const started = Date.now();
    const res = await post(route, { url: `${servers.pub.url}/loop` });
    assert.equal(res.status, 504);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    // The browser still works.
    const next = await post(route, { url: `${servers.pub.url}/` });
    assert.equal(next.status, 200);
  });

  test(`${route}: runs no JavaScript in supplied HTML`, async () => {
    const started = Date.now();
    const res = await post(route, { html: '<p>Hi</p><script>while (true) {}</script>' });
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 2000);
  });

  test(`${route}: blocks requests after the first 200`, async () => {
    const images = Array.from({ length: 250 }, (_, i) => `<img src="${servers.pub.url}/img?${i}">`).join('');
    const res = await post(route, { html: images });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-blocked-requests'), '50');
  });
}

test('prints at most 50 pages', async () => {
  const html = Array.from({ length: 60 }, (_, i) => `<p style="break-after: page">Page ${i + 1}</p>`).join('');
  assert.equal(await pdfPages(await post('/pdf', { html })), 50);
});

test('the example request renders and blocks its three frames', async () => {
  const body = JSON.parse(await readFile(new URL('../examples/internal-frames.json', import.meta.url), 'utf8'));
  const res = await post('/pdf', body);
  assert.equal(res.headers.get('x-blocked-requests'), '3');
  assert.equal(await pdfPages(res), 1);
});

test('returns 400 for a body with no source or two sources', async () => {
  for (const body of [{}, { url: `${servers.pub.url}/`, html: '<p>x</p>' }, { html: ' ' }, { url: 'not a url' }]) {
    const res = await post('/pdf', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});
