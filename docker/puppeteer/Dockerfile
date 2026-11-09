# The official Puppeteer image: Debian 12, Node.js 24, Chrome for Testing, its
# libraries and fonts for Chinese, Japanese and Thai. It is built for amd64 only.
# The tag must match "puppeteer" in package-lock.json.
FROM ghcr.io/puppeteer/puppeteer:25.16.0

# The image has no init process and no emoji font.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Chrome is already in /home/pptruser/.cache/puppeteer. Do not download it again.
# If the versions differ, the service stops at start with "Could not find Chrome".
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev
COPY server.js healthcheck.js ./

USER pptruser
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s CMD ["node", "healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
