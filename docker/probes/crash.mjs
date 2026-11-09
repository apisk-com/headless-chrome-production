// Ends the browser or the renderer processes during a call, and prints what
// the library reports. "browser": the browser process crashes. "renderer":
// SIGKILL to each renderer process, as the kernel does at the memory limit.
// "renderer-no-handler": the same, without the "error" handler of server.js.
import { readdirSync, readFileSync } from 'node:fs';
import { launch, library } from './launch.mjs';

const what = process.argv[2] ?? 'browser';
const browser = await launch();
const context = library === 'playwright'
  ? await browser.newContext()
  : await browser.createBrowserContext();
const page = await context.newPage();
await page.setContent('<p>A page that waits.</p>');

// Puppeteer emits "error" and Playwright emits "crash" when a renderer ends.
page.on('error', (error) => {
  console.log(`  page "error" event: ${error.message}`);
  if (what !== 'renderer-no-handler') {
    // The same handler as in puppeteer/server.js.
    context.close().catch(() => {});
  }
});
page.on('crash', () => console.log('  page "crash" event'));

function killRenderers() {
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (args.includes('--type=renderer')) process.kill(Number(pid), 'SIGKILL');
    } catch {
      // The process ended, or it belongs to another user.
    }
  }
}

// A call that takes 10 seconds. The crash comes after 300 ms.
const pending = page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 10_000)));
setTimeout(async () => {
  if (what.startsWith('renderer')) {
    killRenderers();
  } else {
    const session = library === 'playwright'
      ? await browser.newBrowserCDPSession()
      : await browser.target().createCDPSession();
    session.send('Browser.crash').catch(() => {});
  }
}, 300);

const timeout = new Promise((resolve) => setTimeout(() => resolve('still waiting after 15 s'), 15_000));
try {
  const result = await Promise.race([pending, timeout]);
  console.log(`${library}, ${what}: the call ${result ?? 'returned'}`);
} catch (error) {
  console.log(`${library}, ${what}: ${error.name}: ${error.message.split('\n')[0]}`);
}
await browser.close().catch(() => {});
process.exit(0);
