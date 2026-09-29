# Google Chrome on Xvfb, driven by Patchright, for Overleaf AI Assist web_fetch.
# Node matches Overleaf's own (NODE_VERSION in overleaf/server-ce/Dockerfile-base).
ARG NODE_VERSION=24.20.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production \
    HOME=/tmp/home

WORKDIR /app

# Xvfb gives headed Chrome a screen; tini reaps Chrome's child processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xvfb tini \
 && rm -rf /var/lib/apt/lists/*

# Patchright from the lockfile, then Google Chrome stable and its system
# libraries through that same Patchright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && ./node_modules/.bin/patchright install --with-deps chrome \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

# uid 1001 owns the profiles written by earlier images, so old volumes stay writable
RUN groupadd --gid 1001 browser \
 && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin browser \
 && mkdir -p /data/profile \
 && chown browser:browser /data/profile

COPY quality.mjs proxy.mjs pacer.mjs slots.mjs engine.mjs app.mjs display.mjs server.mjs ./

USER browser
VOLUME ["/data/profile"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
