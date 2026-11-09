#!/usr/bin/env bash
# CI entry point.
# 1. Tests the two services outside Docker.
# 2. Builds four images and prints their sizes.
# 3. Breaks the images on purpose, prints each error, and shows the fix.
set -euo pipefail
cd "$(dirname "$0")"
here=$PWD
work=$(mktemp -d)
port=3100

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  docker ps -aq --filter name=case- | xargs -r docker rm -f > /dev/null 2>&1 || true
  sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0 || true
  rm -rf "$work"
}
trap cleanup EXIT

if ! command -v pdffonts > /dev/null; then
  sudo apt-get install -y -qq poppler-utils > /dev/null
fi

echo "== 1. Tests outside Docker"
(cd puppeteer && npm ci && npm test)
(cd playwright && npm ci && npx playwright install --with-deps --only-shell chromium && npm test)

echo "== 2. Build the images"
build() { # tag folder dockerfile [sed expression that removes one part]
  local start=$SECONDS
  if [ -n "${4:-}" ]; then
    sed "$4" "$2/$3" | docker build -q -t "$1" -f - "$2" > /dev/null
  else
    docker build -q -t "$1" -f "$2/$3" "$2" > /dev/null
  fi
  echo "built $1 in $((SECONDS - start)) s ${4:+(without: $4)}"
}
docker pull -q node:22-bookworm-slim > /dev/null
docker pull -q mcr.microsoft.com/playwright:v1.65.0-noble > /dev/null
docker pull -q ghcr.io/puppeteer/puppeteer:25.16.0 > /dev/null

build pptr-official puppeteer Dockerfile
build pptr-slim puppeteer Dockerfile.slim
build pw-official playwright Dockerfile
build pw-slim playwright Dockerfile.slim
# The same Dockerfiles with one part removed, to show the errors.
build pptr-official-noemoji puppeteer Dockerfile 's/ fonts-noto-color-emoji//'
build pptr-official-nocache puppeteer Dockerfile '/^ENV PUPPETEER_CACHE_DIR/d'
build pptr-slim-nofonts puppeteer Dockerfile.slim 's/ fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji//'
build pptr-slim-nodeps puppeteer Dockerfile.slim 's/ --install-deps//'
build pw-slim-nodeps playwright Dockerfile.slim 's/install --with-deps/install/'

docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' \
  | grep -E 'TAG|pptr-|pw-|node:22-bookworm-slim|playwright:v|puppeteer:25'
for image in pptr-official pptr-slim pw-official pw-slim; do
  echo "$image: Node.js $(docker run --rm --entrypoint node "$image" --version), user $(docker run --rm --entrypoint id "$image" -un)"
done

# Starts a container and waits until /health answers (return 0) or the
# container stops (return 1). Sets $name and $url.
start() { # image [docker run options...]
  local image=$1
  shift
  port=$((port + 1))
  name="case-$port"
  url="http://127.0.0.1:$port"
  docker run -d --name "$name" -p "$port:3000" "$@" "$image" > /dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "$url/health" > "$work/health.json" 2> /dev/null; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
      return 1
    fi
    sleep 1
  done
  return 1
}

expect_healthy() { # label image [docker run options...]
  local label=$1
  shift
  if ! start "$@"; then
    docker logs "$name" 2>&1 | tail -n 30
    fail "$label: the container did not start"
  fi
  echo "OK   $label: $(cat "$work/health.json")"
}

expect_error() { # label text image [docker run options...]
  local label=$1 text=$2
  shift 2
  if start "$@"; then
    fail "$label: expected an error, but the service started"
  fi
  docker logs "$name" > "$work/log.txt" 2>&1
  if ! grep -q -F -- "$text" "$work/log.txt"; then
    tail -n 30 "$work/log.txt"
    fail "$label: the log does not contain: $text"
  fi
  echo "OK   $label: $(grep -m 1 -F -- "$text" "$work/log.txt")"
  docker rm -f "$name" > /dev/null
}

