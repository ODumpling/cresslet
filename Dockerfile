FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY runtime runtime
COPY studio studio
COPY templates templates
ENV PORT=8787 CRESSLET_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/main.ts"]
