# Qalibre: Telegram bot, Mini App and batch engine in one container.
# Build:  docker build -t qalibre .
# Run:    docker run -d --name qalibre --restart unless-stopped -p 8787:8787 --env-file qalibre.env -v qalibre-data:/data qalibre
# Secrets come only from the environment (qalibre.env on the server), never from the image.

# 1. Build the Mini App.
FROM node:24-slim AS app
WORKDIR /src/miniapp
COPY miniapp/package.json miniapp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY miniapp/ ./
RUN npm run build

# 2. Runtime: backend + solver (TypeScript run directly with tsx).
FROM node:24-slim
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/qalibre.sqlite
WORKDIR /srv
COPY solver/package.json solver/package-lock.json solver/
RUN cd solver && npm ci --omit=dev --no-audit --no-fund
COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --include=dev --no-audit --no-fund  # tsx runs the server
COPY solver/src solver/src
COPY solver/tsconfig.json solver/
COPY backend/src backend/src
COPY backend/assets backend/assets
COPY backend/tsconfig.json backend/
COPY contracts/deployments contracts/deployments
COPY --from=app /src/miniapp/dist miniapp/dist
# Runs as an unprivileged user; the database lives on the /data volume and survives restarts and upgrades.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /srv/backend
CMD ["node", "--import", "tsx", "src/index.ts"]
