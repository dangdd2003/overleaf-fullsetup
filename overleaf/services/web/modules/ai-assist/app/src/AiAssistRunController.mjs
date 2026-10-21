import logger from '@overleaf/logger'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultManager from './AiAssistRunManager.mjs'
import defaultStore, { TERMINAL_STATUSES } from './AiAssistRunStore.mjs'
import defaultSubscriber from './AiAssistRunSubscriber.mjs'
import defaultUserSettingsStore from './AiAssistUserSettingsStore.mjs'
import {
  normalizeProviderBaseUrl,
  validateSafeProviderBaseUrl,
} from './AiAssistProviders.mjs'
import {
  fetchOnlyWebSettings,
  normalizeWebSearchSettings,
} from './AiAssistWebTools.mjs'
import { MODES } from './AiAssistModePolicy.mjs'
import { messageImagesProblem, suggestCaptureTitle } from './AiAssistImages.mjs'
import {
  COMPACT_INSTRUCTIONS_MAX_CHARS,
  compactEntriesProblem,
} from './AiAssistChatHistoryStore.mjs'
import { normalizeCommandInvocation } from './AiAssistSlashCommands.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import TokenAccessHandler from '../../../../app/src/Features/TokenAccess/TokenAccessHandler.mjs'

/**
 * The web settings a run may use, from what the browser sent. Null when the
 * instance has no web tools or the user disabled web search. A client cannot
 * switch the tools on by sending settings; a run with no search backend
 * still reads pages. Throws on invalid client settings.
 */
export function resolveWebSearchSettings(clientSettings) {
  if (!Settings.aiAssist?.webToolsEnabled) return null
  if (clientSettings?.sourceMode === 'disabled') return null
  let settings = null
  if (
    clientSettings?.sourceMode === 'server' ||
    (!clientSettings && Settings.aiAssist?.serverWebSearch?.enabled)
  ) {
    settings = Settings.aiAssist?.serverWebSearch?.enabled
      ? Settings.aiAssist.serverWebSearch
      : null
  } else if (clientSettings) {
    // Force server cache configuration regardless of what client sent
    const { cacheHours, maxCachedSearches, maxCachedPages } = Settings.aiAssist || {}
    settings = normalizeWebSearchSettings({
      ...clientSettings,
      ...(cacheHours !== undefined ? { cacheHours } : {}),
      ...(maxCachedSearches !== undefined ? { maxCachedSearches } : {}),
      ...(maxCachedPages !== undefined ? { maxCachedPages } : {}),
    })
  }
  return settings ?? fetchOnlyWebSettings()
}

export class AiAssistRunController {
  constructor({
    manager = defaultManager,
    store = defaultStore,
    subscriber = defaultSubscriber,
    authorization = AuthorizationManager.promises,
  } = {}) {
    this.manager = manager
    this.store = store
    this.subscriber = subscriber
    this.authorization = authorization
  }

