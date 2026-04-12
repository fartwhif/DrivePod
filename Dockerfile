# Stage 1: Build Angular frontend
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build --configuration=production

# Stage 2: Runtime image
FROM node:20-bookworm-slim AS runtime

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    nginx \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Backend - copy package files first (better caching)
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

# Copy full backend source (including tsconfig, src, prisma, etc.)
COPY backend/ ./backend/

# Generate fresh Prisma client BEFORE building TypeScript
RUN cd backend && npx prisma generate

# Build TypeScript → JavaScript
RUN cd backend && npm run build

# Copy built Angular app (correct path for recent Angular versions)
COPY --from=frontend-builder /app/frontend/dist/frontend/browser /var/www/drivepod

# Copy nginx config
COPY drivepod-ngnix /etc/nginx/sites-available/drivepod

# Create required directories and set permissions
RUN mkdir -p /app/data /var/www/cache \
    && chown -R www-data:www-data /var/www/drivepod /var/www/cache /app/data

# Enable nginx site
RUN ln -s /etc/nginx/sites-available/drivepod /etc/nginx/sites-enabled/ \
    && rm -f /etc/nginx/sites-enabled/default

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 80

# Start with our custom entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]