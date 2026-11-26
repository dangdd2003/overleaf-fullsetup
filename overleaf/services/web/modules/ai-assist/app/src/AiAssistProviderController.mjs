import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import {
  bindStoredApiKey,
  createProviderClient,
  normalizeProviderBaseUrl,
} from './AiAssistProviders.mjs'
import { ProviderError } from './AiAssistErrors.mjs'
import defaultUserSettingsStore, {
  MASKED_SECRET,
  applyStoredProviderSecret,
  resolveStoredWebSearchSettings,
  stripMaskedProviderSecret,
} from './AiAssistUserSettingsStore.mjs'
import { streamWithRetry } from './AiAssistRetry.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import {
  bindStoredWebSearchCredentials,
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

/** What the page shows in place of a stored API key it must not see again. */
const isMaskedKey = key => key === MASKED_SECRET

function errorPayload(err) {
  return {
    code:
      err?.code && typeof err.code === 'string' ? err.code : 'providerError',
    message: err?.message || 'The provider request failed.',
    ...(err?.hint ? { hint: err.hint } : {}),
  }
}

function sendMissingProviderSettings(res) {
  return res.status(400).json({
    error: errorPayload(
      new ProviderError('Missing providerSettings', {
        code: 'invalidProviderSettings',
        status: 400,
      })
    ),
  })
}

