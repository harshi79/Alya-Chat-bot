# Alya — Telegram AI companion (NVIDIA NIM). No native dependencies.
#
#   docker build -t alya .
#   docker run --rm -e BOT_TOKEN=123:ABC -e NVIDIA_API_KEY=nvapi-... \
#              -p 8080:8080 -v alya-data:/app/data alya

# ---- build: compile TypeScript
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps + compiled output only
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/app/data/alya.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form so SIGTERM reaches Node (graceful shutdown)
CMD ["node", "dist/index.js"]
