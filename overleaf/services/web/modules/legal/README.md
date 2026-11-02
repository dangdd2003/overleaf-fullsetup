# Legal Page Module (`legal`)

Adds a public Privacy & Terms page at `/legal` and a footer link. The page identifies the instance operator, uses the configured app name and administrator contact, and includes Terms of Service, Privacy Notice, Cookie Policy, Security Overview, and Acceptable Use Policy sections.

## Upstream CE comparison

Standard Overleaf CE does not provide an instance-specific legal page. This module supplies a self-hosted page for the operator to review and customize before enabling it.

## Activation and customization

Off by default. Set in `variable.env`:

```env
LEGAL_PAGE_ENABLED=true
```

The administrator contact comes from the existing Overleaf admin email setting. In the Overleaf settings file, `legalPage.lastModified` and `legalPage.sourceUrl` control the displayed update date and source-code link. Review the page's policy text for your deployment before making it public.

The page is public while the rest of the site may require login. `/robots.txt` allows crawlers to access `/legal` and disallows other paths. No additional database or environment configuration is used.

## Developer design

When enabled, `LegalRouter` adds `/legal` to the login allowlist and renders `LegalController`'s Pug view. The controller combines `legalPage` settings with the existing app name and admin email. Its app middleware serves the restricted `robots.txt` response.

There are no new MongoDB collections or feature-specific roles. Page text is static in the view; the date and source link are deployment settings. The route is public and does not read or write user or project records.
