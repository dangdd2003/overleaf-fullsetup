#!/bin/bash
set -e -o pipefail

# GitHub sync encrypts its OAuth tokens with this secret. It is kept in the data
# volume so linked GitHub accounts survive new containers, while the session
# secret is still regenerated for every container like upstream.

if [ "$GITHUB_SYNC_ENABLED" != "true" ]; then
  exit 0
fi

SECRET_NAME=GITHUB_TOKEN_ENCRYPTION_SECRET
ENV_FILE=/etc/container_environment/$SECRET_NAME
SECRETS_DIR=/var/lib/overleaf/secret
PERSISTENT_FILE=$SECRETS_DIR/$SECRET_NAME

# a secret set explicitly on the container takes precedence
if [ -s "$ENV_FILE" ]; then
  exit 0
fi

generate_secret () {
  dd if=/dev/urandom bs=1 count=32 2>/dev/null | base64 -w 0 | rev | cut -b 2- | rev | tr -d '\n+/'
}

if [ ! -s "$PERSISTENT_FILE" ]; then
  (
    umask 077
    mkdir -p "$SECRETS_DIR"
    if [ -n "$GITHUB_TOKEN_SECRET" ]; then
      # one-time migration: installs that set the removed GITHUB_TOKEN_SECRET
      # keep decrypting their stored tokens with that value
      echo "migrating GitHub token encryption secret from GITHUB_TOKEN_SECRET"
      printf '%s' "$GITHUB_TOKEN_SECRET" > "$PERSISTENT_FILE"
    else
      echo "generating GitHub token encryption secret"
      echo "$(generate_secret)" > "$PERSISTENT_FILE"
    fi
  )
fi

cat "$PERSISTENT_FILE" > "$ENV_FILE"
