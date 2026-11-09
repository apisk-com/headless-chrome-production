import { urlBlockReason } from './url-check.js';

// A page that makes more requests than this is scanning, not rendering.
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS ?? 200);

// Returns why the browser must not send this request, or null.
// data: and blob: URLs do not use the network.
function requestBlockReason(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return null;
  }
  return urlBlockReason(url);
}

// Makes one decision for each request: a reason to block it, or null.
function createChecker(blocked) {
  let count = 0;
  return (href) => {
    count++;
    const reason = count > MAX_REQUESTS ? 'too many requests' : requestBlockReason(href);
    if (reason) {
      blocked.push({ url: href.slice(0, 200), reason });
    }
    return reason;
  };
}

// Puppeteer: checks every request of the page, also each redirect.
// Returns the list of blocked requests.
export async function guardPuppeteerPage(page) {
  const blocked = [];
  const check = createChecker(blocked);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // abort() and continue() fail when the page is already closed.
    const done = check(request.url())
      ? request.abort('blockedbyclient')
      : request.continue();
    done.catch(() => {});
  });
  return blocked;
}

// Playwright: checks every request of the context. Playwright does not show
// redirects to the route handler; the egress proxy checks those.
// Create the context with serviceWorkers: 'block'.
export async function guardPlaywrightContext(context) {
  const blocked = [];
  const check = createChecker(blocked);
  await context.route('**/*', (route) => {
    const done = check(route.request().url())
      ? route.abort('blockedbyclient')
      : route.continue();
    return done.catch(() => {});
  });
  return blocked;
}
