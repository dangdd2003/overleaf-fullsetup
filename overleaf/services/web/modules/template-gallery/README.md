# Template Gallery Module (`template-gallery`)

Automated template catalogue crawler, detail/PDF hydrator, and 4-tier source package acquisition engine for Overleaf Community Edition.

## Activation

Set the single environment variable in `variable.env`:

```env
TEMPLATE_GALLERY_ENABLED=true
```

Mount the dedicated Docker volume using `docker-compose.template-gallery.yaml`:

```bash
docker compose -f docker-compose.yaml -f docker-compose.template-gallery.yaml up -d
```

See `docs/superpowers/specs/2026-10-28-template-gallery-design.md` for full architectural details.