# Saves the check page as PNG and PDF, prints the PNG as base64 (so that it
# can be copied from the CI log) and the fonts in the PDF.
save_check() { # label
  curl -fsS -o "$work/$1.png" "$url/check.png"
  curl -fsS -o "$work/$1.pdf" "$url/check.pdf"
  pdffonts "$work/$1.pdf" | awk 'NR > 2 {print $1}' | sed 's/^[A-Z]*+//' | sort -u | tr '\n' ' ' > "$work/$1.fonts"
  echo "     fonts in the PDF: $(cat "$work/$1.fonts")"
  echo "=====BEGIN $1.png"
  base64 -w 100 "$work/$1.png"
  echo "=====END $1.png"
}

probe() { # [docker run options...] image [command...]
  docker run --rm --cap-add=SYS_ADMIN -v "$here/probes:/app/probes:ro" "$@" 2>&1 || true
}

echo "== 3. The working images"
for image in pptr-official pptr-slim pw-official pw-slim; do
  expect_healthy "$image starts with SYS_ADMIN" "$image" --cap-add=SYS_ADMIN
  save_check "$image"
  docker rm -f "$name" > /dev/null
done

echo "== 4. Missing fonts"
for image in pptr-slim-nofonts pptr-official-noemoji; do
  expect_healthy "$image starts" "$image" --cap-add=SYS_ADMIN
  save_check "$image"
  docker rm -f "$name" > /dev/null
done

for image in pptr-official pptr-slim pw-official pw-slim; do
  echo "RECORD fonts for Arabic in $image: $(probe "$image" node probes/fonts.mjs | tr '\n' ' ')"
done

echo "== 5. Missing libraries"
expect_error "Puppeteer without --install-deps" \
  'error while loading shared libraries: libglib-2.0.so.0' pptr-slim-nodeps --cap-add=SYS_ADMIN
expect_error "Playwright without --with-deps" \
  'error while loading shared libraries: libglib-2.0.so.0' pw-slim-nodeps --cap-add=SYS_ADMIN

echo "== 6. The sandbox"
# A seccomp profile: Docker's default profile plus one rule that allows the
# system calls for new namespaces.
curl -fsSL https://raw.githubusercontent.com/moby/profiles/seccomp/v0.3.0/seccomp/default.json \
  | jq '.syscalls += [{"names": ["clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW"}]' \
  > "$work/chrome-seccomp.json"
curl -fsSL -o "$work/playwright-seccomp.json" \
  https://raw.githubusercontent.com/microsoft/playwright/v1.65.0/utils/docker/seccomp_profile.json

for image in pptr-official pptr-slim pw-official pw-slim; do
  expect_error "$image as root" 'Running as root without --no-sandbox is not supported' \
    "$image" --cap-add=SYS_ADMIN --user root
  expect_error "$image without SYS_ADMIN" 'No usable sandbox!' "$image"
  expect_healthy "$image with the seccomp profile" "$image" --security-opt "seccomp=$work/chrome-seccomp.json"
  docker rm -f "$name" > /dev/null
  expect_healthy "$image with the Playwright seccomp profile" "$image" --security-opt "seccomp=$work/playwright-seccomp.json"
  docker rm -f "$name" > /dev/null
  expect_healthy "$image without the sandbox" "$image" -e CHROMIUM_SANDBOX=false
  docker rm -f "$name" > /dev/null
done

expect_error "Puppeteer image as root, without PUPPETEER_CACHE_DIR" \
  'Could not find Chrome (ver. 156.0.8078.47)' pptr-official-nocache --cap-add=SYS_ADMIN --user root
for image in pptr-official pptr-slim pw-official pw-slim; do
  if start "$image" --cap-add=SYS_ADMIN --user 4242; then
    echo "RECORD $image as user 4242: healthy"
  else
    docker logs "$name" > "$work/log.txt" 2>&1
    echo "RECORD $image as user 4242: $(grep -v '^ *at \|^$' "$work/log.txt" | head -n 8 | cut -c 1-300 | tr '\n' ' ')"
  fi
  docker rm -f "$name" > /dev/null
