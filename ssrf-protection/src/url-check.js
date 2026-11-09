import { isIP } from 'node:net';
import { blockedRange } from './ip-policy.js';

// An error that the API returns to the client with this status code.
// A code such as BLOCKED_BY_POLICY tells programs why the job failed.
export function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

// Returns why the browser must not load this URL, or null.
// These checks need no DNS. The egress proxy resolves host names and
// checks the addresses when it connects.
export function urlBlockReason(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `the ${url.protocol} scheme is not allowed`;
  }
  if (url.username || url.password) {
    return 'a user name or password in the URL is not allowed';
  }
  // The URL parser already turned 2130706433, 0177.0.0.1 and 0x7f.1 into
  // 127.0.0.1. Chrome parses host names in the same way.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // Chrome sends localhost and *.localhost to the local host without DNS.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `${host} is the local host`;
  }
  if (isIP(host)) {
    const range = blockedRange(host);
    if (range) {
      return `${host} is in a blocked range: ${range}`;
    }
  }
  return null;
}

// Checks the URL of a job before the browser sees it. Returns the URL as text.
export function checkUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw httpError(400, '"url" must be a string of at most 2048 characters.');
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw httpError(400, '"url" must be an absolute URL.');
  }
  const reason = urlBlockReason(url);
  if (reason) {
    throw httpError(403, `Blocked: ${reason}.`, 'BLOCKED_BY_POLICY');
  }
  return url.href;
}
