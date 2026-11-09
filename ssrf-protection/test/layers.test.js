// What each layer misses on its own. These tests use the guards without
// the egress proxy (or without one of its settings) and expect a leak to a
// local test server. If a browser update closes a gap, a test here fails.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { chromium } from 'playwright';
import puppeteer from 'puppeteer';
import { guardPlaywrightContext, guardPuppeteerPage } from '../src/guard.js';
import { sleep, startProxy, startServers, startUdpCounter } from './helpers.js';

let servers;
let proxy;

before(async () => {
  servers = await startServers();
  proxy = await startProxy();
});

beforeEach(() => servers.reset());

after(async () => {
  proxy.proxy.closeAllConnections();
  proxy.proxy.close();
  await servers.close();
});

// Without the proxy, Chrome resolves public.test itself: map it to [::1].
const mapPublic = () => `--host-resolver-rules=MAP public.test [::1]`;

async function withPuppeteer(args, work) {
  const browser = await puppeteer.launch({ args });
  try {
    const page = await (await browser.createBrowserContext()).newPage();
    const blocked = await guardPuppeteerPage(page);
    return await work(page, blocked);
  } finally {
    await browser.close();
  }
}

async function withPlaywright(launchOptions, work) {
  const browser = await chromium.launch({ channel: 'chromium', chromiumSandbox: true, ...launchOptions });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const blocked = await guardPlaywrightContext(context);
    return await work(await context.newPage(), blocked);
  } finally {
    await browser.close();
  }
}

test('Puppeteer interception sees each redirect and blocks it', async () => {
  const to = encodeURIComponent(`${servers.internal.url}/after-redirect`);
  await withPuppeteer([mapPublic()], async (page) => {
    await assert.rejects(page.goto(`${servers.pub.url}/redirect?to=${to}`), /ERR_BLOCKED_BY_CLIENT/);
  });
  assert.deepEqual(servers.internal.hits, []);
});

test('gap: Playwright route does not see the redirect', async () => {
  const to = encodeURIComponent(`${servers.internal.url}/after-redirect`);
  await withPlaywright({ args: [mapPublic()] }, async (page, blocked) => {
    await page.goto(`${servers.pub.url}/redirect?to=${to}`);
    assert.deepEqual(blocked, []);
  });
  assert.deepEqual(servers.internal.hits, ['GET /after-redirect']);
});

test('gap: neither guard sees WebSockets', async () => {
  const to = encodeURIComponent(`ws://127.0.0.1:${servers.internal.port}/socket`);
  const url = `${servers.pub.url}/websocket?to=${to}`;
  await withPuppeteer([mapPublic()], (page) => page.goto(url));
  await withPlaywright({ args: [mapPublic()] }, (page) => page.goto(url));
  assert.deepEqual(servers.internal.hits, ['UPGRADE /socket', 'UPGRADE /socket']);
});

test('gap: Puppeteer interception does not see a service worker', async () => {
  await withPuppeteer([mapPublic(), servers.secureOriginFlag], (page) => page.goto(`${servers.pub.url}/service-worker`));
  assert.deepEqual(servers.internal.hits, ['GET /from-service-worker']);
});

test('gap: a check of the host name does not stop a name that points inside', async () => {
  // The attacker's DNS answers 127.0.0.1. Chrome resolves the name itself,
  // after every check in your code.
  await withPuppeteer([`--host-resolver-rules=MAP rebind.test 127.0.0.1`], async (page, blocked) => {
    await page.goto(`http://rebind.test:${servers.internal.port}/rebind`);
    assert.deepEqual(blocked, []);
  });
  assert.deepEqual(servers.internal.hits, ['GET /rebind']);
});

test('gap: without <-loopback>, Puppeteer sends loopback and link-local past the proxy', async () => {
  const targets = [`127.0.0.1:${servers.internal.port}`];
  if (servers.metadata.aliases.includes('169.254.169.254')) {
    targets.push(`169.254.169.254:${servers.metadata.port}`);
  }
  for (const target of targets) {
    const to = encodeURIComponent(`ws://${target}/socket`);
    // The proxy resolves public.test. Only the bypass list is missing.
    await withPuppeteer([`--proxy-server=${proxy.url}`], (page) => page.goto(`${servers.pub.url}/websocket?to=${to}`));
  }
  assert.deepEqual(servers.internal.hits, ['UPGRADE /socket']);
  assert.deepEqual(servers.metadata.hits, targets.length > 1 ? ['UPGRADE /socket'] : []);
  assert.deepEqual(proxy.blocked, []);
});

test('gap: Chrome Headless Shell ignores the WebRTC flag', async () => {
  const udp = await startUdpCounter();
  const browser = await chromium.launch({ args: ['--webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const page = await browser.newPage();
  await page.evaluate((port) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
    pc.createDataChannel('x');
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  }, udp.port);
  for (let i = 0; i < 50 && udp.packets === 0; i++) await sleep(100);
  await browser.close();
  udp.close();
  assert.ok(udp.packets > 0, 'STUN packets reached 127.0.0.1');
});

test('gap: Chrome opens http://0.0.0.0/ and reaches the local host', async () => {
  const server = createServer((req, res) => res.end('local service'));
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(`http://0.0.0.0:${server.address().port}/`);
    assert.equal(response.status(), 200);
    assert.match(await page.content(), /local service/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the guard blocks what Chrome would open: 0.0.0.0 and the decimal form of 127.0.0.1', async () => {
  await withPuppeteer([], async (page, blocked) => {
    await page.setContent(`<img src="http://0.0.0.0:${servers.internal.port}/a"><img src="http://2130706433:${servers.internal.port}/b">`);
    await sleep(200);
    assert.equal(blocked.length, 2);
  });
  assert.deepEqual(servers.internal.hits, []);
});
