# Stage 1: Build Angular frontend
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build --configuration=production

# Stage 2: Runtime image
FROM node:20-bookworm-slim AS runtime
# Install system dependencies + nginx
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp (static binary, exactly like your README)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Backend
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

# Copy built frontend to the exact path your nginx config expects
COPY --from=frontend-builder /app/frontend/dist/drivepod/browser /var/www/drivepod

# Copy backend source + your existing nginx config
COPY backend/ ./backend/
COPY drivepod-ngnix /etc/nginx/sites-available/drivepod

# Create required directories (matching your current paths)
RUN mkdir -p /app/data /var/www/cache \
    && chown -R www-data:www-data /var/www/drivepod /var/www/cache /app/data

# Enable your nginx site
RUN ln -s /etc/nginx/sites-available/drivepod /etc/nginx/sites-enabled/ \
    && rm -f /etc/nginx/sites-enabled/default

# Prisma setup
RUN cd backend && npx prisma generate

# Expose only the web port
EXPOSE 80

# Simple entrypoint: start backend in background + nginx in foreground
COPY <<EOF /app/entrypoint.sh
#!/bin/bash
cd /app/backend
npx prisma db push --accept-data-loss  # safe on first run; SQLite is fast
node --loader ts-node/esm src/server.ts &   # or node dist/server.js if you prefer building TS
nginx -g 'daemon off;'
EOF

RUN chmod +x /app/entrypoint.sh

CMD ["/app/entrypoint.sh"]