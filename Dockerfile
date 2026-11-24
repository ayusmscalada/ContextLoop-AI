# ContextLoop AI — single-container deployment (API + built web UI + MCP entrypoint)
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 CONTEXTLOOP_DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY server/ ./server/
COPY sample-data/ ./sample-data/
COPY --from=web /app/web/dist ./web/dist
VOLUME ["/data"]
EXPOSE 8787
# Seeds the demo org on first boot when the volume is empty.
CMD ["npx", "tsx", "server/src/index.ts"]
