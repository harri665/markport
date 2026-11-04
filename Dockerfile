# Markport - server deployment image.
#
# Stage 1 downloads Obsidian's Android APK from Obsidian's GitHub releases and
# extracts its renderer into vendor/obsidian-mobile/, exactly as
# scripts/update-obsidian-mobile.js does on a dev machine. The bundle is
# fetched at build time on the machine that builds the image; it is not part of
# this repository. The resulting image therefore contains Obsidian's
# proprietary code: build it for your own use, do not publish it to a public
# registry. See README.md, "Disclaimer".
#
# Stage 2 is the runtime: the Node server plus the browser-side files it serves.

ARG NODE_VERSION=22

# ── Stage 1: Obsidian bundle ────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS obsidian
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# 1.13+ will not boot (README.md, "Obsidian Version") - keep the pin.
ARG OBSIDIAN_VERSION=1.12.7
COPY scripts/update-obsidian-mobile.js scripts/patch-obsidian-mobile.js scripts/
# The updater also writes src/client-mobile/obsidian-version.js.
RUN mkdir -p src/client-mobile \
 && node scripts/update-obsidian-mobile.js --version "${OBSIDIAN_VERSION}"

# ── Stage 2: server deps ────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app/src/runtime-server/server
COPY src/runtime-server/server/package.json src/runtime-server/server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Same layout as the repo: config.js resolves everything from the repo root.
COPY --from=deps /app/src/runtime-server/server/node_modules src/runtime-server/server/node_modules
COPY src/runtime-server/server src/runtime-server/server
COPY src/client-mobile src/client-mobile
COPY src/config src/config
COPY src/plugins src/plugins
COPY --from=obsidian /build/vendor/obsidian-mobile vendor/obsidian-mobile
COPY --from=obsidian /build/src/client-mobile/obsidian-version.js src/client-mobile/obsidian-version.js

# /data holds everything that must survive a rebuild: one folder per vault
# under /data/vaults, plus the vault registry.
RUN mkdir -p /data/vaults && chown -R node:node /data
VOLUME /data

ENV HOST=0.0.0.0 \
    PORT=3000 \
    VAULTS_DIR=/data/vaults \
    DEFAULT_VAULT_NAME=Notes \
    VAULT_PATH=/data/vaults/Notes \
    VAULT_REGISTRY=/data/registry.json

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/vaults/list').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

WORKDIR /app/src/runtime-server/server
CMD ["node", "index.js"]
