# Google Chrome on Xvfb, driven by Patchright, for Overleaf AI Assist web_fetch.
# Node matches Overleaf's own (NODE_VERSION in overleaf/server-ce/Dockerfile-base).
ARG NODE_VERSION=24.20.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production \
    HOME=/tmp/home

WORKDIR /app

# Xvfb gives headed Chrome a screen; tini reaps Chrome's child processes;
# tzdata lets TZ work without mounting the host's /etc/localtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates xvfb tini tzdata \
 && rm -rf /var/lib/apt/lists/*

# Patchright from the lockfile, then Google Chrome stable and its system
# libraries through that same Patchright. Its installer fetches curl for
# itself; curl and the package managers are removed afterwards, so nothing
# in the image is a ready-made download tool. google-chrome --version fails
# the build if removing curl took Chrome with it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && ./node_modules/.bin/patchright install --with-deps chrome \
 && apt-get purge -y curl \
 && google-chrome --version \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

# uid 1001 owns the profiles written by earlier images, so old volumes stay writable
RUN groupadd --gid 1001 browser \
 && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin browser \
 && mkdir -p /data/profile \
 && chown browser:browser /data/profile

COPY quality.mjs address.mjs proxy.mjs pacer.mjs slots.mjs engine.mjs fetcher.mjs app.mjs display.mjs server.mjs ./

USER browser
VOLUME ["/data/profile"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
