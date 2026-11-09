# SSRF protection for a screenshot and PDF API

A rendering API with Puppeteer (`POST /pdf`) and Playwright
(`POST /screenshot`) that callers cannot use to reach your internal network.
Server-side request forgery (SSRF) is a request that your server sends to an
address that an attacker picks. The service checks the URL of each job,
checks each request of the browser, sends all browser traffic through an
egress proxy that resolves each host name once and connects only to public
addresses, and limits the time, the requests and the pages of each job. A
Docker Compose file puts the browser on a network with no route out. The
tutorial explains each file:
[Secure a Screenshot or PDF API Against SSRF and Abuse](https://apisk.com/blog/secure-screenshot-pdf-api-ssrf/).

## Requirements

- Node.js 22.12 or later
- Docker with Compose, only for the network rules

## Install

```bash
npm ci
```

```bash
npx playwright install chromium
```

On Linux, add `--with-deps` to the second command. `npm ci` downloads Chrome
for Puppeteer.

## Run

```bash
npm start
```

The service starts the egress proxy on a random local port. To use a proxy
that runs elsewhere, set `EGRESS_PROXY_URL`.

Start two fake internal services (an admin page and a metadata endpoint on
127.0.0.1) in a second terminal:

```bash
npm run fake-internal
```

Ask for the cloud metadata address:

```bash
curl -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d '{"url": "http://169.254.169.254/latest/meta-data/"}'
```

The answer has status 403:
`{"error":"Blocked: 169.254.169.254 is in a blocked range: link-local (cloud metadata 169.254.169.254)."}`

Render HTML with three frames that point to the fake services:

```bash
curl -D - -o frames.pdf -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d @examples/internal-frames.json
```

The PDF has status 200 and the header `X-Blocked-Requests: 3`. The fake
services log no request.

## Test

```bash
npm test
```

The tests start local servers on 127.0.0.1 and [::1] and a fake metadata
endpoint. `test/layers.test.js` shows what each layer misses on its own.
`test.sh` is the CI script for Ubuntu 24.04. It also adds 169.254.169.254 and
fd00:ec2::254 to the loopback interface, runs the commands of this README and
checks the Docker network rules.

## Docker

```bash
docker compose up -d --build --wait
```

```bash
docker compose exec -T renderer curl -s -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d '{"url": "https://example.com/"}' > example.pdf
```

The renderer has no published port. Connect the app that calls it to the
`render` network.

## Files

| File | Use |
|---|---|
| `src/ip-policy.js` | The blocked IPv4 and IPv6 ranges |
| `src/url-check.js` | Checks the URL of a job, without DNS |
| `src/guard.js` | Checks each browser request: Puppeteer request interception, Playwright `route` |
| `src/egress-proxy.js` | The egress proxy: one DNS lookup, a check of each address, a byte limit |
| `src/render.js` | The browsers, the job deadline and the limits |
| `src/app.js`, `src/server.js` | The HTTP API |
| `Dockerfile`, `Dockerfile.proxy`, `compose.yaml` | The renderer, the proxy and the networks |
| `examples/` | The fake internal services and the example request |

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `PORT` | `3000` | HTTP port of the API |
| `EGRESS_PROXY_URL` | none | A proxy that runs elsewhere; without it, the service starts its own |
| `PROXY_PORT` | `3128` | Port of `node src/egress-proxy.js` |
| `JOB_TIMEOUT_MS` | `15000` | Deadline for one job |
| `MAX_JOBS` | `4` | Jobs at the same time; more get status 503 |
| `MAX_REQUESTS` | `200` | Browser requests in one job; more are blocked |
| `MAX_PDF_PAGES` | `50` | Pages in one PDF |
