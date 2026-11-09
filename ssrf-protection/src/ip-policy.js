import { BlockList, isIP } from 'node:net';

// Address ranges that the browser must never connect to, from the IANA
// special-purpose address registries for IPv4 and IPv6.
const RANGES = [
  ['0.0.0.0', 8, 'this network (0.0.0.0 reaches the local host)'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'shared address space (carrier-grade NAT)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata 169.254.169.254)'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmark tests'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved and broadcast'],
  // BlockList checks IPv4-mapped addresses (::ffff:127.0.0.1) against the
  // IPv4 ranges. Do not add ::ffff:0:0/96: it matches every IPv4 address.
  ['::', 96, 'unspecified, loopback or IPv4-compatible'],
  ['64:ff9b::', 96, 'NAT64 (reaches IPv4 addresses)'],
  ['64:ff9b:1::', 48, 'local NAT64'],
  ['100::', 64, 'discard only'],
  ['2001::', 23, 'IETF protocol assignments (Teredo)'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4 (reaches IPv4 addresses)'],
  ['fc00::', 7, 'unique local (AWS metadata fd00:ec2::254)'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

// One BlockList for each range, so that a block can name its range.
const rules = RANGES.map(([network, prefix, name]) => {
  const list = new BlockList();
  list.addSubnet(network, prefix, isIP(network) === 4 ? 'ipv4' : 'ipv6');
  return { list, name };
});

// Returns the name of the range that contains the address, or null for a
// public address. A string that is not an IP address is blocked too.
export function blockedRange(address) {
  const family = isIP(address);
  if (family === 0) {
    return 'not an IP address';
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return rules.find((rule) => rule.list.check(address, type))?.name ?? null;
}
