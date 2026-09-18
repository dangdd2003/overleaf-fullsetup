import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { createProviderClient, ProviderError } from './AiAssistProviders.mjs'

/**
 * Every request to an LLM provider leaves from this server, never from the
 * browser. Providers commonly live on a private network (Ollama on the LAN,
 * an internal gateway), which a page served from a public HTTPS domain cannot
 * reach: mixed content, Private Network Access and CORS all block it.
 */

function errorPayload(err) {
  return {
    code: err?.code && typeof err.code === 'string' ? err.code : 'providerError',
    message: err?.message || 'The provider request failed.',
    ...(err?.hint ? { hint: err.hint } : {}),
  }
}

function httpStatusFor(err) {
  if (err?.code === 'invalidProviderUrl' || err?.code === 'restrictedProviderUrl') {
    return 400
  }
  // Upstream auth failures must not surface as 401/403 from Overleaf itself.
  return 502
}

function readProviderSettings(req) {
  const providerSettings = req.body?.providerSettings
  if (!providerSettings || typeof providerSettings !== 'object' || !providerSettings.type) {
    throw new ProviderError('Missing providerSettings', { code: 'invalidProviderSettings', status: 400 })
  }
  return providerSettings
}

function abortOnDisconnect(req, res) {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on?.('close', onClose)
  return controller
}

export class AiAssistProviderController {
  constructor({ clientFactory = createProviderClient } = {}) {
    this.clientFactory = clientFactory
  }

  listModels = async (req, res) => {
    let providerSettings
    try {
      providerSettings = readProviderSettings(req)
    } catch (err) {
      return res.status(400).json({ error: errorPayload(err) })
    }
    const controller = abortOnDisconnect(req, res)
    try {
      const client = this.clientFactory(providerSettings)
      const models = await client.listModels({ signal: controller.signal })
      res.json({ models })
    } catch (err) {
      if (controller.signal.aborted) return
      logger.debug({ err, type: providerSettings.type }, '[AiAssist] listing models failed')
      res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
  }

  test = async (req, res) => {
    let providerSettings
    try {
      providerSettings = readProviderSettings(req)
    } catch (err) {
      return res.status(400).json({ error: errorPayload(err) })
    }
    const controller = abortOnDisconnect(req, res)
    const startedAt = Date.now()
    try {
      const client = this.clientFactory(providerSettings)
      // eslint-disable-next-line no-unused-vars
      for await (const _chunk of client.streamChat({
        system: 'Reply with the single word: ok',
        messages: [{ role: 'user', content: 'ok' }],
        maxTokens: 1,
        signal: controller.signal,
      })) {
        break
      }
      res.json({ latencyMs: Date.now() - startedAt })
    } catch (err) {
      if (controller.signal.aborted) return
      logger.debug({ err, type: providerSettings.type }, '[AiAssist] provider test failed')
      res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
  }

  /**
   * Streams one model turn as newline-delimited JSON chunks. The agent loop
   * and its editor tools stay in the page; only the provider call moves here.
   */
  chat = async (req, res) => {
    let providerSettings
    try {
      providerSettings = readProviderSettings(req)
    } catch (err) {
      return res.status(400).json({ error: errorPayload(err) })
    }
    const request = req.body?.request
    if (!request || typeof request !== 'object' || !Array.isArray(request.messages)) {
      return res.status(400).json({
        error: { code: 'invalidRequest', message: 'Missing chat request' },
      })
    }
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 5000000
    if (Buffer.byteLength(JSON.stringify(request.messages)) > maxBytes) {
      return res.status(400).json({
        error: { code: 'contextExhausted', message: 'Conversation is too large to send' },
      })
    }

    let client
    try {
      client = this.clientFactory(providerSettings)
    } catch (err) {
      return res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }

    const controller = abortOnDisconnect(req, res)
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const write = chunk => {
      if (!res.writableEnded) res.write(`${JSON.stringify(chunk)}\n`)
    }

    try {
      for await (const chunk of client.streamChat({
        system: typeof request.system === 'string' ? request.system : '',
        messages: request.messages,
        maxTokens: request.maxTokens,
        contextWindow: Number(request.contextWindow) > 0 ? Number(request.contextWindow) : undefined,
        tools: Array.isArray(request.tools) ? request.tools : [],
        cacheHints: request.cacheHints,
        signal: controller.signal,
      })) {
        write(chunk)
      }
      write({ type: 'done' })
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.debug({ err, type: providerSettings.type }, '[AiAssist] provider chat failed')
        write({ type: 'error', error: errorPayload(err) })
      }
    } finally {
      if (!res.writableEnded) res.end()
    }
  }
}

export default new AiAssistProviderController()
