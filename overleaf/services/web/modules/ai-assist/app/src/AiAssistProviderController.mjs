import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import { createProviderClient, ProviderError } from './AiAssistProviders.mjs'
import {
  normalizeWebSearchSettings,
  testWebSearch,
} from './AiAssistWebTools.mjs'
import {
  hasImages,
  imageProblem,
  imageStats,
  isImageRejection,
} from './AiAssistImages.mjs'

/**
 * Every request to an LLM provider leaves from this server, never from the
 * browser. Providers commonly live on a private network (Ollama on the LAN,
 * an internal gateway), which a page served from a public HTTPS domain cannot
 * reach: mixed content, Private Network Access and CORS all block it.
 */

function errorPayload(err) {
  return {
    code:
      err?.code && typeof err.code === 'string' ? err.code : 'providerError',
    message: err?.message || 'The provider request failed.',
    ...(err?.hint ? { hint: err.hint } : {}),
  }
}

function httpStatusFor(err) {
  if (
    err?.code === 'invalidProviderUrl' ||
    err?.code === 'restrictedProviderUrl' ||
    err?.code === 'invalidWebSearchSettings'
  ) {
    return 400
  }
  // Upstream auth failures must not surface as 401/403 from Overleaf itself.
  return 502
}

function readProviderSettings(req, field = 'providerSettings') {
  const providerSettings = req.body?.[field]
  if (
    !providerSettings ||
    typeof providerSettings !== 'object' ||
    !providerSettings.type
  ) {
    return null
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

/** What the editor's text-only route passes on: no tool calls, no thinking. */
const EDITOR_CHUNKS = new Set(['text', 'stop'])

/** Starts an NDJSON response; returns the line writer. */
function openNdjson(res) {
  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  return chunk => {
    if (!res.writableEnded) res.write(`${JSON.stringify(chunk)}\n`)
  }
}

export class AiAssistProviderController {
  constructor({
    clientFactory = createProviderClient,
    webSearchTester = testWebSearch,
  } = {}) {
    this.clientFactory = clientFactory
    this.webSearchTester = webSearchTester
  }

  /** One small search through the configured web search backend. */
  testWebSearch = async (req, res) => {
    let settings
    try {
      const clientSettings = req.body?.webSearchSettings
      if (
        clientSettings?.sourceMode === 'server' &&
        Settings.aiAssist?.serverWebSearch?.enabled
      ) {
        settings = Settings.aiAssist.serverWebSearch
      } else if (
        clientSettings?.sourceMode === 'server' &&
        (!clientSettings?.providers ||
          Object.keys(clientSettings.providers).length === 0)
      ) {
        throw new ProviderError('Server web search is not enabled.', {
          code: 'serverWebSearchDisabled',
          status: 400,
        })
      } else {
        settings = normalizeWebSearchSettings(clientSettings, {
          allowConfiguredOnly: true,
        })
      }
      if (!settings) {
        throw new ProviderError('No web search providers are configured.', {
          code: 'invalidWebSearchSettings',
          status: 400,
        })
      }
    } catch (err) {
      return res.status(400).json({ error: errorPayload(err) })
    }
    const controller = abortOnDisconnect(req, res)
    try {
      const outcome = await this.webSearchTester(settings, {
        signal: controller.signal,
      })
      res.json(outcome)
    } catch (err) {
      if (controller.signal.aborted) return
      logger.debug(
        { err, type: settings.type },
        '[AiAssist] web search test failed'
      )
      res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
  }

  listModels = async (req, res) => {
    const providerSettings = readProviderSettings(req)
    if (!providerSettings) {
      return res.status(400).json({
        error: errorPayload(
          new ProviderError('Missing providerSettings', {
            code: 'invalidProviderSettings',
            status: 400,
          })
        ),
      })
    }
    const controller = abortOnDisconnect(req, res)
    try {
      const client = this.clientFactory(providerSettings)
      const models = await client.listModels({ signal: controller.signal })
      res.json({ models })
    } catch (err) {
      if (controller.signal.aborted) return
      logger.debug(
        { err, type: providerSettings.type },
        '[AiAssist] listing models failed'
      )
      res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
  }

  test = async (req, res) => {
    const providerSettings = readProviderSettings(req)
    if (!providerSettings) {
      return res.status(400).json({
        error: errorPayload(
          new ProviderError('Missing providerSettings', {
            code: 'invalidProviderSettings',
            status: 400,
          })
        ),
      })
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
      logger.debug(
        { err, type: providerSettings.type },
        '[AiAssist] provider test failed'
      )
      res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
  }

  /**
   * Streams one model turn as newline-delimited JSON chunks. The agent loop
   * and its editor tools stay in the page; only the provider call moves here.
   * Used by the chat panel and Error Assist, the two features with tools.
   */
  chat = (req, res) => this.relayChat(req, res, { tools: true })

  /**
   * The same for the AI inside the editor (completion, language suggestions,
   * writing tools, TeXGPT, the table and equation generators): text in, text
   * out. Tools are refused, and any tool call or thinking the model sends is
   * dropped, so text in the document can never make one of these features
   * act beyond the editor, whatever it asks the model to do.
   */
  editorText = (req, res) => this.relayChat(req, res, { tools: false })

  relayChat = async (req, res, { tools: toolsAllowed }) => {
    let primarySettings = readProviderSettings(req, 'providerSettings')
    let fallbackSettings = readProviderSettings(req, 'fallbackProviderSettings')
    if (!primarySettings && !fallbackSettings) {
      return res.status(400).json({
        error: errorPayload(
          new ProviderError('Missing providerSettings', {
            code: 'invalidProviderSettings',
            status: 400,
          })
        ),
      })
    }

    const activePrimary = primarySettings || fallbackSettings
    const activeFallback = primarySettings ? fallbackSettings : null

    const request = req.body?.request
    if (
      !request ||
      typeof request !== 'object' ||
      !Array.isArray(request.messages)
    ) {
      return res.status(400).json({
        error: { code: 'invalidRequest', message: 'Missing chat request' },
      })
    }
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 5000000
    if (Buffer.byteLength(JSON.stringify(request.messages)) > maxBytes) {
      return res.status(400).json({
        error: {
          code: 'contextExhausted',
          message: 'Conversation is too large to send',
        },
      })
    }

    const problem = imageProblem(request.messages)
    if (problem) {
      return res.status(400).json({
        error: { code: 'invalidRequest', message: problem },
      })
    }
    const withImages = hasImages(request.messages)
    const tools = Array.isArray(request.tools) ? request.tools : []
    if (!toolsAllowed && tools.length > 0) {
      return res.status(400).json({
        error: {
          code: 'invalidRequest',
          message: 'Editor features cannot use tools',
        },
      })
    }

    const controller = abortOnDisconnect(req, res)
    const write = openNdjson(res)
    let emittedAny = false
    let currentSettings = activePrimary

    const tryStream = async settings => {
      currentSettings = settings
      const client = this.clientFactory(settings)
      for await (const chunk of client.streamChat({
        system: typeof request.system === 'string' ? request.system : '',
        messages: request.messages,
        maxTokens: request.maxTokens,
        contextWindow:
          Number(request.contextWindow) > 0
            ? Number(request.contextWindow)
            : undefined,
        tools: toolsAllowed ? tools : [],
        cacheHints: request.cacheHints,
        signal: controller.signal,
      })) {
        if (!toolsAllowed && !EDITOR_CHUNKS.has(chunk?.type)) continue
        emittedAny = true
        write(chunk)
      }
    }

    try {
      try {
        await tryStream(activePrimary)
      } catch (primaryErr) {
        if (!emittedAny && activeFallback && !controller.signal.aborted) {
          logger.info(
            {
              err: primaryErr,
              primary: activePrimary.type,
              fallback: activeFallback.type,
            },
            '[AiAssist] primary provider failed before response, falling back to secondary'
          )
          await tryStream(activeFallback)
        } else {
          throw primaryErr
        }
      }
      write({ type: 'done' })
    } catch (err) {
      if (!controller.signal.aborted) {
        // A text-only model refusing the picture gets its own code: the
        // page tells the author to pick a vision model
        const error =
          withImages && isImageRejection(err)
            ? new ProviderError("This model can't read images.", {
                code: 'imageUnsupported',
                status: err.status,
              })
            : err
        logger.debug(
          {
            err,
            type: currentSettings?.type,
            ...(withImages ? { images: imageStats(request.messages) } : {}),
          },
          '[AiAssist] provider chat failed'
        )
        write({ type: 'error', error: errorPayload(error) })
      }
    } finally {
      if (!res.writableEnded) res.end()
    }
  }
}

export default new AiAssistProviderController()
