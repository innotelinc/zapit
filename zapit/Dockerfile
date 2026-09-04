FROM node:22.18.0-alpine3.22

# production only
ENV NODE_ENV=production

# tini: reaps zombies and forwards signals so `docker stop` shuts the server down cleanly
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

# run as an unprivileged user (uid/gid 1000 = host "node" user in the base image);
# the compose file maps ./data to this, so files on the host stay owned by you
WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node infisical.js ./
COPY --chown=node:node public ./public

# persisted state lives here when a volume is mounted (see docker-compose.yml)
ENV ZAPIT_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

EXPOSE 5150
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-5150}/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
