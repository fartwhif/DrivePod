#!/bin/bash
set -e

if [ -f /app/.env ]; then
  # Normalize .env: remove spaces around '=' so 'source' works
  sed -i 's/ *=[ ]*/=/g' /app/.env
  set -a
  source /app/.env
  set +a
fi

# ── WireGuard tunnel ───────────────────────────────────────────────
if [ -n "$WG_PRIVATE_KEY" ] && [ -n "$WG_PEER_PUBLIC_KEY" ] && [ -n "$WG_PEER_ENDPOINT" ]; then
  echo "🔒 Bringing up WireGuard tunnel..."

  # Fill template placeholders from env vars
  sed \
    -e "s|__WG_PRIVATE_KEY__|${WG_PRIVATE_KEY}|g" \
    -e "s|__WG_ADDRESS__|${WG_ADDRESS:-192.168.0.228/32}|g" \
    -e "s|__WG_PEER_PUBLIC_KEY__|${WG_PEER_PUBLIC_KEY}|g" \
    -e "s|__WG_PEER_ALLOWEDIPS__|${WG_PEER_ALLOWEDIPS:-192.168.0.0/20}|g" \
    -e "s|__WG_PEER_ENDPOINT__|${WG_PEER_ENDPOINT}|g" \
    -e "s|__WG_PEER_PERSISTENT_KEEPALIVE__|${WG_PEER_PERSISTENT_KEEPALIVE:-25}|g" \
    /etc/wireguard/wg0.conf.template > /etc/wireguard/wg0.conf

  wg-quick up wg0
  # Keep the docker bridge subnet on eth0: full-tunnel WireGuard (table
  # 51820) would otherwise route replies to the bridge gateway
  # (docker-proxy's local end for host-mapped ports) via wg0 and drop them.
  BRIDGE_NET=$(ip -4 route show table main | awk '/scope link/ {print $1; exit}')
  [ -n "$BRIDGE_NET" ] && ip route replace ${BRIDGE_NET} dev eth0 table 51820 2>/dev/null || true

  echo "✅ WireGuard tunnel established"
  wg show
else
  echo "⚠️  WireGuard env vars not set — skipping tunnel"
fi

# ── DrivePod services ──────────────────────────────────────────────
echo "🚀 Starting DrivePod..."

cd /app/backend

echo "→ Running Prisma DB push..."
npx prisma db push --accept-data-loss

echo "→ Starting Node backend (production build)..."
npm start &

echo "→ Starting Nginx..."
nginx -g 'daemon off;'
