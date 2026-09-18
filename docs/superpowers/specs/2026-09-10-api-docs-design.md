# API Docs Page — Design

## Purpose

This Overleaf CE-based deployment has grown a small number of genuinely
external, token-authenticated API endpoints (Git Bridge, Personal Access
Tokens) with no documentation anywhere in the product. Users and integrators
have no way to discover what's callable, what the request/response shapes
are, or how to authenticate, short of reading server source. This feature
adds a themed, in-app API reference page, reachable from the same Help menu
as the existing official Overleaf documentation link.

## Scope (v1)

**In scope:**
- Git Bridge REST API (`services/web/app/src/Features/GitBridge/GitBridgeRouter.mjs`):
  - `GET /api/v0/docs/:projectId`
  - `GET /api/v0/docs/:projectId/saved_vers`
  - `GET /api/v0/docs/:projectId/snapshots/:versionId`
  - `GET /api/v0/docs/:projectId/file/:fileId`
  - `POST /api/v0/docs/:projectId/snapshots`
  - `GET /oauth/token/info`
- Personal Access Token API (`services/web/app/src/Features/PersonalAccessToken/PersonalAccessTokenRouter.mjs`):
  - `POST /user/personal-access-tokens`
  - `GET /user/personal-access-tokens`
  - `DELETE /user/personal-access-tokens/:tokenId`
- Static reference documentation only: descriptions, parameters, request/response
  schemas, auth requirements, and copy-pasteable curl examples per endpoint.

**Implementation note:** the spec is authored as `openapi.json` (not
`.yaml`) — this codebase has no YAML parser dependency anywhere in `web`,
and OpenAPI 3.0 supports JSON natively, so JSON avoids adding a new
dependency for zero loss of capability. The file is loaded via Node's
native `import ... with { type: 'json' }`, an already-established pattern
in this codebase (see `services/web/app/src/infrastructure/Translations.mjs`).

**Explicitly out of scope for v1** (candidates for a later iteration):
- MCP (Model Context Protocol) endpoint docs — different protocol shape
  (JSON-RPC/OAuth), documented separately if ever.
- Internal service-to-service APIs (notifications, github-sync, docstore,
  clsi, chat, etc.) — not reachable from outside the docker network, not
  "public" in the sense this feature targets.
- Interactive "try it out" request execution — static docs only for v1;
  live execution from the browser is a meaningfully larger security/build
  surface (CSRF, rate limiting, accidental mutations against real projects)
  and is deferred.

## Routes

| Path | Purpose |
|---|---|
| `GET /api-docs` | The webui — the themed, human-readable docs page. Top-level route, sibling to the existing `/learn` docs page, not nested under `/api/` since that namespace is reserved for JSON data endpoints. |
| `GET /api/v0/openapi.json` | The raw OpenAPI 3.0 spec as JSON, versioned alongside the API it describes. Consumed by the webui to render itself, and by external tools (Postman, Insomnia, codegen) directly. |

Both routes require an authenticated session, consistent with every other
page in this self-hosted deployment (there is no public/anonymous surface
elsewhere to be consistent with instead).

## Module structure

New self-contained module at `services/web/modules/api-docs/`, following the
existing pattern used by `github-sync`:

```
services/web/modules/api-docs/
  index.mjs                        # WebModule definition (router.apply, gated by isEnabled())
  app/
    src/
      ModuleSettings.mjs            # sets Settings.enableApiDocs from API_DOCS_ENABLED
      ApiDocsRouter.mjs             # mounts GET /api-docs and GET /api/v0/openapi.json
      ApiDocsController.mjs         # renders the page view; serves the spec JSON
      openapi.json                 # hand-written OpenAPI 3.0 spec (source of truth)
    views/
      api-docs.pug                 # extends app/views/layout-react, entrypoint = modules/api-docs/pages/api-docs
  frontend/
    js/
      pages/
        api-docs.tsx               # webpack entry point (auto-discovered), calls renderInReactLayout
      features/
        api-docs/
          components/
            root.tsx                # fetches /api/v0/openapi.json, renders the themed grouped view
  test/
    unit/
      ApiDocsRouter.test.mjs        # flag on/off mounting behavior
      OpenApiSpecSync.test.mjs      # spec matches live route table (see Testing)
```

This mirrors the existing `admin-user-management` module exactly (a
web-hosted module rendering its own full page via `layout-react` +
`res.render(Path.resolve(import.meta.dirname, '../views/...'))`), rather
than a widget-only module like `github-sync`.

Feature flag: **`API_DOCS_ENABLED`** (env var, default `false`/unset), read
in `ApiDocsRouter.mjs` using the same lazy-init idiom as `GitBridgeRouter.mjs`:

