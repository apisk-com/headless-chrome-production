import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedRange } from '../src/ip-policy.js';

const blocked = [
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['0.0.0.0', 'this network'],
  ['10.1.2.3', 'private network'],
  ['172.31.0.1', 'private network'],
  ['192.168.1.1', 'private network'],
  ['100.100.100.200', 'shared address space'],
  ['169.254.169.254', 'link-local'],
  ['169.254.170.2', 'link-local'],
  ['198.18.0.1', 'benchmark tests'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'reserved and broadcast'],
  ['::1', 'unspecified, loopback'],
  ['::', 'unspecified, loopback'],
  ['::7f00:1', 'unspecified, loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['::ffff:a9fe:a9fe', 'link-local'],
  ['::ffff:10.0.0.1', 'private network'],
  ['64:ff9b::a9fe:a9fe', 'NAT64'],
  ['2002:7f00:1::', '6to4'],
  ['2001::1', 'Teredo'],
  ['fd00:ec2::254', 'unique local'],
  ['fe80::1', 'link-local'],
  ['ff02::1', 'multicast'],
  ['not-an-ip', 'not an IP address'],
];

for (const [address, name] of blocked) {
  test(`blocks ${address}`, () => {
    assert.match(blockedRange(address) ?? 'public', new RegExp(name.replace(/[()]/g, '\\$&')));
  });
}

const allowed = ['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'];

for (const address of allowed) {
  test(`allows the public address ${address}`, () => {
    assert.equal(blockedRange(address), null);
  });
}
