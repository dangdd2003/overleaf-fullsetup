import logger from '@overleaf/logger'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultManager from './AiAssistRunManager.mjs'
import defaultStore, { TERMINAL_STATUSES } from './AiAssistRunStore.mjs'
import defaultSubscriber from './AiAssistRunSubscriber.mjs'
import defaultUserSettingsStore from './AiAssistUserSettingsStore.mjs'
import defaultChatHistoryStore from './AiAssistChatHistoryStore.mjs'
import {
  bindStoredApiKey,
  normalizeProviderBaseUrl,
  validateSafeProviderBaseUrl,
} from './AiAssistProviders.mjs'
import {
  countActiveRunsForUser,
  countRunsOnInstance,
  MAX_ACTIVE_RUNS_PER_INSTANCE,
  MAX_CONCURRENT_RUNS_PER_USER,
} from './AiAssistRunLimits.mjs'
import {
  bindStoredWebSearchCredentials,
  fetchOnlyWebSettings,
  normalizeWebSearchSettings,
} from './AiAssistWebTools.mjs'
import { MODES } from './AiAssistModePolicy.mjs'
import { messageImagesProblem, suggestCaptureTitle } from './AiAssistImages.mjs'
import {
  COMPACT_INSTRUCTIONS_MAX_CHARS,
  compactEntriesProblem,
  isValidChatId,
} from './AiAssistChatHistoryStore.mjs'
import { normalizeCommandInvocation } from './AiAssistSlashCommands.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import TokenAccessHandler from '../../../../app/src/Features/TokenAccess/TokenAccessHandler.mjs'

// How long a new chat turn waits for the chat's previous run to leave the
// process: a run that just finished is still unwinding for a moment
const CHAT_IDLE_WAIT_MS = 3000
const CHAT_IDLE_POLL_MS = 100
// Redis subscribe that takes longer than this ends the stream for a retry
const SUBSCRIBE_TIMEOUT_MS = 10_000
// Project read access is re-checked on every fourth keepalive tick (~60s)
const ACCESS_RECHECK_EVERY_TICKS = 4

const MASKED_API_KEY = '••••••••'

