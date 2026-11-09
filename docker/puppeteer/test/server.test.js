import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

let server;
let baseUrl;

before(async () => {
  // Start server.js as its own process on a free port, like the container does.
  server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  while (!output.includes('Listening on')) {
    const [chunk] = await once(server.stdout, 'data');
    output += chunk;
  }
  baseUrl = output.match(/http:\/\/\S+/)[0];
});

after(async () => {
  server.kill('SIGTERM');
  const [code] = await once(server, 'exit');
  assert.equal(code, 0, 'the server must exit with code 0 on SIGTERM');
});

test('GET /health renders a page and returns the browser version', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.browser, /\d+\.\d+\.\d+\.\d+/);
  assert.equal(body.sandbox, true);
});

test('GET /check.png returns a 760 x 260 PNG', async () => {
  const res = await fetch(`${baseUrl}/check.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  // The PNG header stores the width and the height at bytes 16 and 20.
  assert.equal(png.readUInt32BE(16), 760);
  assert.equal(png.readUInt32BE(20), 260);
});

test('GET /check.pdf returns a PDF', async () => {
  const res = await fetch(`${baseUrl}/check.pdf`);
  assert.equal(res.status, 200);
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('an unknown path returns 404', async () => {
  const res = await fetch(`${baseUrl}/nothing`);
  assert.equal(res.status, 404);
});
