#!/bin/sh

# Ensure internal container network calls are never routed through external proxies
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export NO_PROXY="*"
export no_proxy="*"

# The upstream settings default to the compose layout in README.md: web is
# overleaf:3000 and this service is git-bridge on GIT_BRIDGE_PORT (8000). With
# other service names, set GIT_BRIDGE_API_BASE_URL and
# GIT_BRIDGE_POSTBACK_BASE_URL. A value set explicitly always wins.
export GIT_BRIDGE_API_BASE_URL="${GIT_BRIDGE_API_BASE_URL:-http://overleaf:3000/api/v0}"
_gb_api="${GIT_BRIDGE_API_BASE_URL%/}"
export GIT_BRIDGE_OAUTH2_SERVER="${GIT_BRIDGE_OAUTH2_SERVER:-${_gb_api%/api/v0}}"
export GIT_BRIDGE_POSTBACK_BASE_URL="${GIT_BRIDGE_POSTBACK_BASE_URL:-http://git-bridge:${GIT_BRIDGE_PORT:-8000}}"
export GIT_BRIDGE_ROOT_DIR="${GIT_BRIDGE_ROOT_DIR:-/data}"

mkdir -p "${GIT_BRIDGE_ROOT_DIR}/.wlgb/atts" 2>/dev/null || true
_gb_dir="${GIT_BRIDGE_ROOT_DIR}"
if [ "$(stat -c %U "$_gb_dir" 2>/dev/null)" != "node" ]; then
  chown -R node:node "$_gb_dir" 2>/dev/null || true
fi

/opt/envsubst < /envsubst_template.json > /conf/runtime.json

VERSION=$(date +%y%m%d%H%M%S)

if [ -z "$GIT_BRIDGE_JVM_ARGS" ]; then
  GIT_BRIDGE_JVM_ARGS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=50.0 -XX:+ExitOnOutOfMemoryError"
fi

if [ "$ENABLE_PROFILE_AGENT" = "true" ]; then
  GIT_BRIDGE_JVM_ARGS="-agentpath:/opt/cprof/profiler_java_agent.so=-cprof_service=git-bridge,-cprof_service_version=${VERSION},-cprof_enable_heap_sampling=true ${GIT_BRIDGE_JVM_ARGS}"
fi

exec java $GIT_BRIDGE_JVM_ARGS -jar /git-bridge.jar /conf/runtime.json
