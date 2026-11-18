# ── Bloop — production container ─────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app

# Bloop has ZERO runtime npm dependencies — nothing to install.
COPY package.json bloop.js ./
COPY backend ./backend
COPY frontend ./frontend
COPY cli ./cli
COPY config ./config
COPY migrations ./migrations
COPY plugins ./plugins

RUN mkdir -p storage/system backups logs && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    BLOOP_HOST=0.0.0.0 \
    BLOOP_PORT=8090 \
    BLOOP_DATA_DIR=/app/storage \
    BLOOP_BACKUP_DIR=/app/backups

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8090/health >/dev/null 2>&1 || exit 1

CMD ["node", "bloop.js", "start"]
