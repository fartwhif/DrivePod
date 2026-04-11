# Stage 1: Build Angular frontend
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build --configuration=production

# Stage 2: Runtime
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y \
    ffmpeg curl nginx \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# 1. Copy only package files first (for caching)
COPY backend/package*.json ./backend/

# 2. Install dependencies
RUN cd backend && npm ci

# 3. Now copy the FULL backend source (tsconfig + src + prisma etc.)
COPY backend/ ./backend/

# 4. Build TypeScript to JavaScript
RUN cd backend && npm run build

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist/frontend/browser /var/www/drivepod

# Copy nginx config
COPY drivepod-ngnix /etc/nginx/sites-available/drivepod

# Create directories and permissions
RUN mkdir -p /app/data /var/www/cache \
    && chown -R www-data:www-data /var/www/drivepod /var/www/cache /app/data

# Enable nginx site
RUN ln -s /etc/nginx/sites-available/drivepod /etc/nginx/sites-enabled/ \
    && rm -f /etc/nginx/sites-enabled/default

# Generate Prisma client
RUN cd backend && npx prisma generate

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]