#!/bin/bash
set -euo pipefail

# Template Gallery storage initialization script
# Fails closed if TEMPLATE_GALLERY_ENABLED is not true
[ "${TEMPLATE_GALLERY_ENABLED:-false}" = "true" ] || exit 0

# The store is a sub-folder of the main Overleaf data volume (one volume, one backup),
# so there is no mount check. The layout must match services/web template-gallery
# storage/Paths.mjs LAYOUT_SUBDIRS.
D="/var/lib/overleaf/data/template-gallery"

mkdir -p "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"
chown www-data:www-data "$D" "$D/blobs" "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"
chmod 0750 "$D" "$D/blobs" "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine" "$D/catalog"
find "$D" \( ! -user www-data -o ! -group www-data \) -exec chown www-data:www-data {} +
