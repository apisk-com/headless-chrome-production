# Run Puppeteer and Playwright in Docker

Four Dockerfiles for a small Puppeteer service and a small Playwright service.
Each image runs the browser as a non-root user with the Chrome sandbox on,
starts `tini` as process 1 and has a health check that renders a page. The CI
script `test.sh` builds the images, breaks them on purpose and records each
error. The tutorial explains each file and each error:
[Run Puppeteer and Playwright in Docker Without Crashes](https://apisk.com/blog/puppeteer-playwright-docker/).

## Requirements

- Docker
- Node.js 22.12 or later, only to run the tests without Docker

## Files

| File | Use |
|---|---|
| `puppeteer/Dockerfile.slim` | `node:22-bookworm-slim`, Puppeteer 25.16.0, Chrome for Testing and fonts |
| `puppeteer/Dockerfile` | The Puppeteer image `ghcr.io/puppeteer/puppeteer:25.16.0` (amd64 only) |
| `playwright/Dockerfile.slim` | `node:22-bookworm-slim`, Playwright 1.65.0 and the Chromium headless shell |
| `playwright/Dockerfile` | The Playwright image `mcr.microsoft.com/playwright:v1.65.0-noble` |
| `*/server.js` | The service: `GET /health`, `GET /check.png`, `GET /check.pdf` |
| `*/healthcheck.js` | The `HEALTHCHECK` command |
| `probes/` | Scripts that `test.sh` runs in the containers: zombies, crashes, fonts, `/dev/shm` |
| `test.sh` | The CI script |

## Build and run

In the `puppeteer` or the `playwright` folder:

```bash
docker build -t puppeteer-docker -f Dockerfile.slim .
```

```bash
docker run --rm --cap-add=SYS_ADMIN -p 3000:3000 puppeteer-docker
```

```bash
curl http://localhost:3000/health
```

The answer is `{"status":"ok","browser":"Chrome/156.0.8078.47","sandbox":true}`.
`curl -o check.png http://localhost:3000/check.png` saves a test page with
text in seven scripts. Empty boxes in that image show missing fonts.

## Run without SYS_ADMIN

Make a seccomp profile: the default profile of Docker plus one rule for the
system calls of the Chrome sandbox. You need `jq`.

```bash
curl -fsSL https://raw.githubusercontent.com/moby/profiles/seccomp/v0.3.0/seccomp/default.json | jq '.syscalls += [{"names": ["clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW"}]' > chrome-seccomp.json
```

```bash
docker run --rm --security-opt seccomp=chrome-seccomp.json -p 3000:3000 puppeteer-docker
```

Set `CHROMIUM_SANDBOX=false` only for pages that you wrote yourself. It turns
off the Chrome sandbox.

## Environment variables

| Variable | Use |
|---|---|
| `PORT` | HTTP port, default 3000 |
| `CHROMIUM_SANDBOX` | `false` turns off the sandbox |

## Test

```bash
npm ci
```

```bash
npm test
```

Run both commands in the `puppeteer` and in the `playwright` folder. For
Playwright, first run `npx playwright install --only-shell chromium`.
`test.sh` is the CI script for Ubuntu 24.04. It also builds the images and
checks the errors: missing libraries, root user, no sandbox rights, seccomp
profiles, hosts that restrict user namespaces, missing fonts, zombie
processes, memory limits and the restart after a browser crash.
