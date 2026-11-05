#!/usr/bin/env bash
# Build and push one image from the vendored ./overleaf monorepo on Travis CI.
# Usage: ci/travis-build.sh <base|full|slim|git-bridge>
#
# Required Travis repository-settings variables (keep "Display value in build log" OFF):
#   DOCKER_USERNAME  Docker Hub user / namespace
#   DOCKER_TOKEN     Docker Hub access token (Read & Write)
#   GHCR_USERNAME    GitHub user or org that owns the ghcr.io namespace
#   GHCR_TOKEN       classic GitHub PAT with only the write:packages scope
set -euo pipefail

target="${1:?usage: $0 <base|full|slim|git-bridge>}"

: "${DOCKER_USERNAME:?DOCKER_USERNAME is not set}"
: "${DOCKER_TOKEN:?DOCKER_TOKEN is not set}"
: "${GHCR_USERNAME:?GHCR_USERNAME is not set}"
: "${GHCR_TOKEN:?GHCR_TOKEN is not set}"

GHCR="${GHCR:-ghcr.io}"
# ghcr.io namespaces must be lowercase
GHCR_NS="$(printf '%s' "$GHCR_USERNAME" | tr '[:upper:]' '[:lower:]')"
# compute once so every tag in this job agrees, even across midnight
BUILD_DATE="$(TZ="${TZ:-Asia/Ho_Chi_Minh}" date +%Y-%m-%d)"
REVISION="${TRAVIS_COMMIT:-$(git rev-parse HEAD)}"
TEXLIVE_MIRROR="${TEXLIVE_MIRROR:-https://mirror.ctan.org/systems/texlive/tlnet}"
NODE_VERSION="${NODE_VERSION:-v24.20.0}"
BASE_REF="${DOCKER_USERNAME}/sharelatex-base:latest"

context=./overleaf
build_args=()
case "$target" in
  base)
    image=sharelatex-base
    file=./overleaf/server-ce/Dockerfile-base
    build_args+=(--build-arg "TEXLIVE_MIRROR=${TEXLIVE_MIRROR}")
    ;;
  full)
    image=sharelatex
    file=./overleaf/server-ce/Dockerfile
    build_args+=(
      --build-arg "OVERLEAF_BASE_TAG=${BASE_REF}"
      --build-arg "TEXLIVE_MIRROR=${TEXLIVE_MIRROR}"
      --build-arg "NODE_VERSION=${NODE_VERSION}"
    )
    ;;
  slim)
    image=sharelatex-slim
    file=./overleaf/server-ce/Dockerfile.slim
    build_args+=(
      --build-arg "OVERLEAF_BASE_TAG=${BASE_REF}"
      --build-arg "NODE_VERSION=${NODE_VERSION}"
    )
    ;;
  git-bridge)
    image=git-bridge
    context=./overleaf/services/git-bridge
    file=./overleaf/services/git-bridge/Dockerfile
    ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac

# Log in before building so base-image pulls are authenticated (Docker Hub rate limits)
printf '%s' "$DOCKER_TOKEN" | docker login -u "$DOCKER_USERNAME" --password-stdin
printf '%s' "$GHCR_TOKEN" | docker login "$GHCR" -u "$GHCR_USERNAME" --password-stdin
trap 'docker logout >/dev/null 2>&1 || true; docker logout "$GHCR" >/dev/null 2>&1 || true' EXIT

# The default "docker" driver cannot export registry caches; use a container builder
docker buildx create --name travis --driver docker-container --use >/dev/null
docker buildx inspect --bootstrap >/dev/null

hub="${DOCKER_USERNAME}/${image}"
ghcr="${GHCR}/${GHCR_NS}/${image}"
cache_ref="${hub}:buildcache"

# Keep-alive for Travis's 10-minute no-output limit, without buffering build logs
( while sleep 300; do echo "[keep-alive] still building ${image} ($(date +%H:%M:%S))"; done ) &
keepalive=$!
trap 'kill "$keepalive" 2>/dev/null || true; docker logout >/dev/null 2>&1 || true; docker logout "$GHCR" >/dev/null 2>&1 || true' EXIT

# No layer caching between Travis VMs, so keep a registry cache next to the image
docker buildx build \
  --file "$file" \
  "${build_args[@]}" \
  --label "org.opencontainers.image.revision=${REVISION}" \
  --label "org.opencontainers.image.created=${BUILD_DATE}" \
  --cache-from "type=registry,ref=${cache_ref}" \
  --cache-to "type=registry,ref=${cache_ref},mode=max" \
  --progress=plain \
  --tag "${hub}:latest" \
  --tag "${hub}:${BUILD_DATE}" \
  --tag "${ghcr}:latest" \
  --tag "${ghcr}:${BUILD_DATE}" \
  --push \
  "$context"