  /**
   * The legacy run routes name no project, so the project routes' middleware
   * has nothing to check there. The run's own project is checked here instead:
   * a run is only streamed, stopped or approved by someone who can reach its
   * project. Answers 403 and returns false otherwise.
   */
  async #canReachLegacyRun(req, res, run, { write }) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const token = TokenAccessHandler.getRequestToken(req, run.projectId)
    const allowed = write
      ? await this.authorization.canUserWriteProjectContent(
          userId,
          run.projectId,
          token
        )
      : await this.authorization.canUserReadProject(userId, run.projectId, token)
    if (!allowed) {
      res.status(403).json({ error: 'Run access forbidden' })
    }
    return Boolean(allowed)
  }

  createRun = async (req, res) => {
    const projectId = req.params.Project_id || req.params.project_id
    const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
    const userId =
      loggedInUserId && /^[0-9a-f]{24}$/i.test(String(loggedInUserId))
        ? String(loggedInUserId)
        : null
    const { transcript, mode, chatId } = req.body || {}
    let providerSettings = req.body?.providerSettings
    const needsStoredProviderKey =
      !providerSettings ||
      !providerSettings.type ||
      !providerSettings.apiKey ||
      providerSettings.apiKey === '••••••••'

    if (userId && needsStoredProviderKey) {
      try {
        const internal = await defaultUserSettingsStore.getInternalUserSettings(userId)
        if (internal.provider?.type) {
          if (!providerSettings || !providerSettings.type) {
            providerSettings = internal.provider
          } else if (!providerSettings.apiKey || providerSettings.apiKey === '••••••••') {
            providerSettings = { ...providerSettings, apiKey: internal.provider.apiKey }
          }
        }
      } catch {}
    }

    if (
      !transcript ||
      !providerSettings ||
      typeof providerSettings !== 'object'
    ) {
      return res
        .status(400)
        .json({ error: 'Missing transcript or providerSettings' })
    }

    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 32 * 1024 * 1024
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res
        .status(400)
        .json({ error: 'transcript must be a non-empty array' })
    }
    const size = Buffer.byteLength(JSON.stringify(transcript))
    if (size > maxBytes) {
      return res
        .status(400)
        .json({ error: 'Conversation is too large to send' })
    }
    for (const entry of transcript) {
      const problem =
        entry?.role === 'user' ? messageImagesProblem(entry.images) : null
      if (problem) return res.status(400).json({ error: problem })
    }
    const compactProblem = compactEntriesProblem(transcript)
    if (compactProblem) return res.status(400).json({ error: compactProblem })

    // A run is a chat turn (the default) or a compaction of the chat
    const kind = req.body?.kind ?? 'chat'
    if (kind !== 'chat' && kind !== 'compact') {
      return res.status(400).json({ error: 'Unknown run kind' })
    }
    let compaction = null
    if (kind === 'compact') {
      const instructions = req.body?.instructions ?? ''
      if (
        typeof instructions !== 'string' ||
        instructions.length > COMPACT_INSTRUCTIONS_MAX_CHARS
      ) {
        return res.status(400).json({
          error: `instructions must be a string of at most ${COMPACT_INSTRUCTIONS_MAX_CHARS} characters`,
        })
      }
      const trigger = req.body?.trigger ?? 'manual'
      if (trigger !== 'manual' && trigger !== 'auto') {
        return res.status(400).json({ error: 'trigger must be manual or auto' })
      }
      compaction = { instructions: instructions.trim(), trigger }
      // One compaction or turn at a time per chat, as the panel expects
      if (this.manager.hasActiveRunForChat(projectId, userId, chatId)) {
        return res
          .status(409)
          .json({ error: 'The chat is already running', code: 'chatBusy' })
      }
    }

    const rawBaseUrl = providerSettings.baseUrl || providerSettings.baseURL
    const baseUrl = rawBaseUrl
      ? normalizeProviderBaseUrl(providerSettings.type, rawBaseUrl)
      : ''
    if (baseUrl) {
      try {
        validateSafeProviderBaseUrl(baseUrl)
      } catch (err) {
        return res.status(400).json({ error: err.message })
      }
      providerSettings = { ...providerSettings, baseUrl }
    }

    let clientWebSearchSettings = req.body?.webSearchSettings
    const needsStoredWebKeys =
      clientWebSearchSettings?.sourceMode === 'custom' &&
      (!clientWebSearchSettings.providers ||
        Object.keys(clientWebSearchSettings.providers).length === 0 ||
        Object.values(clientWebSearchSettings.providers).some(
          p =>
            (Array.isArray(p?.apiKeys) && p.apiKeys.includes('••••••••')) ||
            p?.bearerToken === '••••••••'
        ))

    if (userId && needsStoredWebKeys) {
      try {
        const internal = await defaultUserSettingsStore.getInternalUserSettings(userId)
        if (internal.webSearch) {
          if (!clientWebSearchSettings || Object.keys(clientWebSearchSettings.providers || {}).length === 0) {
            clientWebSearchSettings = internal.webSearch
          } else if (internal.webSearch.providers) {
            for (const [name, p] of Object.entries(clientWebSearchSettings.providers || {})) {
              const storedP = internal.webSearch.providers[name]
              if (storedP) {
                if (Array.isArray(p.apiKeys)) {
                  p.apiKeys = p.apiKeys.map((k, idx) => k === '••••••••' ? (storedP.apiKeys?.[idx] || k) : k)
                  if (p.apiKeys.length === 0 && storedP.apiKeys?.length) p.apiKeys = storedP.apiKeys
                }
                if (p.bearerToken === '••••••••' && storedP.bearerToken) {
                  p.bearerToken = storedP.bearerToken
                }
              }
            }
          }
        }
      } catch {}
    }

    let webSearchSettings
    try {
      webSearchSettings = resolveWebSearchSettings(clientWebSearchSettings)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    let connectorIds = null
    if (Array.isArray(req.body?.connectorIds)) {
      connectorIds = req.body.connectorIds
        .filter(id => typeof id === 'string' && id.trim())
        .slice(0, 50)
    }

    const runId = `run_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`

    // Start background promise without awaiting completion
    this.manager
      .startRun({
        runId,
        projectId,
        userId,
        transcript,
        providerSettings,
        mode,
        chatId,
        webSearchSettings,
        connectorIds,
        kind,
        compaction,
      })
      .catch(err => {
        logger.error({ err, runId }, '[AiAssist] Run background failed')
      })

    res.json({ runId })
  }

  streamRun = async (req, res) => {
    const { runId } = req.params
    const parsed = parseInt(req.query.since || '0', 10)
    const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    if (
      !projectId &&
      !(await this.#canReachLegacyRun(req, res, run, { write: false }))
    ) {
      return
    }

    res.setHeader?.('Content-Type', 'text/event-stream')
    res.setHeader?.('Cache-Control', 'no-cache, no-transform')
    res.setHeader?.('Connection', 'keep-alive')
    // nginx (including the one inside the server-ce image) buffers proxied
    // responses by default, which holds SSE frames back until the buffer fills.
    res.setHeader?.('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    // 1. Subscribe FIRST to avoid missing any live events
    const channel = `ai-assist:run:${runId}:channel`
    let lastSentSeq = sinceSeq
    const liveBuffer = []
    let subscribed = false
    let unsubscribe = null
    let keepAliveTimer = null

    const onMessage = message => {
      if (!subscribed) {
        liveBuffer.push(message)
        return
      }
      try {
        const parsed = JSON.parse(message)
        if (parsed.seq <= lastSentSeq) return
        lastSentSeq = parsed.seq
        res.write(`data: ${message}\n\n`)
        if (
          parsed.event?.type === 'turnFinished' ||
          parsed.event?.type === 'error'
        ) {
          cleanup()
          res.end()
        }
      } catch {}
    }

    let watcherRegistered = false
    let closed = false
    // `watch=0` is a panel following a chat it is not showing, to save the
    // reply when it lands. It keeps the run from being reaped, but cannot
    // compile or approve, so the run does not count it as an editor watching.
    const watch = req.query?.watch === '0' ? { follower: true } : undefined
    const watchArgs = watch ? [runId, watch] : [runId]

    const releaseWatcher = () => {
      if (closed) return
      closed = true
      if (watcherRegistered) {
        watcherRegistered = false
        void this.store.removeWatcher(...watchArgs).catch(() => {})
      }
    }

    const cleanup = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimer = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      releaseWatcher()
    }

    req.on('close', cleanup)
    unsubscribe = await this.subscriber.subscribe(channel, onMessage)

    if (closed) {
      // The client left while we were subscribing. Unwind without ever
      // incrementing, so the count cannot drift upward. cleanup() already ran
      // once with no unsubscribe handle; run it again to release the channel.
      cleanup()
      res.end()
      return
    }

    await this.store.addWatcher(...watchArgs)
    if (closed) {
      await this.store.removeWatcher(...watchArgs).catch(() => {})
      res.end()
      return
    }
    watcherRegistered = true

    const keepAliveSeconds = Settings.aiAssist?.streamKeepAliveSeconds ?? 15
    if (keepAliveSeconds > 0) {
      keepAliveTimer = setInterval(() => {
        if (closed || res.writableEnded) return
        // Lines starting with ':' are SSE comments: EventSource ignores them,
        // proxies see traffic.
        res.write(': keepalive\n\n')
      }, keepAliveSeconds * 1000)
      keepAliveTimer.unref?.()
    }

    // 2. Send existing catch-up events
    const existingEvents = await this.store.getEvents(runId, sinceSeq)
    for (const item of existingEvents) {
      if (item.seq > lastSentSeq) {
        lastSentSeq = item.seq
        res.write(`data: ${JSON.stringify(item)}\n\n`)
      }
    }

    // 3. Flush buffered live messages that arrived during catch-up query
    subscribed = true
    for (const msg of liveBuffer) {
      onMessage(msg)
    }
    // Everything the run sent before this connection is out. A panel opening
    // a chat mid-run shows that at once, and animates only what comes next.
    if (!closed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ caughtUp: true })}\n\n`)
    }

    const freshRun = await this.store.getRun(runId)
    if (
      freshRun &&
      (freshRun.status === 'done' ||
        freshRun.status === 'stopped' ||
        freshRun.status === 'error' ||
        freshRun.status === 'interrupted')
    ) {
      cleanup()
      res.end()
    }
  }

  stopRun = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    if (
      !projectId &&
      !(await this.#canReachLegacyRun(req, res, run, { write: true }))
    ) {
      return
    }

    await this.manager.stopRun(runId)
    res.json({ ok: true })
  }

  approve = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    if (
      !projectId &&
      !(await this.#canReachLegacyRun(req, res, run, { write: true }))
    ) {
      return
    }

    const decision = req.body || { accepted: false }
    await this.manager.approveEdit(runId, decision)
    res.json({ ok: true })
  }

  compileResult = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    const { id, outcome } = req.body || {}
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'Missing compile request id' })
    }
    await this.manager.submitCompileResult(runId, { id, outcome })
    res.json({ ok: true })
  }

  /**
   * Adds a message to a run that is already going, instead of starting a new
   * one. A run that has already finished answers 409 so the client can fall
   * back to a fresh run rather than silently dropping what the user typed.
   */
  queueMessage = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    if (TERMINAL_STATUSES.includes(run.status)) {
      return res.status(409).json({
        error: 'Run is no longer accepting messages',
        status: run.status,
      })
    }

    const { id, text, contextText, commandText, command, images } =
      req.body || {}
    // A command is checked and kept only with its harness block: a command
    // turn with no words after the name is valid, so text may then be empty
    const invocation = normalizeCommandInvocation(command)
    const commandBlock =
      invocation && typeof commandText === 'string' ? commandText : ''
    const hasImages = Array.isArray(images) && images.length > 0
    if (
      typeof text !== 'string' ||
      (!text.trim() && !commandBlock && !hasImages)
    ) {
      return res.status(400).json({ error: 'text must be a non-empty string' })
    }

    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 32 * 1024 * 1024
    const size =
      Buffer.byteLength(text) +
      Buffer.byteLength(contextText || '') +
      Buffer.byteLength(commandBlock) +
      (hasImages ? Buffer.byteLength(JSON.stringify(images)) : 0)
    if (size > maxBytes) {
      return res.status(413).json({ error: 'Message too large' })
    }
    const imagesProblem = messageImagesProblem(images)
    if (imagesProblem) return res.status(400).json({ error: imagesProblem })

    // The run may be past its last look at the queue while its status still
    // says running; it turns the message away rather than leave it unread.
    const queued = { id, text, contextText }
    if (commandBlock) {
      queued.commandText = commandBlock
      queued.command = invocation
    }
    if (hasImages) {
      queued.images = images.map((img, idx) => ({
        ...img,
        name:
          img.name ||
          suggestCaptureTitle({
            page: img.page,
            timestamp: Date.now(),
            mediaType: img.mediaType,
          }),
      }))
    }
    if (!(await this.manager.queueMessage(runId, queued))) {
      return res.status(409).json({
        error: 'Run is no longer accepting messages',
        status: run.status,
      })
    }
    res.json({ ok: true })
  }

  /**
   * Takes back a message sent into a run before the run has read it. 409 when
   * it is too late: `reason` says whether the run read it or has ended.
   */
  unqueueMessage = async (req, res) =>
    this.#actOnQueuedMessage(req, res, (runId, messageId) =>
      this.manager.unqueueMessage(runId, messageId)
    )

  /**
   * Has the run answer a queued message now rather than after the reply it is
   * writing. 409 when the run has read it already or has ended.
   */
  sendQueuedNow = async (req, res) =>
    this.#actOnQueuedMessage(req, res, (runId, messageId) =>
      this.manager.sendQueuedNow(runId, messageId)
    )

  /**
   * Checks the run of a queued message is live and in this project, then
   * applies `action`. 409 with reason 'read' when it answers false.
   */
  async #actOnQueuedMessage(req, res, action) {
    const { runId, messageId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    if (TERMINAL_STATUSES.includes(run.status)) {
      return res.status(409).json({ error: 'Run has ended', reason: 'ended' })
    }

    if ((await action(runId, messageId)) === false) {
      return res
        .status(409)
        .json({ error: 'The run has already read it', reason: 'read' })
    }
    res.json({ ok: true })
  }

  setMode = async (req, res) => {
    const { runId } = req.params
    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res
        .status(403)
        .json({ error: 'Cross-project run access forbidden' })
    }

    const mode = req.body?.mode
    if (!MODES.includes(mode)) {
      return res
        .status(400)
        .json({ error: `Invalid mode: ${mode}. Allowed: ${MODES.join(', ')}` })
    }

    await this.manager.setMode(runId, mode)
    res.json({ ok: true })
  }
}

export default new AiAssistRunController()
