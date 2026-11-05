#!/bin/bash
set -euo pipefail

# Template Gallery storage initialization script
# Fails closed if TEMPLATE_GALLERY_ENABLED is not true
[ "${TEMPLATE_GALLERY_ENABLED:-false}" = "true" ] || exit 0

# The store is its own Docker named volume, separate from the main /var/lib/overleaf volume,
# so its large mirror stays out of the main data folder. The layout must match
# services/web template-gallery storage/Paths.mjs LAYOUT_SUBDIRS.
D="/var/lib/template-gallery"

mkdir -p "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"

# Non-fatal: a directory on the container root filesystem shares the root device ID.
if [ "$(stat -c %d "$D")" = "$(stat -c %d /)" ]; then
  echo "template-gallery: $D is not a mounted volume; mirrored data will be lost when the container is recreated" >&2
fi

chown www-data:www-data "$D" "$D/blobs" "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"
chmod 0750 "$D" "$D/blobs" "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"
find "$D" \( ! -user www-data -o ! -group www-data \) -exec chown www-data:www-data {} +
