#!/bin/bash
set -e -o pipefail

# Google Drive sync encrypts its OAuth tokens with this secret. It is kept in
# the data volume so linked Drive accounts survive new containers, while the
# session secret is still regenerated for every container like upstream.

if [ "$GOOGLE_DRIVE_ENABLED" != "true" ]; then
  exit 0
fi

SECRET_NAME=GOOGLE_DRIVE_TOKEN_ENCRYPTION_SECRET
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
  echo "generating Google Drive token encryption secret"
  (
    umask 077
    mkdir -p "$SECRETS_DIR"
    echo "$(generate_secret)" > "$PERSISTENT_FILE"
  )
fi

cat "$PERSISTENT_FILE" > "$ENV_FILE"
