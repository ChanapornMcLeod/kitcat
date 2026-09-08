#!/usr/bin/env bash
# Starts the bot server + cloudflared tunnel and auto-registers the
# webhook endpoint with the LINE platform. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env; set +a
CF="$HOME/.local/bin/cloudflared"
LOG=$(mktemp)

cleanup() { kill $SERVER $TUNNEL 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT INT TERM

node server.js & SERVER=$!
"$CF" tunnel --url "http://localhost:${PORT:-3000}" > "$LOG" 2>&1 & TUNNEL=$!

echo "Waiting for tunnel URL..."
URL=""
for _ in $(seq 1 30); do
  URL=$(grep -Eo "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1) && [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "❌ tunnel did not come up"; exit 1; }

echo "✅ Tunnel: $URL"
curl -sf -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$URL/webhook\"}" \
  && echo "✅ Webhook registered: $URL/webhook"

echo "🤖 Bot live. Press Ctrl-C to stop."
wait
