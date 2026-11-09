import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkUrl } from '../src/url-check.js';

// Each URL reaches an internal address or uses a scheme that is not allowed.
// The URL parser turns the short, decimal, octal and hex forms into 127.0.0.1.
const blocked = [
  ['http://127.0.0.1/', 'loopback'],
  ['http://127.1/', 'loopback'],
  ['http://2130706433/', 'loopback'],
  ['http://0177.0.0.1/', 'loopback'],
  ['http://0x7f.0.0.1/', 'loopback'],
  ['http://0x7f000001/', 'loopback'],
  ['http://127.0.0.1./', 'loopback'],
  ['http://0.0.0.0:3000/', 'this network'],
  ['http://0/', 'this network'],
  ['http://169.254.169.254/latest/meta-data/', 'link-local'],
  ['http://[::1]/', 'loopback'],
  ['http://[::ffff:127.0.0.1]/', 'loopback'],
  ['http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'link-local'],
  ['http://[fd00:ec2::254]/latest/meta-data/', 'unique local'],
  ['http://localhost:3000/', 'local host'],
  ['http://LOCALHOST./', 'local host'],
  ['http://admin.localhost/', 'local host'],
  ['file:///etc/passwd', 'file: scheme'],
  ['ftp://example.com/', 'ftp: scheme'],
  ['javascript:alert(1)', 'javascript: scheme'],
  ['http://user:secret@example.com/', 'user name or password'],
];

for (const [url, reason] of blocked) {
  test(`blocks ${url}`, () => {
    assert.throws(() => checkUrl(url), (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, new RegExp(reason));
      return true;
    });
  });
}

test('allows public URLs and returns the parsed form', () => {
  assert.equal(checkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(checkUrl('http://8.8.8.8:8080/'), 'http://8.8.8.8:8080/');
  // A name is not resolved here. The egress proxy checks its addresses.
  assert.equal(checkUrl('http://metadata.google.internal/'), 'http://metadata.google.internal/');
});

test('returns 400 for input that is not a URL', () => {
  for (const input of ['not a url', '/relative', 42, 'http://x/'.padEnd(3000, 'a')]) {
    assert.throws(() => checkUrl(input), (error) => error.status === 400);
  }
});
