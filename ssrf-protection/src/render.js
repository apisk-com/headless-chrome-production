import { chromium } from 'playwright';
import puppeteer from 'puppeteer';
import { guardPlaywrightContext, guardPuppeteerPage } from './guard.js';
import { httpError } from './url-check.js';

// Limits for one job. Change them with environment variables.
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 15_000);
const MAX_JOBS = Number(process.env.MAX_JOBS ?? 4);
const MAX_PDF_PAGES = Number(process.env.MAX_PDF_PAGES ?? 50);

// WebRTC can send UDP packets to any address, past the proxy. This flag
// lets WebRTC use only the proxy, which allows no UDP.
const NO_DIRECT_UDP = '--webrtc-ip-handling-policy=disable_non_proxied_udp';

let pptrBrowser;
let pwBrowser;
let openJobs = 0;

// Both browsers send all traffic through the egress proxy.
// The tests add Chrome flags with extraArgs.
export async function launchBrowsers(proxyUrl, extraArgs = []) {
  pptrBrowser = await puppeteer.launch({
    // Without <-loopback>, Chrome connects to localhost, 127.0.0.0/8 and
    // 169.254.0.0/16 directly, not through the proxy.
    args: [`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>', NO_DIRECT_UDP, ...extraArgs],
    // server.js closes the browsers after open requests finish.
    handleSIGINT: false,
    handleSIGTERM: false,
  });
  // Playwright adds <-loopback> itself. It starts Chromium without the
  // sandbox by default, so turn the sandbox on. The default headless
  // browser (Chrome Headless Shell) ignores the WebRTC flag, so use the
  // full Chromium build ("npx playwright install --no-shell chromium").
  pwBrowser = await chromium.launch({
    channel: 'chromium',
    proxy: { server: proxyUrl },
    args: [NO_DIRECT_UDP, ...extraArgs],
    chromiumSandbox: true,
  });
}

export async function closeBrowsers() {
  await Promise.all([pptrBrowser?.close(), pwBrowser?.close()]);
}

// Runs one job in its own browser context. At the deadline, the context
// closes. This also stops a page that runs an endless loop.
async function runJob(openContext, work) {
  if (openJobs >= MAX_JOBS) {
    throw httpError(503, 'Too many jobs. Try again later.');
  }
  openJobs++;
  let context;
  let timer;
  try {
    context = await openContext();
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(httpError(504, `The job took longer than ${JOB_TIMEOUT_MS} ms.`));
        context.close().catch(() => {});
      }, JOB_TIMEOUT_MS);
    });
    return await Promise.race([work(context), deadline]);
  } finally {
    clearTimeout(timer);
    openJobs--;
    await context?.close().catch(() => {});
  }
}

// An error for a URL that the guard or the proxy blocked.
function blockedError(reason) {
  return httpError(403, `Blocked: ${reason}.`, 'BLOCKED_BY_POLICY');
}

// Loads a job into a page and remembers the last response for the main
// document, also after a script or a meta refresh moves the page.
// Puppeteer and Playwright pages both work here.
async function load(page, job, blocked) {
  const main = { response: null };
  page.on('response', (response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      main.response = response;
    }
  });
  if (job.html) {
    await page.setContent(job.html, { waitUntil: 'load' });
    return main;
  }
  try {
    await page.goto(job.url, { waitUntil: 'load' });
  } catch (error) {
    // The guard blocked the page itself, for example after a redirect.
    if (error.message.includes('net::ERR_BLOCKED_BY_CLIENT')) {
      throw blockedError(blocked.at(-1)?.reason ?? 'the guard blocked the page');
    }
    throw error;
  }
  return main;
}

// Call this after the capture. An error page is never a result.
function checkResult(page, main, blocked) {
  // The proxy answered instead of the site: it blocked the host.
  if (main.response?.headers()['x-egress-blocked']) {
    throw blockedError('the egress proxy refused this host');
  }
  // A navigation failed, and Chrome shows its own error page.
  if (page.url().startsWith('chrome-error://')) {
    throw blocked.length > 0 ? blockedError(blocked.at(-1).reason) : httpError(502, 'The page could not be loaded.');
  }
  const status = main.response?.status() ?? 200;
  if (status >= 400) {
    throw httpError(502, `The page answered with status ${status}.`);
  }
}

// PDF with Puppeteer. Returns { body, blocked }.
export function renderPdf(job) {
  return runJob(() => pptrBrowser.createBrowserContext(), async (context) => {
    const page = await context.newPage();
    const blocked = await guardPuppeteerPage(page);
    // HTML from the caller needs no JavaScript: no loops, no mining, no scans.
    await page.setJavaScriptEnabled(!job.html);
    const main = await load(page, job, blocked);
    const body = await page.pdf({
      format: 'A4',
      printBackground: true,
      // Chrome prints at most these pages, also for a longer document.
      pageRanges: `1-${MAX_PDF_PAGES}`,
    });
    checkResult(page, main, blocked);
    return { body, blocked };
  });
}

// PNG screenshot with Playwright. Returns { body, blocked }.
export function takeScreenshot(job) {
  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    javaScriptEnabled: !job.html,
    // Requests of service workers can skip the route handler.
    serviceWorkers: 'block',
  };
  return runJob(() => pwBrowser.newContext(contextOptions), async (context) => {
    const blocked = await guardPlaywrightContext(context);
    const page = await context.newPage();
    const main = await load(page, job, blocked);
    const body = await page.screenshot({ type: 'png' });
    checkResult(page, main, blocked);
    return { body, blocked };
  });
}
