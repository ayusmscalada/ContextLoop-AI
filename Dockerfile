# ContextLoop AI — single-container deployment (API + built web UI), persistent data on a volume.
FROM node:22-bookworm-slim
WORKDIR /app
ENV PORT=8787 CONTEXTLOOP_DATA_DIR=/data
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
VOLUME ["/data"]
EXPOSE 8787
# Seeds the demo org on first boot when the volume is empty.
CMD ["npx", "tsx", "server/src/index.ts"]