function httpStatusFor(err) {
  if (
    err?.code === 'invalidProviderUrl' ||
    err?.code === 'restrictedProviderUrl' ||
    err?.code === 'invalidWebSearchSettings' ||
    err?.code === 'providerKeyMismatch'
  ) {
    return 400
  }
  // Upstream auth failures must not surface as 401/403 from Overleaf itself.
  return 502
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

// Editor completions are short and shown inline: their limits are tight
const EDITOR_MAX_TOKENS = 4096
const EDITOR_CONNECT_MS = 20000
const EDITOR_IDLE_MS = 30000
const EDITOR_TOTAL_MS = 90000
const EDITOR_MAX_CONCURRENT = 4

// Editor streams in progress, per user, in this process
const editorStreamsByUser = new Map()

/** Whether settings the page sent describe the same provider as a stored slot. */
function sameProvider(sent, stored) {
  if (sent.type !== stored.type) return false
  const base = s => normalizeProviderBaseUrl(s.type, s.baseUrl || s.baseURL) || ''
  if (base(sent) !== base(stored)) return false
  return !sent.model || !stored.model || sent.model === stored.model
}

/** A slot for one editor stream, or null when the user already has the maximum. */
function acquireEditorStream(userId) {
  const key = userId || ''
  const count = editorStreamsByUser.get(key) ?? 0
  if (count >= EDITOR_MAX_CONCURRENT) return null
  editorStreamsByUser.set(key, count + 1)
  return () => {
    const left = (editorStreamsByUser.get(key) ?? 1) - 1
    if (left > 0) editorStreamsByUser.set(key, left)
    else editorStreamsByUser.delete(key)
  }
}

// The retry policies a page may ask the relay for; anything else gets the default
const RELAY_RETRY_POLICIES = new Set(['interactive', 'background', 'inline'])

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
    userSettingsStore = defaultUserSettingsStore,
  } = {}) {
    this.clientFactory = clientFactory
    this.webSearchTester = webSearchTester
    this.userSettingsStore = userSettingsStore
  }

  /** The slot a request's settings field stands for when it names none. */
  _slotFor(req, field, requested) {
    if (requested?.slot) return requested.slot
    if (
      field === 'fallbackProviderSettings' ||
      field === 'fastProviderSettings'
    ) {
      return 'fastProvider'
    }
    return req.body?.slot || 'provider'
  }

  /** The settings with the base URL normalized, or null without a provider type. */
  _finalizeSettings(providerSettings) {
    if (
      !providerSettings ||
      typeof providerSettings !== 'object' ||
      !providerSettings.type
    ) {
      return null
    }
    const rawBaseUrl = providerSettings.baseUrl || providerSettings.baseURL
    const baseUrl = normalizeProviderBaseUrl(providerSettings.type, rawBaseUrl)
    const { baseURL: _omitBaseURL, ...rest } = providerSettings
    return {
      ...rest,
      baseUrl,
    }
  }

  async _resolveProviderSettings(req, field = 'providerSettings') {
    const requested = req.body?.[field]
    const userId = req.session ? SessionManager.getLoggedInUserId(req.session) : null
    const needsStored =
      !requested ||
      !requested.type ||
      !requested.apiKey ||
      isMaskedKey(requested.apiKey)
    let stored = null
    if (userId && needsStored) {
      try {
        const internal = await this.userSettingsStore.getInternalUserSettings(userId)
        stored = internal[this._slotFor(req, field, requested)] ?? null
      } catch {}
    }
    let providerSettings
    if (!requested || !requested.type) {
      // Nothing usable was sent: the stored slot stands for the whole provider
      providerSettings = stored?.type ? stored : null
    } else if (needsStored) {
      // A stored key is sent only to the provider and address it was saved for
      providerSettings = bindStoredApiKey(requested, stored)
    } else {
      providerSettings = requested
    }
    providerSettings = stripMaskedProviderSecret(providerSettings)
    return this._finalizeSettings(providerSettings)
  }

  /**
   * The editor's provider: the stored slot alone. Settings the page sends with
   * an editor request are not used, so a page cannot pick the host or key.
   */
  async _storedProviderSettings(req, userId) {
    if (!userId) return { primary: null, fallback: null }
    try {
      const internal = await this.userSettingsStore.getInternalUserSettings(userId)
      const usable = slot =>
        internal[slot]?.type ? this._finalizeSettings(internal[slot]) : null
      // The page names the provider it wants by sending that slot's settings
      // (fast model first, main model as fallback). Only the stored copy of the
      // slot it matches is used, so the page picks a slot, never a host or key.
      const slotOf = sent => {
        if (!sent || typeof sent !== 'object') return null
        if (sent.slot === 'fastProvider' || sent.slot === 'provider') {
          return sent.slot
        }
        for (const slot of ['fastProvider', 'provider']) {
          const stored = internal[slot]
          if (stored?.type && sameProvider(sent, stored)) return slot
        }
        return null
      }
      const primarySlot =
        (req.body?.slot === 'fastProvider' && 'fastProvider') ||
        slotOf(req.body?.providerSettings) ||
        'provider'
      const fallbackSlot = slotOf(req.body?.fallbackProviderSettings)
      const primary = usable(primarySlot)
      const fallback =
        fallbackSlot && fallbackSlot !== primarySlot ? usable(fallbackSlot) : null
      return { primary, fallback }
    } catch {
      return { primary: null, fallback: null }
    }
  }

  /** One small search through the configured web search backend. */
  testWebSearch = async (req, res) => {
    let settings
    try {
      const userId = req.session ? SessionManager.getLoggedInUserId(req.session) : null
      const clientSettings = await resolveStoredWebSearchSettings(
        req.body?.webSearchSettings,
        this.userSettingsStore,
        userId
      )

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
    let providerSettings
    try {
      providerSettings = await this._resolveProviderSettings(req)
    } catch (err) {
      return res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
    if (!providerSettings) return sendMissingProviderSettings(res)
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
    let providerSettings
    try {
      providerSettings = await this._resolveProviderSettings(req)
    } catch (err) {
      return res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
    }
    if (!providerSettings) return sendMissingProviderSettings(res)
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
  editorText = (req, res) =>
    this.relayChat(req, res, { tools: false, editor: true })

  relayChat = async (req, res, { tools: toolsAllowed, editor = false }) => {
    const userId = req.session ? SessionManager.getLoggedInUserId(req.session) : null
    let primarySettings
    let fallbackSettings = null
    if (editor) {
      const stored = await this._storedProviderSettings(req, userId)
      primarySettings = stored.primary
      fallbackSettings = stored.fallback
    } else {
      try {
        primarySettings = await this._resolveProviderSettings(req, 'providerSettings')
        fallbackSettings = await this._resolveProviderSettings(req, 'fallbackProviderSettings')
      } catch (err) {
        return res.status(httpStatusFor(err)).json({ error: errorPayload(err) })
      }
    }
    if (!primarySettings && !fallbackSettings) {
      return sendMissingProviderSettings(res)
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
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 32 * 1024 * 1024
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
    const contextWindow =
      Number(request.contextWindow) > 0 ? Number(request.contextWindow) : undefined
    if (!toolsAllowed && tools.length > 0) {
      return res.status(400).json({
        error: {
          code: 'invalidRequest',
          message: 'Editor features cannot use tools',
        },
      })
    }

    const releaseEditorStream = editor ? acquireEditorStream(userId) : null
    if (editor && !releaseEditorStream) {
      return res.status(429).json({
        error: errorPayload(
          new ProviderError('Too many AI requests are running. Try again shortly.', {
            code: 'providerBusy',
            status: 429,
          })
        ),
      })
    }

    const controller = abortOnDisconnect(req, res)
    // The editor's whole reply is bounded in time; the timer reports as a timeout
    let timedOut = false
    const totalTimer = editor
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, EDITOR_TOTAL_MS)
      : null
    const write = openNdjson(res)
    let emittedAny = false
    let currentSettings = activePrimary
    // The chat panel shows a status line while it waits; editor features run unseen
    const retryPolicy = RELAY_RETRY_POLICIES.has(req.body?.retryPolicy)
      ? req.body.retryPolicy
      : toolsAllowed
        ? 'interactive'
        : 'background'

    const tryStream = async settings => {
      currentSettings = settings
      const client = this.clientFactory(
        editor
          ? {
              ...settings,
              connectTimeoutMs: EDITOR_CONNECT_MS,
              streamIdleTimeoutMs: EDITOR_IDLE_MS,
            }
          : settings
      )
      const maxTokens = editor
        ? Math.min(Number(request.maxTokens) || EDITOR_MAX_TOKENS, EDITOR_MAX_TOKENS)
        : request.maxTokens
      // A failure is retried only while nothing has reached the page yet
      const relayed = streamWithRetry(
        async function* () {
          for await (const chunk of client.streamChat({
            system: typeof request.system === 'string' ? request.system : '',
            messages: request.messages,
            maxTokens,
            contextWindow,
            tools: toolsAllowed ? tools : [],
            cacheHints: request.cacheHints,
            signal: controller.signal,
          })) {
            if (!toolsAllowed && !EDITOR_CHUNKS.has(chunk?.type)) continue
            yield chunk
          }
        },
        {
          policy: retryPolicy,
          signal: controller.signal,
          canRetry: () => !emittedAny,
          onRetry: event => write(event),
        }
      )
      for await (const chunk of relayed) {
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
      if (timedOut) {
        write({
          type: 'error',
          error: errorPayload(
            new ProviderError('The provider took too long to answer.', {
              code: 'providerTimeout',
            })
          ),
        })
      } else if (!controller.signal.aborted) {
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
      clearTimeout(totalTimer)
      releaseEditorStream?.()
      if (!res.writableEnded) res.end()
    }
  }
}

export default new AiAssistProviderController()
