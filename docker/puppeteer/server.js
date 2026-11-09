import { statfsSync } from 'node:fs';
import { createServer } from 'node:http';
import { userInfo } from 'node:os';
import puppeteer from 'puppeteer';

const PORT = Number(process.env.PORT ?? 3000);
// Keep the sandbox on. Set CHROMIUM_SANDBOX=false only for pages that you trust.
const SANDBOX = process.env.CHROMIUM_SANDBOX !== 'false';
const RENDER_TIMEOUT_MS = 10_000;

// Start Chrome before the server. If it cannot start, the process stops
// here with the error, and the container exits.
const browser = await puppeteer.launch({
  args: SANDBOX ? [] : ['--no-sandbox'],
  // This file closes Chrome on SIGTERM, after open requests finish.
  handleSIGINT: false,
  handleSIGTERM: false,
});
const version = await browser.version();
let stopping = false;

// If Chrome crashes or is killed, stop the service. Docker or Kubernetes
// then starts a new container with a new browser.
browser.on('disconnected', () => {
  if (!stopping) {
    console.error('Chrome closed unexpectedly. Exit with code 1.');
    process.exit(1);
  }
});

// Facts about the container, printed on the check page.
function environment() {
  let shm = 'none';
  try {
    const stats = statfsSync('/dev/shm');
    shm = `${Math.round((stats.blocks * stats.bsize) / 1024 / 1024)} MB`;
  } catch {
    // macOS and Windows have no /dev/shm.
  }
  // A user ID without an entry in /etc/passwd has no name.
  let user = `uid ${process.getuid()}`;
  try {
    user = `${userInfo().username} (${process.getuid()})`;
  } catch {
    // Kubernetes and OpenShift can start containers with such a user ID.
  }
  return `${version} · user ${user} · sandbox ${SANDBOX ? 'on' : 'off'} · /dev/shm ${shm}`;
}

// A page with text in several scripts. A missing font shows as empty boxes.
function checkPage() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<body style="margin: 0; padding: 20px 28px; font: 19px/1.5 sans-serif; color: #111827; background: #ffffff">
  <h1 style="margin: 0 0 6px; font-size: 26px">Puppeteer in Docker</h1>
  <p style="margin: 0 0 14px; font-size: 14px; color: #4b5563">${environment()}</p>
  <p style="margin: 0">Latin: Größe, café, naïve, łódź</p>
  <p style="margin: 0">Chinese: 你好，世界 · Japanese: こんにちは · Korean: 안녕하세요</p>
  <p style="margin: 0">Arabic: مرحبا · Thai: สวัสดี · Emoji: 😀 🚀 ✅ 🐳</p>
</body>
</html>`;
}

// Renders HTML in a new browser context and closes the context in all cases.
async function render(html, type) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    // When the page crashes, Puppeteer emits "error", but open calls do not end.
    // Close the context, so that they fail with "Target closed".
    page.on('error', () => context.close().catch(() => {}));
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setViewport({ width: 760, height: 260 });
    await page.setContent(html);
    return type === 'pdf' ? await page.pdf({ format: 'A4' }) : await page.screenshot();
  } finally {
    await context.close();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health') {
      // A real render: the check fails when Chrome cannot open a page.
      await render('<p>ok</p>', 'png');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', browser: version, sandbox: SANDBOX }));
    } else if (req.url === '/check.png' || req.url === '/check.pdf') {
      const type = req.url.endsWith('.pdf') ? 'pdf' : 'png';
      const body = await render(checkPage(), type);
      res.writeHead(200, { 'Content-Type': type === 'pdf' ? 'application/pdf' : 'image/png' });
      res.end(body);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    console.error(error);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`${environment()}`);
  console.log(`Listening on http://localhost:${server.address().port}`);
});

// Docker sends SIGTERM on "docker stop". Finish open requests, then close Chrome.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    server.close(async () => {
      await browser.close();
      process.exit(0);
    });
  });
}
