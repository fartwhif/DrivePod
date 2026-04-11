#!/bin/bash
set -e

echo "🚀 Starting DrivePod..."

cd /app/backend

echo "→ Running Prisma DB push..."
npx prisma db push --accept-data-loss

echo "→ Starting Node backend (production build)..."
npm start &

echo "→ Starting Nginx..."
nginx -g 'daemon off;'