import { createApp } from './app.js';
import { createEgressProxy } from './egress-proxy.js';
import { closeBrowsers, launchBrowsers } from './render.js';

const port = Number(process.env.PORT ?? 3000);

// Use the proxy from EGRESS_PROXY_URL (for example a separate container),
// or start one in this process on a random local port.
let proxyUrl = process.env.EGRESS_PROXY_URL;
let proxy;
if (!proxyUrl) {
  proxy = createEgressProxy();
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
}

// Start the browsers first. If they cannot start, the service stops here.
await launchBrowsers(proxyUrl);

const server = createApp().listen(port, (error) => {
  if (error) throw error;
  console.log(`Rendering API on http://localhost:${port}, egress proxy ${proxyUrl}`);
});

// Finish open requests, then close the browsers and the proxy.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      await closeBrowsers();
      proxy?.close();
      process.exit(0);
    });
  });
}
