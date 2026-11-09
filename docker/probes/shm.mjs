// Takes a full-page screenshot of a tall page, three times.
// "use-dev-shm" removes --disable-dev-shm-usage, so Chrome uses /dev/shm.
import { statfsSync } from 'node:fs';
import { launch, library, newPage } from './launch.mjs';

const mode = process.argv[2] ?? 'default';
const ignore = mode === 'use-dev-shm' ? ['--disable-dev-shm-usage'] : [];
const stats = statfsSync('/dev/shm');
const shmMb = Math.round((stats.blocks * stats.bsize) / 1024 / 1024);

// 200 colored blocks, 80 px each: a page 16,000 px tall.
const blocks = Array.from({ length: 200 }, (_, i) =>
  `<div style="height:80px;background:hsl(${(i * 37) % 360} 70% 60%);font:40px sans-serif">Block ${i}</div>`,
).join('');

const browser = await launch(ignore);
const times = [];
try {
  for (let i = 0; i < 3; i++) {
    const page = await newPage(browser, { width: 1920, height: 1080 });
    await page.setContent(`<body style="margin:0">${blocks}</body>`);
    const start = performance.now();
    const png = await page.screenshot({ fullPage: true });
    times.push(Math.round(performance.now() - start));
    await page.close();
    if (i === 0) console.log(`  PNG: ${png.length} bytes`);
  }
  console.log(`${library}, ${mode}, /dev/shm ${shmMb} MB: OK, screenshot times ${times.join(', ')} ms`);
} catch (error) {
  console.log(`${library}, ${mode}, /dev/shm ${shmMb} MB: FAILED`);
  console.log(String(error.stack ?? error).split('\n').slice(0, 6).join('\n'));
  process.exitCode = 3;
} finally {
  await browser.close().catch(() => {});
}
