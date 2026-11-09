import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { startProxy, startServers, testLookup } from './helpers.js';

let servers;
let proxies = [];

before(async () => {
  servers = await startServers();
});

beforeEach(() => servers.reset());

after(async () => {
  for (const { proxy } of proxies) {
    proxy.closeAllConnections();
    proxy.close();
  }
  await servers.close();
});

async function proxyWith(options) {
  const started = await startProxy(options);
  proxies.push(started);
  return started;
}

// A plain http:// request through the proxy, as Chrome sends it.
function httpGet(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, path: target, headers: { Host: new URL(target).host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (error) => resolve({ status: res.statusCode, error, bytes: Buffer.concat(chunks).length }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A CONNECT request, as Chrome sends it for https:// and WebSockets.
function connectTo(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, headers: res.headers, socket }));
    req.on('error', reject);
    req.end();
  });
}

test('forwards a request to a public host', async () => {
  const { url } = await proxyWith();
  const res = await httpGet(url, `${servers.pub.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.body.toString(), /Public test page/);
});

test('blocks internal addresses for http:// requests', async () => {
  const { url, blocked } = await proxyWith();
  for (const target of [`${servers.internal.url}/`, `http://metadata.test:${servers.metadata.port}/latest/meta-data/`]) {
    const res = await httpGet(url, target);
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-egress-blocked'], 'true');
  }
  assert.equal(blocked.length, 2);
  assert.deepEqual(servers.internal.hits, []);
  assert.deepEqual(servers.metadata.hits, []);
});

test('blocks internal addresses for CONNECT tunnels', async () => {
  const { url } = await proxyWith();
  for (const target of [`127.0.0.1:${servers.internal.port}`, '[fd00:ec2::254]:443', '169.254.169.254:80', `metadata.test:${servers.metadata.port}`]) {
    const res = await connectTo(url, target);
    assert.equal(res.status, 403, target);
    res.socket.destroy();
  }
  assert.deepEqual(servers.internal.hits, []);
  assert.deepEqual(servers.metadata.hits, []);
});

test('opens a tunnel to a public host', async () => {
  const { url } = await proxyWith();
  const res = await connectTo(url, `public.test:${servers.pub.port}`);
  assert.equal(res.status, 200);
  res.socket.write(`GET /tunnel HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
  const chunks = [];
  for await (const chunk of res.socket) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /200 OK[\s\S]*Public test page/);
});

test('blocks a name when one of its addresses is internal', async () => {
  const lookup = testLookup({ 'mixed.test': ['::1', '127.0.0.1'] });
  const { url } = await proxyWith({ lookup });
  const res = await httpGet(url, `http://mixed.test:${servers.pub.port}/`);
  assert.equal(res.status, 403);
  assert.deepEqual(servers.pub.hits, []);
});

test('DNS rebinding: each connection resolves once and goes to the checked address', async () => {
  // The first answer is public, every later answer is internal.
  let answers = 0;
  const lookup = testLookup({ 'rebind.test': () => (answers++ === 0 ? '::1' : '127.0.0.1') });
  const { url } = await proxyWith({ lookup });

  const first = await httpGet(url, `http://rebind.test:${servers.pub.port}/first`);
  assert.equal(first.status, 200);
  const second = await httpGet(url, `http://rebind.test:${servers.internal.port}/second`);
  assert.equal(second.status, 403);

  // One lookup for each request: connect() got the address, not the name.
  assert.deepEqual(lookup.calls, ['rebind.test', 'rebind.test']);
  assert.deepEqual(servers.pub.hits, ['GET /first']);
  assert.deepEqual(servers.internal.hits, []);
});

test('returns 502 when the name does not resolve', async () => {
  const { url, blocked } = await proxyWith();
  const res = await httpGet(url, 'http://unknown.test/');
  assert.equal(res.status, 502);
  assert.deepEqual(blocked, []);
});

test('stops a response after maxBytes', async () => {
  const { url, blocked } = await proxyWith({ maxBytes: 1024 * 1024 });
  const res = await httpGet(url, `${servers.pub.url}/big`);
  assert.ok(res.error, 'the response must end with an error');
  assert.ok(res.bytes <= 1.5 * 1024 * 1024, `got ${res.bytes} bytes`);
  assert.match(blocked[0].reason, /more than 1048576 bytes/);
});
