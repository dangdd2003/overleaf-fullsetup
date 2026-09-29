/** Page fixtures shared by the web-fetch tests. */

export const ARTICLE_TEXT =
  'The siunitx package typesets numbers and units consistently in LaTeX documents. '.repeat(
    12
  )

export const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<script>window._cf_chl_opt={cvId:'3',cZone:'example.com'};</script></head>
<body><div class="main-wrapper"><h1>example.com</h1><p>Checking if the site connection is secure</p>
<noscript>Enable JavaScript and cookies to continue</noscript></div></body></html>`

export const AKAMAI_DENIED = `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>
You don't have permission to access this server.<p>Reference #18.6f1b2c17.1727300000.1a2b3c</p></body></html>`

export const DATADOME_BLOCK = `<html><head><title>example.com</title></head><body>
<script src="https://ct.captcha-delivery.com/c.js"></script><p>Please enable JS and disable any ad blocker</p></body></html>`

/** An app that renders everything in JavaScript: the HTML is an empty root. */
export function spaShell(scriptBytes = 25_000) {
  return `<!doctype html><html><head><title>App</title><script>${'x'.repeat(scriptBytes)}</script></head><body><div id="root"></div></body></html>`
}

export function articlePage(text = ARTICLE_TEXT, title = 'siunitx guide') {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`
}

/** What the guarded transport returns for an HTML page. */
export function htmlResponse(url, html, extra = {}) {
  return {
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: Buffer.from(html),
    truncated: false,
    ...extra,
  }
}
