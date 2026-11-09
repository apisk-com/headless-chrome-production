// Starts the browser with Puppeteer or Playwright, whichever the image has.
// test.sh mounts the probes into /app, next to node_modules, and runs them there.
import { existsSync } from 'node:fs';

export const library = existsSync('node_modules/playwright') ? 'playwright' : 'puppeteer';

export async function launch(ignoreDefaultArgs = []) {
  if (library === 'playwright') {
    const { chromium } = await import('playwright');
    return chromium.launch({ chromiumSandbox: true, ignoreDefaultArgs });
  }
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({ ignoreDefaultArgs });
}

export async function newPage(browser, viewport) {
  if (library === 'playwright') {
    return browser.newPage({ viewport });
  }
  const page = await browser.newPage();
  await page.setViewport(viewport);
  return page;
}
