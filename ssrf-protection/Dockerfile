# The rendering API: Node.js 22, Chrome for Testing for Puppeteer and
# Chromium for Playwright, with their system libraries.
FROM node:22-bookworm-slim

WORKDIR /app
# Keep the browsers in folders that the "node" user can read.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip curl fonts-liberation fonts-noto-color-emoji \
  && npm ci --omit=dev \
  && npx puppeteer browsers install chrome --install-deps \
  && npx playwright install --with-deps --no-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY src ./src

USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s CMD ["curl", "-fsS", "http://127.0.0.1:3000/health"]
CMD ["node", "src/server.js"]
