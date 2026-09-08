#!/usr/bin/env bash
# KitCat LINE bot launcher.
# Starts the bot server + a free Cloudflare quick tunnel, and auto-registers
# the (possibly new) tunnel URL as the LINE webhook endpoint.
# If the tunnel dies, it restarts and re-registers automatically.
# Ctrl-C stops everything. Safe to run under launchd (see deploy/launchd/).
set -uo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
set -a; . ./.env; set +a

CF="$HOME/.local/bin/cloudflared"
LOG=$(mktemp)
SERVER=""
TUNNEL=""
URL=""

cleanup() {
  echo "Shutting down..."
  [ -n "$TUNNEL" ] && kill "$TUNNEL" 2>/dev/null
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
  wait 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

start_server() {
  node server.js & SERVER=$!
}

register_webhook() {
  local attempt
  for attempt in 1 2 3 4 5; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 \
      -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
      -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"endpoint\":\"$URL/webhook\"}")
    if [ "$code" = "200" ]; then
      echo "✅ Webhook registered: $URL/webhook"
      return 0
    fi
    echo "⚠️  Webhook registration failed (HTTP $code), retry $attempt/5 in $((attempt * 5))s..."
    sleep $((attempt * 5))
  done
  echo "❌ Webhook registration failed after 5 attempts."
  return 1
}

start_tunnel_and_register() {
  : > "$LOG"
  "$CF" tunnel --url "http://localhost:${PORT:-3000}" > "$LOG" 2>&1 & TUNNEL=$!
  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -Eo "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1) && [ -n "$URL" ] && break
    sleep 1
  done
  [ -n "$URL" ] || return 1
  echo "✅ Tunnel up: $URL"
  register_webhook || true
  return 0
}

start_server
while true; do
  if start_tunnel_and_register; then
    echo "🤖 Bot live. Waiting on tunnel..."
    wait "$TUNNEL"
  else
    echo "❌ Tunnel failed to start."
  fi
  kill "$TUNNEL" 2>/dev/null; wait "$TUNNEL" 2>/dev/null
  echo "🔁 Restarting tunnel in 5s..."
  sleep 5
done
