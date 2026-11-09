// Crashes the page (renderer process) or the whole browser during a call,
// and prints what the library reports.
import { launch, library, newPage } from './launch.mjs';

const what = process.argv[2] ?? 'browser';
const browser = await launch();
const page = await newPage(browser, { width: 800, height: 600 });
await page.setContent('<p>A page that waits.</p>');
// Puppeteer emits "error" and Playwright emits "crash" when the renderer crashes.
page.on('error', (error) => console.log(`${library}, ${what} crash, page "error" event: ${error.message}`));
page.on('crash', () => console.log(`${library}, ${what} crash, page "crash" event`));

// A call that takes 10 seconds. The crash comes after 300 ms.
const pending = page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 10_000)));
setTimeout(async () => {
  const session = library === 'playwright'
    ? await (what === 'page' ? page.context().newCDPSession(page) : browser.newBrowserCDPSession())
    : await (what === 'page' ? page.createCDPSession() : browser.target().createCDPSession());
  session.send(what === 'page' ? 'Page.crash' : 'Browser.crash').catch(() => {});
}, 300);

const timeout = new Promise((resolve) => setTimeout(() => resolve('still waiting after 15 s'), 15_000));
try {
  const result = await Promise.race([pending, timeout]);
  console.log(`${library}, ${what} crash, the call: ${result ?? 'returned'}`);
} catch (error) {
  console.log(`${library}, ${what} crash, the call: ${error.name}: ${error.message.split('\n')[0]}`);
}
await browser.close().catch(() => {});
process.exit(0);
