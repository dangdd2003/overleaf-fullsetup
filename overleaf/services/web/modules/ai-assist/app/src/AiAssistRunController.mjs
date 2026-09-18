import logger from '@overleaf/logger'
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultManager from './AiAssistRunManager.mjs'
import defaultStore from './AiAssistRunStore.mjs'
import defaultSubscriber from './AiAssistRunSubscriber.mjs'
import { validateSafeProviderBaseUrl } from './AiAssistProviders.mjs'
import { MODES } from './AiAssistModePolicy.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistRunController {
  constructor({
    manager = defaultManager,
    store = defaultStore,
    subscriber = defaultSubscriber,
  } = {}) {
    this.manager = manager
    this.store = store
    this.subscriber = subscriber
  }

  createRun = async (req, res) => {
    const projectId = req.params.Project_id || req.params.project_id
    const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
    const userId =
      loggedInUserId && /^[0-9a-f]{24}$/i.test(String(loggedInUserId))
        ? String(loggedInUserId)
        : null
    const { transcript, providerSettings, mode } = req.body || {}

    if (!transcript || !providerSettings) {
      return res.status(400).json({ error: 'Missing transcript or providerSettings' })
    }

    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 5000000
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'transcript must be a non-empty array' })
    }
    const size = Buffer.byteLength(JSON.stringify(transcript))
    if (size > maxBytes) {
      return res.status(400).json({ error: 'Conversation is too large to send' })
    }

    const baseUrl = providerSettings.baseUrl || providerSettings.baseURL
    if (baseUrl) {
      try {
        validateSafeProviderBaseUrl(baseUrl)
      } catch (err) {
        return res.status(400).json({ error: err.message })
      }
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
      })
      .catch(err => {
        logger.error({ err, runId }, '[AiAssist] Run background failed')
      })

    res.json({ runId })
  }

  streamRun = async (req, res) => {
    const { runId } = req.params
    const sinceSeq = parseInt(req.query.since || '0', 10)

    const run = await this.store.getRun(runId)
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }

    const projectId = req.params.Project_id || req.params.project_id
    if (projectId && run.projectId !== projectId) {
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
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
        if (parsed.event?.type === 'turnFinished' || parsed.event?.type === 'error') {
          cleanup()
          res.end()
        }
      } catch {}
    }

    let counted = false
    let closed = false

    const releaseWatcher = () => {
      if (closed) return
      closed = true
      if (counted) {
        void this.store.removeWatcher(runId).catch(() => {})
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

    counted = true
    await this.store.addWatcher(runId)

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

    const freshRun = await this.store.getRun(runId)
    if (freshRun && (freshRun.status === 'done' || freshRun.status === 'stopped' || freshRun.status === 'error' || freshRun.status === 'interrupted')) {
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
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
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
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
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
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
    }

    const { id, outcome } = req.body || {}
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'Missing compile request id' })
    }
    await this.manager.submitCompileResult(runId, { id, outcome })
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
      return res.status(403).json({ error: 'Cross-project run access forbidden' })
    }

    const mode = req.body?.mode
    if (!MODES.includes(mode)) {
      return res.status(400).json({ error: `Invalid mode: ${mode}. Allowed: ${MODES.join(', ')}` })
    }

    await this.manager.setMode(runId, mode)
    res.json({ ok: true })
  }
}

export default new AiAssistRunController()
