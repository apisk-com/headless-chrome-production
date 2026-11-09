// Docker runs this file for HEALTHCHECK. Exit code 0 means healthy.
const port = process.env.PORT ?? 3000;
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(8000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
