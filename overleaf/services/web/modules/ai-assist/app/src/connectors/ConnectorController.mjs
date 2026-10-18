import ConnectorService from './ConnectorService.mjs'
import { clientMetadataUrl, redirectUri, siteUrl } from './McpOAuth.mjs'

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

/** JSON safe inside a <script>: no `</script>` or `<!--` can close it early. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export const ConnectorController = {
  async list(req, res, next) {
    try {
      const data = await ConnectorService.list(req.user._id)
      res.json(data)
    } catch (err) {
      next(err)
    }
  },

  async probe(req, res, next) {
    try {
      const result = await ConnectorService.probe(req.body)
      res.json(result)
    } catch (err) {
      next(err)
    }
  },

  async create(req, res, _next) {
    try {
      const result = await ConnectorService.create(req.user._id, req.body)
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async import(req, res, _next) {
    try {
      const result = await ConnectorService.import(
        req.user._id,
        req.body?.config
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async update(req, res, _next) {
    try {
      const result = await ConnectorService.update(
        req.params.id,
        req.user._id,
        req.body
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async remove(req, res, _next) {
    try {
      const result = await ConnectorService.remove(
        req.params.id,
        req.user._id
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async authorize(req, res, _next) {
    try {
      const result = await ConnectorService.authorize(
        req.params.id,
        req.user._id,
        { scope: req.body?.scope }
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async refresh(req, res, _next) {
    try {
      const result = await ConnectorService.refresh(
        req.params.id,
        req.user._id
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async disconnect(req, res, _next) {
    try {
      const result = await ConnectorService.disconnect(
        req.params.id,
        req.user._id
      )
      res.json(result)
    } catch (err) {
      res
        .status(err.status || 400)
        .json({ error: err.message, code: err.code })
    }
  },

  async oauthCallback(req, res, _next) {
    const { code, state, iss, error, error_description } = req.query
    // Read before the callback consumes the sign-in, so failures name it too
    let connectorId = ''
    try {
      connectorId = await ConnectorService.pendingConnectorId({
        state,
        userId: req.user?._id,
      })
    } catch {}
    let outcome = {
      type: 'ai-assist:connector-oauth',
      connectorId,
      status: 'error',
      error: 'Unknown authorization error',
    }

    try {
      const result = await ConnectorService.handleCallback({
        code,
        state,
        iss,
        error,
        errorDescription: error_description,
        userId: req.user?._id,
      })
      if (result.next === 'connected') {
        outcome = {
          type: 'ai-assist:connector-oauth',
          connectorId: result.connector?.id || connectorId,
          status: 'connected',
        }
      } else {
        outcome = {
          type: 'ai-assist:connector-oauth',
          connectorId: result.connector?.id || connectorId,
          status: 'error',
          error:
            result.connector?.lastError?.message ||
            (result.next === 'authorize'
              ? 'Signed in, but the server still asks for sign-in. Try again, or check the connector in settings.'
              : 'The connection failed after sign-in.'),
        }
      }
    } catch (err) {
      outcome = {
        type: 'ai-assist:connector-oauth',
        connectorId,
        status: 'error',
        error: err.message || 'Authorization failed',
      }
    }

    const nonce = res.locals?.scriptNonce || res.locals?.nonce || ''
    const nonceAttr = nonce ? ` nonce="${nonce}"` : ''
    const isSuccess = outcome.status === 'connected'

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>MCP Server Authorization</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8f9fa; color: #333; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 420px; margin: 1rem; }
    h2 { margin-top: 0; color: ${isSuccess ? '#28a745' : '#dc3545'}; }
    a { color: #007bff; text-decoration: none; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${isSuccess ? 'Authorization Complete' : 'Authorization Failed'}</h2>
    <p>${isSuccess ? 'Your MCP connector has been connected successfully. This window will close automatically.' : escapeHtml(outcome.error || 'Failed to authorize MCP connector.')}</p>
    <p><a href="/user/settings#ai-connectors">Return to Settings</a></p>
  </div>
  <script${nonceAttr}>
    const payload = ${scriptJson(outcome)};
    try {
      const bc = new BroadcastChannel('ai-assist-connectors');
      bc.postMessage(payload);
      bc.close();
    } catch (e) {}
    try {
      localStorage.setItem('ai-assist:connector-oauth', JSON.stringify(payload));
    } catch (e) {}
    try {
      if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
      }
    } catch (e) {}
    setTimeout(() => {
      try { window.close(); } catch (e) {}
    }, 1000);
  </script>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  },

  clientMetadata(req, res) {
    res.json({
      client_id: clientMetadataUrl(),
      client_name: 'Overleaf AI Assist',
      client_uri: siteUrl(),
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  },
}

export default ConnectorController
