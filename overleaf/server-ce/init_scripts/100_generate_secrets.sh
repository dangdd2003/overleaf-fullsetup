#!/bin/bash
set -e -o pipefail

# generate secrets and defines them as environment variables
# https://github.com/phusion/baseimage-docker#centrally-defining-your-own-environment-variables

SECRETS_DIR=/var/lib/overleaf/secret
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

WEB_API_PASSWORD_FILE=/etc/container_environment/WEB_API_PASSWORD
STAGING_PASSWORD_FILE=/etc/container_environment/STAGING_PASSWORD # HTTP auth for history-v1
V1_HISTORY_PASSWORD_FILE=/etc/container_environment/V1_HISTORY_PASSWORD
CRYPTO_RANDOM_FILE=/etc/container_environment/CRYPTO_RANDOM
OT_JWT_AUTH_KEY_FILE=/etc/container_environment/OT_JWT_AUTH_KEY

generate_secret () {
  dd if=/dev/urandom bs=1 count=32 2>/dev/null | base64 -w 0 | rev | cut -b 2- | rev | tr -d '\n+/'
}

load_or_generate_secret () {
  local name="$1"
  local env_file="/etc/container_environment/$name"
  local persistent_file="$SECRETS_DIR/$name"

  if [ -s "$env_file" ]; then
    # If already set by container environment, record it to persistent storage
    cat "$env_file" > "$persistent_file"
    chmod 600 "$persistent_file"
    return
  fi

  if [ -s "$persistent_file" ]; then
    # Restore from persistent volume
    cat "$persistent_file" > "$env_file"
    return
  fi

  local secret
  secret=$(generate_secret)
  echo "${secret}" > "$persistent_file"
  chmod 600 "$persistent_file"
  echo "${secret}" > "$env_file"
}

load_or_generate_secret WEB_API_PASSWORD
load_or_generate_secret STAGING_PASSWORD
if [ -s "$SECRETS_DIR/STAGING_PASSWORD" ]; then
  cat "$SECRETS_DIR/STAGING_PASSWORD" > "$V1_HISTORY_PASSWORD_FILE"
fi
load_or_generate_secret CRYPTO_RANDOM
load_or_generate_secret OT_JWT_AUTH_KEY