```js
if (Settings.enableApiDocs === undefined) {
  Settings.enableApiDocs = process.env.API_DOCS_ENABLED === 'true'
}
```

Registered in `services/web/app/src/infrastructure/Features.mjs`'s
`hasFeature()` switch under a new `'api-docs'` key, matching how
`'git-bridge'`, `'github-sync'`, and `'oauth'` are already registered.

The module must also be added, unconditionally, to the
`moduleImportSequence` array in `services/web/config/settings.defaults.js`
(alongside `github-sync`) — modules not listed there are never loaded by
`Modules.mjs` regardless of their env var, and (per the existing
`github-sync` comment explaining the same requirement) the module needs to
be present in the sequence so its webpack entry point resolves at build
time even when disabled at runtime.

## Frontend

**Theming**: the page must look native to Overleaf, not like a generic
Swagger UI/Redoc embed. Before implementation, use Playwright against the
running dev instance to capture the live design tokens actually in use —
color variables, typography, spacing, card/dropdown component styling — so
`ApiDocsPage.tsx` is built from the existing Bootstrap/OL component library
rather than approximated by eye.

**Layout**: endpoints grouped by resource (Git Bridge, Personal Access
Tokens), each as an expandable card showing method + path, description,
parameter table, request/response schema, and a copy-pasteable curl example.

**Button placement**: clone the existing `documentation` `DropdownItem` in
`services/web/frontend/js/features/ide-react/components/rail/rail-help-dropdown.tsx`
and `services/web/frontend/js/features/ide-react/components/toolbar/menu-bar.tsx`,
adding a new item directly below it:

```tsx
{showApiDocs && (
  <DropdownItem href="/api-docs" target="_blank" rel="noopener noreferrer">
    {t('api_documentation')}
  </DropdownItem>
)}
```

gated by a new `ol-apiDocsEnabled` meta flag, computed in
`ExpressLocals.mjs` (`apiDocsEnabled: Settings.enableApiDocs`) and injected
in `_meta.pug`:

```pug
meta(name="ol-apiDocsEnabled" data-type="boolean" content=settings.enableApiDocs)
```

mirroring the existing `ol-wikiEnabled` flag exactly.

## Data flow

1. Server starts; `ApiDocsRouter.mjs` checks `API_DOCS_ENABLED` and only
   mounts `/api-docs` and `/api/v0/openapi.json` if true.
2. `ExpressLocals.mjs` computes `apiDocsEnabled` and injects it as a meta
   tag on every page load.
3. The Help dropdown/menu reads `ol-apiDocsEnabled` and conditionally shows
   the "API documentation" item.
4. Visiting `/api-docs` serves `ApiDocsPage.tsx`, which fetches
   `/api/v0/openapi.json` client-side and renders the grouped, themed
   reference view.

## Error handling

- Flag off: both routes are simply never mounted (404 via Express's default
  handler, no custom error page needed — matches how `git-bridge` behaves
  when disabled).
- Not logged in: standard session auth redirect, same as every other page.
- `openapi.yaml` fails to parse at startup: fail loudly (throw during module
  init) rather than silently serving a broken page — this is static content
  reviewed at commit time, so a parse failure indicates a broken deploy, not
  a runtime condition to handle gracefully.

## Testing

- **Flag gating**: acceptance test asserting `/api-docs` and
  `/api/v0/openapi.json` 404 when `API_DOCS_ENABLED` is unset/false, and
  respond 200 when true.
- **Spec/route sync**: a unit test that loads `openapi.yaml` and cross-checks
  its documented paths against the actual mounted routes in
  `GitBridgeRouter.mjs` and `PersonalAccessTokenRouter.mjs`, failing CI if
  they diverge (a route added/changed without a matching spec update). This
  is the main defense against docs rot, which is the most common failure
  mode for hand-maintained API docs.
- **Frontend**: component test for `ApiDocsPage.tsx` rendering from a fixed
  fixture spec, and a check that the Help dropdown/menu item only appears
  when `ol-apiDocsEnabled` is true.

## Recommendations (beyond v1 scope, for later consideration)

- **Postman/Insomnia import link** on the docs page pointing at
  `/api/v0/openapi.json` — most API clients accept a raw OpenAPI URL
  directly, so this is close to free once the spec exists.
- **API changelog section** on the page (version, date, what changed) —
  becomes useful once a `v1` API namespace exists alongside `v0`.
- **MCP and internal-service docs** as a distinct v2 page/section, once
  there's a clear audience need — kept separate because MCP's protocol
  shape (JSON-RPC/OAuth) doesn't fit the REST-oriented OpenAPI model used
  here.
