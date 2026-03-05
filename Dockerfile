# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Run stage
FROM node:20-alpine

ENV NODE_ENV=production
ENV SUBFIN_DB_PATH=/data/subfin.db

# Non-root user and group (system-assigned IDs to avoid conflicts with base image)
RUN addgroup subfin && \
    adduser -G subfin -D subfin

WORKDIR /app

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App from builder
COPY --from=builder /app/dist ./dist

# Data directory: app writes subfin.json here
RUN mkdir -p /data && chown -R subfin:subfin /data

EXPOSE 4040

USER subfin

CMD ["node", "dist/index.js"]
