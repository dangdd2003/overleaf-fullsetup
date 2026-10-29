#!/bin/bash
set -euo pipefail

# Template Gallery storage initialization script
# Fails closed if TEMPLATE_GALLERY_ENABLED is not true
[ "${TEMPLATE_GALLERY_ENABLED:-false}" = "true" ] || exit 0

D="/var/lib/overleaf/data/template-gallery"

# Check /proc/self/mountinfo to ensure $D is mounted
# Format: 5th field (space-delimited) is mount point
is_mounted() {
  local target="$1"
  if [ -r /proc/self/mountinfo ]; then
    while read -r _ _ _ _ mp _; do
      # Decode octal escapes if any (\040 etc.), but $target is straightforward ascii
      if [ "$mp" = "$target" ]; then
        return 0
      fi
    done < /proc/self/mountinfo
  fi
  return 1
}

if is_mounted "$D"; then
  chown www-data:www-data "$D"
  chmod 0750 "$D"
  mkdir -p "$D/blobs/sha256" "$D/tmp" "$D/scratch" "$D/quarantine"
  chown -R www-data:www-data "$D"
  chmod -R 0750 "$D"
fi
