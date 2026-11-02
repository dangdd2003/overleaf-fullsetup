# API Docs Module (`api-docs`)

Provides an authenticated OpenAPI viewer at `/api-docs` and a JSON specification at `/api/v0/openapi.json`. The displayed specification removes operations for features that are disabled on this instance.

## Upstream CE comparison

Upstream Overleaf CE provides application APIs, but does not include this deployment-specific interactive API reference. This module documents enabled APIs from this installation, including extension endpoints.

## Activation

Off by default. Set in `variable.env`:

```env
API_DOCS_ENABLED=true
```

Both routes require a signed-in user. The specification is generated from the module's OpenAPI file and filters endpoints using the instance's enabled-feature flags. It stores no user or project data.

## Developer design

`ApiDocsModule` registers the routes only when enabled. `ApiDocsRouter` requires a login, then `ApiDocsController` renders the React viewer or returns the filtered spec from `app/src/openapi.json`. Operations tagged with `x-feature` are included only when that feature is enabled; filtered specs are cached by feature set.

There are no new MongoDB collections. The page reads the signed-in user's existing `User` settings only to apply their editor theme. API behavior is otherwise read-only and is not tied to an Overleaf project role.
