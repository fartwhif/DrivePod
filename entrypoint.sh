#!/bin/bash
set -e

if [ -f /app/.env ]; then
  set -a
  source /app/.env
  set +a
fi

echo "🚀 Starting DrivePod..."

cd /app/backend

echo "→ Running Prisma DB push..."
npx prisma db push --accept-data-loss

echo "→ Starting Node backend (production build)..."
npm start &

echo "→ Starting Nginx..."
nginx -g 'daemon off;'