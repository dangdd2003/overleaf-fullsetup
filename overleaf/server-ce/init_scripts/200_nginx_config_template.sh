#!/bin/sh

set -e

## Generate nginx config files from templates,
## with environment variables substituted

nginx_dir='/etc/nginx'
nginx_templates_dir="${nginx_dir}/templates"

if ! [ -d "${nginx_templates_dir}" ]; then
  echo "Nginx: no template directory found, skipping"
  exit 0
fi

nginx_template_file="${nginx_templates_dir}/nginx.conf.template"
nginx_config_file="${nginx_dir}/nginx.conf"

if [ -f "${nginx_template_file}" ]; then
  export NGINX_KEEPALIVE_TIMEOUT="${NGINX_KEEPALIVE_TIMEOUT:-65}"
  export NGINX_WORKER_CONNECTIONS="${NGINX_WORKER_CONNECTIONS:-768}"
  export NGINX_WORKER_PROCESSES="${NGINX_WORKER_PROCESSES:-4}"

  echo "Nginx: generating config file from template"

  # Note the single-quotes, they are important.
  # This is a pass-list of env-vars that envsubst
  # should operate on.
  # shellcheck disable=SC2016
  envsubst '
    ${NGINX_KEEPALIVE_TIMEOUT}
    ${NGINX_WORKER_CONNECTIONS}
    ${NGINX_WORKER_PROCESSES}
  ' \
    < "${nginx_template_file}" \
    > "${nginx_config_file}"
fi

git_bridge_template_file="${nginx_templates_dir}/git-bridge.conf.template"
vhost_extras_dir="${nginx_dir}/vhost-extras/overleaf"
git_bridge_config_file="${vhost_extras_dir}/git-bridge.conf"

if [ -f "${git_bridge_template_file}" ]; then
  mkdir -p "${vhost_extras_dir}"
  # Git Bridge is disabled by default: the proxy below uses a fixed
  # upstream host, which nginx resolves at config-load time. If no
  # git-bridge service exists on the network, nginx -t fails and the
  # container refuses to start. The web app defaults this feature off
  # as well (GitBridgeRouter.mjs requires GIT_BRIDGE_ENABLED=true).
  if [ "$(echo "${GIT_BRIDGE_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    export GIT_BRIDGE_HOST="${GIT_BRIDGE_HOST:-git-bridge}"
    export GIT_BRIDGE_PORT="${GIT_BRIDGE_PORT:-8000}"

    echo "Nginx: generating git-bridge proxy config for http://${GIT_BRIDGE_HOST}:${GIT_BRIDGE_PORT}"

    envsubst '
      ${GIT_BRIDGE_HOST}
      ${GIT_BRIDGE_PORT}
    ' \
      < "${git_bridge_template_file}" \
      > "${git_bridge_config_file}"
  else
    echo "Nginx: Git Bridge disabled, skipping git-bridge proxy config"
    rm -f "${git_bridge_config_file}"
  fi
fi

echo "Checking Nginx config"
nginx -t

if service nginx status >/dev/null 2>&1; then
  echo "Nginx: reloading config"
  service nginx reload
fi