/** The largest transcript or message, in bytes, a run accepts. */
function maxTranscriptBytes() {
  return Settings.aiAssist?.maxTranscriptBytes ?? 32 * 1024 * 1024
}

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
    chatHistoryStore = defaultChatHistoryStore,
    userSettingsStore = defaultUserSettingsStore,
  } = {}) {
    this.manager = manager
    this.store = store
    this.subscriber = subscriber
    this.authorization = authorization
    this.chatHistoryStore = chatHistoryStore
    this.userSettingsStore = userSettingsStore
    this._activeStreams = new Set()
    this._pendingRuns = 0
    this._pendingByUser = new Map()
    this._pendingChats = new Set()
  }

  closeAllStreams() {
    for (const endStream of [...this._activeStreams]) {
      try {
        endStream()
      } catch {}
    }
    this._activeStreams.clear()
  }

  /**
   * The logged-in user's id as a string, or null when the session holds no
   * user or an id that is not an ObjectId. Sessions may hold an ObjectId;
   * runs store the initiating id as a string.
   */
  #sessionUserId(req) {
    const id = SessionManager.getLoggedInUserId(req.session)
    return id && /^[0-9a-f]{24}$/i.test(String(id)) ? String(id) : null
  }

  /**
   * The run named in the request, or null after answering 404 when it does not
   * exist or 403 when it belongs to another project or initiating user.
   *
   * A run is private to the user who started it, like the chat it belongs to:
   * it runs on that user's provider settings and counts against their
   * concurrent-run limit, so other project members can neither watch nor
   * steer it.
   */
  async #loadRun(req, res) {
    const run = await this.store.getRun(req.params.runId)
    if (!run) {
      res.status(404).json({ error: 'Run not found' })
      return null
    }
    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      res.status(403).json({ error: 'Cross-project run access forbidden' })
      return null
    }
    // createRun always records an owner, so a run without one is never reachable
    const userId = this.#sessionUserId(req)
    if (!userId || !run.userId || userId !== run.userId) {
      res.status(403).json({ error: 'Run access forbidden' })
      return null
    }
    return run
  }

  /**
   * The legacy run routes name no project, so the project routes' middleware
   * has nothing to check there. The run's own project is checked here instead:
   * its owner keeps access only while they can still reach that project.
   * Answers 403 and returns false otherwise.
   */
  async #canReachLegacyRun(req, res, run, { write }) {
    // Only the run's owner may reach it, whatever access the project grants
    // anyone else, so the check does not rely on the caller having run #loadRun
    const sessionUserId = this.#sessionUserId(req)
    if (!sessionUserId || sessionUserId !== run.userId) {
      res.status(403).json({ error: 'Run access forbidden' })
      return false
    }
    const userId = run.userId
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
    // Every run needs an owner: only that user can reach it afterwards
    const userId = this.#sessionUserId(req)
    if (!userId) {
      return res.status(403).json({ error: 'Run access forbidden' })
    }
    let { transcript } = req.body || {}
    const { mode, chatId } = req.body || {}
    if (chatId !== undefined && chatId !== null && chatId !== '' && !isValidChatId(chatId)) {
      return res.status(400).json({ error: 'Invalid chat id' })
    }
    let providerSettings = req.body?.providerSettings
    const needsStoredProviderKey =
      !providerSettings ||
      !providerSettings.type ||
      !providerSettings.apiKey ||
      providerSettings.apiKey === MASKED_API_KEY

    if (needsStoredProviderKey) {
      let internal = null
      try {
        internal = await this.userSettingsStore.getInternalUserSettings(userId)
      } catch {}
      if (internal?.provider?.type && (!providerSettings || !providerSettings.type)) {
        providerSettings = internal.provider
      } else if (
        providerSettings &&
        typeof providerSettings === 'object' &&
        providerSettings.type
      ) {
        try {
          providerSettings = bindStoredApiKey(
            providerSettings,
            internal?.provider ?? null
          )
        } catch (err) {
          return res.status(400).json({ error: err.message })
        }
      }
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

    const maxBytes = maxTranscriptBytes()
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
    }

    // One compaction or turn at a time per chat, as the panel expects. A run
    // that has just finished may still be unwinding, so wait briefly for it.
    if (chatId && !(await this.#waitForChatIdle(projectId, userId, chatId))) {
      return res
        .status(409)
        .json({ error: 'The chat is already running', code: 'chatBusy' })
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
            p &&
            typeof p === 'object' &&
            ((Array.isArray(p.apiKeys) && p.apiKeys.includes('••••••••')) ||
              (Array.isArray(p.apiKeys) && p.apiKeys.length === 0) ||
              p.bearerToken === '••••••••')
        ))

    if (needsStoredWebKeys) {
      let internal = null
      try {
        internal = await this.userSettingsStore.getInternalUserSettings(userId)
      } catch {}
      if (internal?.webSearch) {
        try {
          clientWebSearchSettings = bindStoredWebSearchCredentials(
            clientWebSearchSettings,
            internal.webSearch
          )
        } catch (err) {
          return res.status(400).json({ error: err.message })
        }
      }
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

    const trusted = await this.#trustedTranscript(
      projectId,
      userId,
      chatId,
      transcript
    )
    if (!trusted) {
      return res.status(503).json({ error: 'Chat history is unavailable' })
    }
    if (trusted.length === 0) {
      return res
        .status(400)
        .json({ error: 'transcript must be a non-empty array' })
    }
    transcript = trusted

    const chatKey = chatId ? `${projectId}:${userId}:${chatId}` : null
    if (chatKey && this._pendingChats.has(chatKey)) {
      return res
        .status(409)
        .json({ error: 'The chat is already running', code: 'chatBusy' })
    }
    if (
      countRunsOnInstance(this.manager) + this._pendingRuns >=
      MAX_ACTIVE_RUNS_PER_INSTANCE
    ) {
      return res.status(429).json({
        error: 'Too many concurrent runs in progress',
        code: 'tooManyRuns',
      })
    }

    this._pendingRuns++
    this._pendingByUser.set(userId, (this._pendingByUser.get(userId) || 0) + 1)
    if (chatKey) this._pendingChats.add(chatKey)
    const runId = `run_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`
    let chatLockAcquired = false
    try {
      const pendingForUser = this._pendingByUser.get(userId) || 0
      if (
        (await countActiveRunsForUser(userId, { store: this.store })) +
          pendingForUser >
        MAX_CONCURRENT_RUNS_PER_USER
      ) {
        return res.status(429).json({
          error: 'Too many concurrent runs in progress',
          code: 'tooManyRuns',
        })
      }

      if (chatId && this.store.acquireChatRunLock) {
        chatLockAcquired = await this.store.acquireChatRunLock(
          projectId,
          userId,
          chatId,
          runId
        )
        if (!chatLockAcquired) {
          return res
            .status(409)
            .json({ error: 'The chat is already running', code: 'chatBusy' })
        }
      }

      // Answer once the run's record exists, so the stream can find it. A start
      // that fails after that is reported on the run's stream, as before.
      try {
        await this.manager.startRun({
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
      } catch (err) {
        logger.error({ err, runId }, '[AiAssist] Run background failed')
        const recorded = await this.store.getRun(runId).catch(() => null)
        if (!recorded) {
          if (chatLockAcquired) {
            await this.store
              .releaseChatRunLock?.(projectId, userId, chatId, runId)
              ?.catch?.(() => {})
          }
          return res.status(500).json({ error: 'The run could not start' })
        }
      }

      res.json({ runId })
    } finally {
      this._pendingRuns--
      const left = (this._pendingByUser.get(userId) || 1) - 1
      if (left > 0) this._pendingByUser.set(userId, left)
      else this._pendingByUser.delete(userId)
      if (chatKey) this._pendingChats.delete(chatKey)
    }
  }

  /**
   * True once no run of this process is going for the chat, or false when one
   * still is after CHAT_IDLE_WAIT_MS.
   */
  async #waitForChatIdle(projectId, userId, chatId) {
    const deadline = Date.now() + CHAT_IDLE_WAIT_MS
    while (this.manager.hasActiveRunForChat(projectId, userId, chatId)) {
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, CHAT_IDLE_POLL_MS))
    }
    return true
  }

  /**
   * The transcript a run sends to the model. The client sends the whole chat,
   * so for everything the model wrote, the stored chat is authoritative: an
   * assistant turn or compacted summary is replaced by its stored copy, and one
   * the chat does not store is dropped. The user's messages come as sent. A
   * chat not stored yet has nothing to check against, so it is taken as sent.
   */
  async #trustedTranscript(projectId, userId, chatId, transcript) {
    if (!chatId) return transcript
    let stored
    try {
      stored = await this.chatHistoryStore.getChat(projectId, userId, chatId)
    } catch (err) {
      logger.warn({ err, projectId, chatId }, '[AiAssist] chat not read to verify')
      return null
    }
    if (!stored) return transcript

    const storedById = new Map()
    for (const entry of stored.transcript || []) {
      if (entry?.id && (entry.role === 'assistant' || entry.role === 'compact')) {
        storedById.set(entry.id, entry)
      }
    }
    const trusted = []
    let dropped = 0
    for (const entry of transcript) {
      if (entry?.role !== 'assistant' && entry?.role !== 'compact') {
        trusted.push(entry)
        continue
      }
      const known = entry.id ? storedById.get(entry.id) : undefined
      if (known && known.role === entry.role) {
        trusted.push(known)
      } else {
        dropped++
      }
    }
    if (dropped > 0) {
      logger.warn(
        { projectId, chatId, dropped },
        '[AiAssist] dropped model entries the stored chat does not have'
      )
    }
    return trusted
  }

  streamRun = async (req, res) => {
    const { runId } = req.params
    const parsed = parseInt(req.query.since || '0', 10)
    const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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

    // Once headers are out, an error cannot become a JSON reply: release the
    // subscription and watcher, then end the stream.
    let cleanup = () => {}
    // Set once the stream has ended, for any reason. Nothing is written after.
    let ended = false
    const endStream = () => {
      if (ended) return
      ended = true
      this._activeStreams.delete(endStream)
      cleanup()
      if (!res.writableEnded) res.end()
    }
    this._activeStreams.add(endStream)
    const failStream = err => {
      logger.error({ err, runId }, '[AiAssist] Run stream failed')
      endStream()
    }
    try {
      // 1. Subscribe FIRST to avoid missing any live events
      const channel = `ai-assist:run:${runId}:channel`
      let lastSentSeq = sinceSeq
      const liveBuffer = []
      let subscribed = false
      let unsubscribe = null
      let keepAliveTimer = null

      // A terminal event ends the stream, whether live or replayed
      const isTerminal = event =>
        event?.type === 'turnFinished' || event?.type === 'error'

      const writeEvent = (seq, payload) => {
        if (ended || res.writableEnded) return
        lastSentSeq = seq
        res.write(`data: ${payload}\n\n`)
      }

      const onMessage = message => {
        if (!subscribed) {
          liveBuffer.push(message)
          return
        }
        if (ended) return
        let item
        try {
          item = JSON.parse(message)
        } catch {
          return
        }
        if (item.seq <= lastSentSeq) return
        if (item.seq !== lastSentSeq + 1) {
          // A live message was lost or came early: replay what is missing
          void drain()
          return
        }
        writeEvent(item.seq, message)
        if (isTerminal(item.event)) endStream()
      }

      // Replays every stored event after the last one sent, in seq order
      let draining = Promise.resolve()
      const drain = () => {
        draining = draining
          .then(async () => {
            if (ended) return
            const items = await this.store.getEvents(runId, lastSentSeq)
            items.sort((a, b) => a.seq - b.seq)
            for (const item of items) {
              if (ended) return
              if (item.seq <= lastSentSeq) continue
              writeEvent(item.seq, JSON.stringify(item))
              if (isTerminal(item.event)) {
                endStream()
                return
              }
            }
          })
          .catch(failStream)
        return draining
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

      cleanup = () => {
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

      const onDisconnect = () => {
        endStream()
      }
      req.on('close', onDisconnect)
      res.on?.('close', onDisconnect)
      if (req.destroyed || res.destroyed) {
        endStream()
        return
      }
      unsubscribe = await this.#subscribeWithTimeout(channel, onMessage)

      if (closed || ended) {
        // The client left while we were subscribing. Unwind without ever
        // incrementing, so the count cannot drift upward. cleanup() already ran
        // once with no unsubscribe handle; run it again to release the channel.
        cleanup()
        endStream()
        return
      }

      await this.store.addWatcher(...watchArgs)
      if (closed || ended) {
        await this.store.removeWatcher(...watchArgs).catch(() => {})
        endStream()
        return
      }
      watcherRegistered = true

      // 2. Keepalive, a heartbeat for the panel, and a catch-up for any live
      // message that was lost: each tick, on its own
      const keepAliveSeconds = Settings.aiAssist?.streamKeepAliveSeconds ?? 15
      if (keepAliveSeconds > 0) {
        let tick = 0
        keepAliveTimer = setInterval(() => {
          if (ended || res.writableEnded) return
          tick++
          // Lines starting with ':' are SSE comments: EventSource ignores them,
          // proxies see traffic.
          res.write(': keepalive\n\n')
          this.#tickStream({
            req,
            res,
            run,
            runId,
            tick,
            drain,
            endStream,
            isEnded: () => ended,
          }).catch(failStream)
        }, keepAliveSeconds * 1000)
        keepAliveTimer.unref?.()
      }

      // 3. Send existing catch-up events
      await drain()
      if (ended) return

      // 4. Flush buffered live messages that arrived during catch-up query
      subscribed = true
      for (const msg of liveBuffer) {
        onMessage(msg)
      }
      liveBuffer.length = 0
      await draining
      if (ended) return

      // Everything the run sent before this connection is out. A panel opening
      // a chat mid-run shows that at once, and animates only what comes next.
      if (!ended && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ caughtUp: true })}\n\n`)
      }

      const freshRun = await this.store.getRun(runId)
      if (ended) return
      if (freshRun && TERMINAL_STATUSES.includes(freshRun.status)) {
        await drain()
        endStream()
      }
    } catch (err) {
      failStream(err)
    }
  }

  /**
   * One tick of an open stream: a keepalive comment, a named heartbeat with
   * the run's phase, a replay of anything the live channel dropped, and every
   * minute a check that the user can still read the project.
   */
  async #tickStream({
    req,
    res,
    run,
    runId,
    tick,
    drain,
    endStream,
    isEnded = () => false,
  }) {
    const fresh = await this.store.getRun(runId)
    if (isEnded() || res.writableEnded) return
    if (!fresh) return endStream()
    // A named event, so EventSource.onmessage clients never see it
    const heartbeat = {
      phase: fresh.phase ?? null,
      phaseSince: fresh.phaseSince ? Number(fresh.phaseSince) : null,
      status: fresh.status ?? null,
    }
    res.write(`event: heartbeat\ndata: ${JSON.stringify(heartbeat)}\n\n`)
    if (
      tick % ACCESS_RECHECK_EVERY_TICKS === 0 &&
      !(await this.#canStillRead(req, run))
    ) {
      return endStream()
    }
    if (isEnded() || res.writableEnded) return
    await drain()
    if (isEnded() || res.writableEnded) return
    if (TERMINAL_STATUSES.includes(fresh.status)) {
      endStream()
    }
  }

  /** Whether the run's owner can still read its project, as at connect. */
  async #canStillRead(req, run) {
    try {
      const token = TokenAccessHandler.getRequestToken(req, run.projectId)
      return Boolean(
        await this.authorization.canUserReadProject(
          run.userId,
          run.projectId,
          token
        )
      )
    } catch {
      return false
    }
  }

  /**
   * Subscribes to the run's channel. A subscribe that takes too long fails, so
   * the stream ends and the client reconnects; a late handle is released.
   */
  async #subscribeWithTimeout(channel, listener) {
    const subscribing = this.subscriber.subscribe(channel, listener)
    subscribing.catch(() => {})
    let timer = null
    const timedOut = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Run stream subscribe timed out')),
        SUBSCRIBE_TIMEOUT_MS
      )
      timer.unref?.()
    })
    try {
      return await Promise.race([subscribing, timedOut])
    } catch (err) {
      subscribing.then(
        unsubscribe => unsubscribe?.(),
        () => {}
      )
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  stopRun = async (req, res) => {
    const { runId } = req.params
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
    if (contextText != null && typeof contextText !== 'string') {
      return res.status(400).json({ error: 'contextText must be a string' })
    }

    const maxBytes = maxTranscriptBytes()
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
      queued.images = images.map(img => ({
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
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
    const run = await this.#loadRun(req, res)
    if (!run) return

    const projectId = req.params.Project_id || req.params.project_id

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
