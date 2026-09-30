FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY public ./public
COPY mcp/package.json mcp/server.json ./mcp/
RUN npm run build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
ENV NODE_ENV=production PORT=4021
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4021/api/health', {signal: AbortSignal.timeout(3000)}).then(async r => process.exit(r.ok && (await r.json()).ok === true ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/index.js"]