done

echo "== 7. Hosts that restrict user namespaces (Ubuntu 23.10 and later)"
sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=1
for opts in "--cap-add=SYS_ADMIN" "--security-opt seccomp=$work/chrome-seccomp.json" \
  "--cap-add=SYS_ADMIN --security-opt apparmor=unconfined" "-e CHROMIUM_SANDBOX=false"; do
  for image in pptr-slim pw-slim; do
    # shellcheck disable=SC2086
    if start "$image" $opts; then
      echo "RECORD restrict=1, $image, $opts: healthy"
    else
      docker logs "$name" > "$work/log.txt" 2>&1
      echo "RECORD restrict=1, $image, $opts: $(grep -m 1 -E 'sandbox|Sandbox|FATAL|Error' "$work/log.txt" | cut -c 1-300)"
    fi
    docker rm -f "$name" > /dev/null
  done
done
sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_userns=0

echo "== 8. Zombie processes"
for image in pptr-slim pw-official; do
  echo "RECORD $image, node is process 1:"
  probe --entrypoint node "$image" probes/zombies.mjs
  echo "RECORD $image, tini is process 1:"
  probe "$image" node probes/zombies.mjs
  echo "RECORD $image, docker run --init:"
  probe --init --entrypoint node "$image" probes/zombies.mjs
done

echo "== 9. Crashes"
for image in pptr-slim pw-slim; do
  for what in browser page; do
    echo "RECORD $image, $what crash: $(probe "$image" node probes/crash.mjs "$what" | tr '\n' ' ')"
  done
done

echo "== 10. /dev/shm"
for image in pptr-slim pw-slim; do
  for opts in "" "--shm-size=1g" "--ipc=host"; do
    for mode in default use-dev-shm; do
      # shellcheck disable=SC2086
      echo "RECORD $image [$opts] $mode: $(probe $opts "$image" node probes/shm.mjs "$mode" | tr '\n' ' ' | cut -c 1-400)"
    done
  done
  for mem in 1g 512m; do
    echo "RECORD $image memory $mem: $(probe --memory=$mem --memory-swap=$mem "$image" node probes/shm.mjs default | tr '\n' ' ' | cut -c 1-400)"
  done
done

echo "== 11. Health check, restart after a crash, and docker stop"
for image in pptr-slim pw-slim; do
  expect_healthy "$image with a restart policy" "$image" --cap-add=SYS_ADMIN --restart=on-failure --health-interval=2s
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$name")" = healthy ] && break
    sleep 1
  done
  echo "RECORD $image health status: $(docker inspect -f '{{.State.Health.Status}}' "$name")"
  docker top "$name" -eo pid,ppid,comm > "$work/top.txt"
  cat "$work/top.txt"
  # Kill the browser: all processes whose name starts with "chrome".
  awk '$3 ~ /^chrome/ {print $1}' "$work/top.txt" | xargs -r sudo kill -9
  sleep 3
  docker logs "$name" > "$work/log.txt" 2>&1
  echo "RECORD $image after the kill: restarts $(docker inspect -f '{{.RestartCount}}' "$name"), log: $(grep -m 1 'closed unexpectedly' "$work/log.txt" || true)"
  for _ in $(seq 1 30); do
    curl -fsS "$url/health" > "$work/health.json" 2> /dev/null && break
    sleep 1
  done
  echo "RECORD $image health after the restart: $(cat "$work/health.json")"
  start_time=$SECONDS
  docker stop "$name" > /dev/null
  echo "RECORD $image docker stop: $((SECONDS - start_time)) s, exit code $(docker inspect -f '{{.State.ExitCode}}' "$name")"
  docker rm -f "$name" > /dev/null
done

echo "All checks passed."
