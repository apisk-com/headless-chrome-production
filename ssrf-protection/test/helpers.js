// Local servers for the tests. Nothing here leaves the machine.
//
// - "internal": 127.0.0.1. It records every request and WebSocket upgrade.
// - "metadata": a fake cloud metadata endpoint on 127.0.0.1. When
//   FAKE_METADATA_ALIASES=1 (test.sh adds the addresses to the loopback
//   interface in CI), it also listens on 169.254.169.254 and fd00:ec2::254.
// - "public": [::1], reached by the browser as public.test. In the tests,
//   the egress proxy treats ::1 as a public address (allowAddresses).
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { createEgressProxy } from '../src/egress-proxy.js';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function recordingServer(hits, body) {
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'text/html');
    res.end(body);
  });
  server.on('upgrade', (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  return server;
}

// The frame /wait?for=<name> holds the load event of a page until the page
// calls /done?name=<name> (or for 2 seconds). So the attempt of the page
// ends before the job prints the page and closes the browser context.
const WAIT = (name) => `<iframe src="/wait?for=${name}" style="display: none"></iframe>`;

// Pages of the "public" site. Each one tries one way into the network.
function publicPage(url, internalUrl) {
  const query = url.searchParams;
  switch (url.pathname) {
    case '/redirect':
      return { status: 302, headers: { Location: query.get('to') } };
    case '/script-redirect':
      return { html: `<script>location.href = ${JSON.stringify(query.get('to'))};</script>` };
    case '/not-found':
      return { status: 404, html: '<h1>Not found</h1>' };
    case '/websocket':
      return { html: `<p>WebSocket</p>${WAIT('ws')}<script>
        const ws = new WebSocket(${JSON.stringify(query.get('to'))});
        ws.onerror = ws.onclose = () => fetch('/done?name=ws');
      </script>` };
    case '/service-worker':
      return { html: `<p>Service worker</p>${WAIT('sw')}<script>
        navigator.serviceWorker.register('/sw.js').catch(() => fetch('/done?name=sw'));
      </script>` };
    case '/sw.js':
      return {
        headers: { 'Content-Type': 'text/javascript' },
        body: `self.addEventListener('install', (event) => {
          event.waitUntil(fetch('${internalUrl}/from-service-worker', { mode: 'no-cors' })
            .catch(() => {})
            .then(() => fetch('/done?name=sw')));
        });`,
      };
    case '/webrtc':
      return { html: `<p>WebRTC</p>${WAIT('webrtc')}<script>
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${query.get('port')}' }] });
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') fetch('/done?name=webrtc');
        };
        pc.createDataChannel('x');
        pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      </script>` };
    case '/loop':
      return { html: '<p>Loop</p><script>while (true) {}</script>' };
    case '/big':
      return { headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(3 * 1024 * 1024) };
    default:
      return { html: '<h1>Public test page</h1>' };
  }
}

export async function startServers() {
  const internal = { hits: [] };
  const internalServer = recordingServer(internal.hits, '<h1>INTERNAL SECRET</h1>');
  internal.port = await listen(internalServer, 0, '127.0.0.1');
  internal.url = `http://127.0.0.1:${internal.port}`;

  const metadata = { hits: [], aliases: [] };
  const metadataServers = [recordingServer(metadata.hits, '{"AccessKeyId": "FAKE"}')];
  metadata.port = await listen(metadataServers[0], 0, '127.0.0.1');
  if (process.env.FAKE_METADATA_ALIASES === '1') {
    for (const address of ['169.254.169.254', 'fd00:ec2::254']) {
      const server = recordingServer(metadata.hits, '{"AccessKeyId": "FAKE"}');
      await listen(server, metadata.port, address);
      metadataServers.push(server);
      metadata.aliases.push(address);
    }
  }

  const pub = { hits: [] };
  const done = new Set();
  const waiting = new Map();
  const publicServer = createServer((req, res) => {
    pub.hits.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://public.test');
    if (url.pathname === '/done') {
      const name = url.searchParams.get('name');
      done.add(name);
      for (const waiter of waiting.get(name) ?? []) waiter();
      return res.end('ok');
    }
    if (url.pathname === '/wait') {
      const name = url.searchParams.get('for');
      if (done.has(name)) return res.end('ok');
      const answer = () => res.writableEnded || res.end('ok');
      waiting.set(name, [...(waiting.get(name) ?? []), answer]);
      setTimeout(answer, 2000).unref();
      return;
    }
    const page = publicPage(url, internal.url);
    res.writeHead(page.status ?? 200, page.headers ?? { 'Content-Type': 'text/html' });
    res.end(page.html ?? page.body);
  });
  pub.port = await listen(publicServer, 0, '::1');
  pub.url = `http://public.test:${pub.port}`;

  const servers = [internalServer, publicServer, ...metadataServers];
  return {
    internal,
    metadata,
    pub,
    // Chrome allows service workers only on secure origins. This flag makes
    // the test origin secure. Never use it in production.
    secureOriginFlag: `--unsafely-treat-insecure-origin-as-secure=http://public.test:${pub.port}`,
    reset() {
      internal.hits.length = 0;
      metadata.hits.length = 0;
      pub.hits.length = 0;
      done.clear();
      waiting.clear();
    },
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    },
  };
}

// A DNS stand-in: maps names to addresses. A function value can give a new
// answer on each call. lookup.calls records each name that was resolved.
export function testLookup(names) {
  const lookup = async (hostname) => {
    lookup.calls.push(hostname);
    const value = typeof names[hostname] === 'function' ? names[hostname]() : names[hostname];
    if (!value) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    }
    return [value].flat().map((address) => ({ address, family: isIP(address) }));
  };
  lookup.calls = [];
  return lookup;
}

// The egress proxy with the test DNS. ::1 plays the public internet.
export async function startProxy(options = {}) {
  const blocked = [];
  const proxy = createEgressProxy({
    lookup: testLookup({ 'public.test': '::1', 'metadata.test': '127.0.0.1' }),
    allowAddresses: ['::1'],
    onBlock: (target, reason) => blocked.push({ target, reason }),
    ...options,
  });
  const port = await listen(proxy, 0, '127.0.0.1');
  return { proxy, blocked, url: `http://127.0.0.1:${port}` };
}

// Counts UDP packets, for the WebRTC tests.
export async function startUdpCounter() {
  const socket = dgram.createSocket('udp4');
  const counter = { packets: 0, close: () => socket.close() };
  socket.on('message', () => counter.packets++);
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  counter.port = socket.address().port;
  return counter;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
