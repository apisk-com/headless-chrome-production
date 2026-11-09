import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, request as httpRequest, STATUS_CODES } from 'node:http';
import { connect, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { blockedRange } from './ip-policy.js';

// Headers for the hop to the proxy. They must not go to the target server.
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

// An HTTP proxy for the browser. For each connection it resolves the host
// name once, checks every address, and connects to the address it checked.
export function createEgressProxy({
  // Returns all addresses of a host name as [{ address, family }].
  lookup = (hostname) => dnsLookup(hostname, { all: true }),
  // Exact addresses that are allowed although they are in a blocked range.
  allowAddresses = [],
  maxBytes = 25 * 1024 * 1024,
  idleTimeoutMs = 20_000,
  onBlock = (target, reason) => console.warn(JSON.stringify({ egressBlocked: target, reason })),
} = {}) {
  // Returns the address to connect to, or throws. Never give the host name
  // to connect(): that is a second DNS lookup, and its answer can differ.
  async function resolve(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    const answers = isIP(host) ? [{ address: host }] : await lookup(host);
    if (answers.length === 0) {
      throw new Error(`${host} has no address`);
    }
    // If one address is internal, block the name, not only that address.
    for (const { address } of answers) {
      const range = allowAddresses.includes(address) ? null : blockedRange(address);
      if (range) {
        throw Object.assign(new Error(`${address} is in a blocked range: ${range}`), { blocked: true });
      }
    }
    return answers[0].address;
  }

  // 403 with a header for a blocked target, 502 when DNS fails.
  function refuse(target, error) {
    if (error.blocked) {
      onBlock(target, error.message);
      return { status: 403, headers: { 'X-Egress-Blocked': 'true' }, text: 'Blocked by the egress proxy.\n' };
    }
    return { status: 502, headers: {}, text: 'The egress proxy could not reach this host.\n' };
  }

  // Closes all streams after maxBytes in total (both directions).
  function limitBytes(target, sources, all) {
    let bytes = 0;
    for (const source of sources) {
      source.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          onBlock(target, `more than ${maxBytes} bytes`);
          for (const stream of all) stream.destroy();
        }
      });
    }
  }

  // Plain http:// requests arrive with the full URL: GET http://host/path.
  const server = createServer(async (req, res) => {
    let target;
    let address;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('Only http:// URLs come without CONNECT.');
      address = await resolve(target.hostname);
    } catch (error) {
      // Send a text body: Chromium shows its own error page for an empty one.
      const { status, headers, text } = refuse(target?.host ?? req.url, error);
      return res.writeHead(status, { ...headers, 'Content-Type': 'text/plain' }).end(text);
    }
    const headers = { ...req.headers };
    for (const name of HOP_HEADERS) delete headers[name];
    const upstream = httpRequest({
      host: address,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers, // The Host header keeps the host name.
      timeout: idleTimeoutMs,
    }, (response) => {
      for (const name of HOP_HEADERS) delete response.headers[name];
      res.writeHead(response.statusCode, response.headers);
      limitBytes(target.host, [response], [response, res]);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });

  // https:// and WebSocket connections arrive as CONNECT host:port.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    let target;
    let address;
    try {
      target = new URL(`http://${req.url}`);
      address = await resolve(target.hostname);
    } catch (error) {
      const { status, headers } = refuse(req.url, error);
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      return client.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines}Content-Length: 0\r\n\r\n`);
    }
    let connected = false;
    const upstream = connect({ host: address, port: Number(target.port || 443) });
    upstream.on('error', () => {
      if (connected) return client.destroy();
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.once('connect', () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      limitBytes(req.url, [client, upstream], [client, upstream]);
      for (const socket of [client, upstream]) {
        socket.setTimeout(idleTimeoutMs, () => {
          client.destroy();
          upstream.destroy();
        });
      }
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  return server;
}

// Run this file to start the proxy on its own, for example in a container.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PROXY_PORT ?? 3128);
  createEgressProxy().listen(port, () => console.log(`Egress proxy on port ${port}`));
}
