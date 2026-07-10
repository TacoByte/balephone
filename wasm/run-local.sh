#!/usr/bin/env bash
set -euo pipefail

WASM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$WASM_DIR/build"
RELAY_DIR="$WASM_DIR/relay"
SCENARIO="${1:-marathon2}"
WEB_HOST="127.0.0.1"
WEB_PORT="${WEB_PORT:-8000}"
RELAY_PORT="${RELAY_PORT:-8787}"
ORIGIN="http://$WEB_HOST:$WEB_PORT"
GAME_URL="$ORIGIN/?scenario=$SCENARIO&relay=ws://$WEB_HOST:$RELAY_PORT&relay_http=http://$WEB_HOST:$RELAY_PORT"
relay_pid=""

case "$SCENARIO" in
  marathon|marathon2|infinity) ;;
  *)
    echo "usage: $0 [marathon|marathon2|infinity]" >&2
    exit 2
    ;;
esac

for command in node npm python3 curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: required command not found: $command" >&2
    exit 1
  fi
done

if [[ ! -f "$BUILD_DIR/index.html" ]]; then
  echo "error: wasm/build/index.html is missing; build the web target first:" >&2
  echo "  emcmake cmake -B wasm/build -S wasm" >&2
  echo "  cmake --build wasm/build -j8" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$relay_pid" ]] && kill -0 "$relay_pid" >/dev/null 2>&1; then
    kill "$relay_pid" >/dev/null 2>&1 || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Installing relay dependencies..."
(cd "$RELAY_DIR" && npm ci --silent)

echo "Starting relay on $WEB_HOST:$RELAY_PORT..."
(
  cd "$RELAY_DIR"
  PORT="$RELAY_PORT" ALLOWED_ORIGINS="$ORIGIN" npm start
) &
relay_pid=$!

relay_ready=false
for _ in {1..50}; do
  if ! kill -0 "$relay_pid" >/dev/null 2>&1; then
    wait "$relay_pid" || true
    echo "error: relay failed to start" >&2
    exit 1
  fi
  if curl -fsS "http://$WEB_HOST:$RELAY_PORT/healthz" >/dev/null 2>&1; then
    relay_ready=true
    break
  fi
  sleep 0.1
done

if [[ "$relay_ready" != true ]]; then
  echo "error: relay did not become healthy" >&2
  exit 1
fi

echo
echo "Balep is available at:"
echo "  $GAME_URL"
echo
echo "Press Ctrl+C to stop both servers."
echo

cd "$BUILD_DIR"
python3 -m http.server "$WEB_PORT" --bind "$WEB_HOST"
