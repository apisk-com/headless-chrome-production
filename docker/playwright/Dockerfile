# The official Playwright image: Ubuntu 24.04, Node.js, all Playwright browsers,
# their libraries and fonts. The tag must match "playwright" in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

# tini runs as process 1 and collects ended Chromium processes (zombies).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# The image has the browsers in /ms-playwright. npm ci adds only the library.
RUN npm ci --omit=dev
COPY server.js healthcheck.js ./

# The image runs as root by default, and Chromium has no sandbox as root.
USER pwuser
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s CMD ["node", "healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
