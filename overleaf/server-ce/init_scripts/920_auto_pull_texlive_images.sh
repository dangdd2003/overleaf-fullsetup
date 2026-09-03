#!/bin/sh
set -e

# Default disabled per AGENTS.md
if [ "$AUTO_PULL_TEX_LIVE_IMAGES" != "true" ]; then
  exit 0
fi

if [ "$SANDBOXED_COMPILES" != "true" ]; then
  exit 0
fi

if [ -z "$ALL_TEX_LIVE_DOCKER_IMAGES" ] && [ -z "$TEX_LIVE_DOCKER_IMAGE" ]; then
  exit 0
fi

echo "Starting background TeX Live image auto-pull..."
mkdir -p /var/log/overleaf

# Launch detached in background so my_init proceeds immediately to boot Nginx, Web, and CLSI
nohup node /overleaf/services/clsi/bin/auto-pull-texlive.mjs >> /var/log/overleaf/auto-pull-texlive.log 2>&1 &
