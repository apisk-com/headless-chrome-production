#!/usr/bin/env bash
# CI entry point for Ubuntu 24.04.
# 1. Adds the metadata addresses to the loopback interface, so that the fake
#    metadata server in the tests listens on 169.254.169.254 and fd00:ec2::254.
# 2. Installs the packages and browsers, and runs the tests.
# 3. Runs the commands from the README: npm start and the curl requests.
# 4. Starts the Docker Compose setup and checks the egress network rules.
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
pids=()

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

remove_aliases() {
  sudo ip addr del 169.254.169.254/32 dev lo 2> /dev/null || true
  sudo ip -6 addr del fd00:ec2::254/128 dev lo 2> /dev/null || true
}

cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2> /dev/null || true; done
  remove_aliases
  docker rm -f fake-metadata > /dev/null 2>&1 || true
  docker compose down --volumes > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "== 1. Fake metadata addresses on the loopback interface"
sudo ip addr add 169.254.169.254/32 dev lo
sudo ip -6 addr add fd00:ec2::254/128 dev lo
export FAKE_METADATA_ALIASES=1

echo "== 2. Install and test"
npm ci
# Chromium for the service, and Chrome Headless Shell for one test in layers.test.js.
npx playwright install --with-deps chromium
npm test
remove_aliases
unset FAKE_METADATA_ALIASES

echo "== 3. The README commands"
npm run fake-internal > "$work/fake-internal.log" 2>&1 &
pids+=($!)
npm start > "$work/server.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 60); do
  curl -fsS http://localhost:3000/health > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://localhost:3000/health > /dev/null || { cat "$work/server.log"; fail "the service did not start"; }

status=$(curl -s -o "$work/metadata.json" -w '%{http_code}' -X POST http://localhost:3000/pdf \
  -H "Content-Type: application/json" \
  -d '{"url": "http://169.254.169.254/latest/meta-data/"}')
echo "metadata URL: $status $(cat "$work/metadata.json")"
[ "$status" = 403 ] || fail "the metadata URL must return 403"

# The same commands as in the README and the article.
curl -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d '{"url": "http://169.254.169.254/latest/meta-data/"}' > "$work/readme-metadata.json"
grep -q '"code":"BLOCKED_BY_POLICY"' "$work/readme-metadata.json" || fail "the README metadata request must be blocked"
curl -D - -o frames.pdf -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d @examples/internal-frames.json > "$work/headers.txt"
grep -i '^x-blocked-requests' "$work/headers.txt"
grep -qi '^x-blocked-requests: 3' "$work/headers.txt" || fail "the three frames must be blocked"
[ "$(head -c 5 frames.pdf)" = "%PDF-" ] || fail "no PDF"
rm frames.pdf
if grep -E 'admin:|metadata:' "$work/fake-internal.log"; then
  fail "a request reached the fake internal services"
fi
echo "fake internal services: no requests"
grep 'blocked' "$work/server.log" | head -3

echo "== 4. Docker: the renderer has no route out, only the proxy"
docker compose up -d --build --wait
docker image ls --format '{{.Repository}} {{.Size}}' | grep ssrf-protection

# A fake metadata service on the outside network: the proxy can reach it,
# but its address is private, so the proxy must refuse it.
docker run -d --name fake-metadata --network ssrf-protection_outside node:22-bookworm-slim \
  node -e "require('http').createServer((q, r) => { console.log(q.url); r.end('FAKE-SECRET'); }).listen(8169)" > /dev/null
metadata_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' fake-metadata)

render() { # JSON body -> status code; the body goes to $work/out
  docker compose exec -T renderer curl -s -o /dev/stdout -w '\n%{http_code}' -X POST http://localhost:3000/pdf \
    -H "Content-Type: application/json" -d "$1" > "$work/out"
  tail -n 1 "$work/out"
}

status=$(render '{"url": "https://example.com/"}')
echo "https://example.com/ through the proxy: $status"
[ "$status" = 200 ] || { cat "$work/out"; docker compose logs; fail "a public page must render"; }
head -c 5 "$work/out" | grep -q '%PDF-' || fail "no PDF"
# The command from the README and the article.
docker compose exec -T renderer curl -s -X POST http://localhost:3000/pdf -H "Content-Type: application/json" -d '{"url": "https://example.com/"}' > "$work/example.pdf"
[ "$(head -c 5 "$work/example.pdf")" = "%PDF-" ] || fail "the README Docker command must return a PDF"
echo "README Docker command: $(wc -c < "$work/example.pdf") bytes of PDF"

status=$(render '{"url": "http://fake-metadata:8169/latest/meta-data/"}')
echo "http://fake-metadata:8169/ through the proxy: $status $(head -n 1 "$work/out")"
[ "$status" = 403 ] || fail "the proxy must block a private address"
[ -z "$(docker logs fake-metadata)" ] || fail "a request reached the fake metadata service"

# Direct connections from the renderer, past the proxy, must fail.
docker compose exec -T renderer node -e "
  for (const [host, port] of [['1.1.1.1', 443], ['$metadata_ip', 8169]]) {
    const socket = require('net').connect(port, host);
    socket.setTimeout(3000);
    socket.on('connect', () => { console.log('connected to', host); process.exit(1); });
    socket.on('error', (error) => console.log('direct to', host + ':', error.code));
    socket.on('timeout', () => { console.log('direct to', host + ': timeout'); socket.destroy(); });
  }"

# Chrome without the proxy: the network stops it.
docker compose exec -T renderer node --input-type=module -e "
  import puppeteer from 'puppeteer';
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  try {
    await page.goto('https://example.com/', { timeout: 10000 });
    console.log('Chrome without the proxy reached example.com');
    process.exitCode = 1;
  } catch (error) {
    console.log('Chrome without the proxy:', error.message.split('\n')[0]);
  }
  await browser.close();"

docker compose logs egress-proxy | grep egressBlocked
echo "All checks passed."
