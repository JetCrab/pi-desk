FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi-desk
COPY host/ ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=info \
    && rm host.tgz sdk.tgz \
    && npm cache clean --force
WORKDIR /opt/pi-runtime
COPY pi/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=info \
    && npm cache clean --force
RUN npm install --global --ignore-scripts --no-audit --no-fund pnpm@10.15.0 \
    && npm cache clean --force
COPY prune-image.mjs /tmp/prune-image.mjs
RUN rm -rf /opt/pi-desk/node_modules/node-pty/prebuilds/darwin-* \
           /opt/pi-desk/node_modules/node-pty/prebuilds/win32-* \
           /opt/pi-desk/node_modules/@next/swc-linux-*-musl \
           /opt/pi-desk/node_modules/@img/*linuxmusl-* \
    && node /tmp/prune-image.mjs

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client ripgrep fd-find \
      procps python3 tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && mkdir -p /data/home /workspace \
    && chown node:node /data/home /workspace
COPY --from=dependencies /opt/pi-desk /opt/pi-desk
COPY --from=dependencies /opt/pi-runtime /opt/pi-runtime
COPY --from=dependencies /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s /opt/pi-desk/node_modules/@jetcrab/pi-desk/bin/pi-desk.js /usr/local/bin/pi-desk \
    && ln -s /opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi \
    && ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && ln -s /usr/local/lib/node_modules/pnpm/bin/pnpx.cjs /usr/local/bin/pnpx \
    && mkdir -p /opt/pi-desk/node_modules/@jetcrab/pi-desk/temp/build/pi-desk/release/.next/cache \
    && chown node:node /opt/pi-desk/node_modules/@jetcrab/pi-desk/temp \
         /opt/pi-desk/node_modules/@jetcrab/pi-desk/temp/build/pi-desk/release/.next/cache
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/data/home \
    SHELL=/bin/bash \
    TZ=Asia/Shanghai \
    PI_CODING_AGENT_DIR=/data/home/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/data/home/.pi/agent/sessions \
    PI_DESK_PI_PACKAGE_DIR=/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent \
    PI_DESK_HOSTNAME=0.0.0.0 \
    PI_DESK_NO_OPEN=1 \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    PORT=6233
USER node
WORKDIR /workspace
EXPOSE 6233
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:6233/api/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.code===0&&b.data?.status==='ready'?0:1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pi-desk", "--no-open", "--hostname", "0.0.0.0"]
