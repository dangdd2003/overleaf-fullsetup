import logger from '@overleaf/logger'
import crypto from 'node:crypto'
import defaultManager from './AiAssistRunManager.mjs'
import defaultStore from './AiAssistRunStore.mjs'
import { validateSafeProviderBaseUrl } from './AiAssistProviders.mjs'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistRunController {
  constructor({ manager = defaultManager, store = defaultStore } = {}) {
    this.manager = manager
    this.store = store
  }

  createRun = async (req, res) => {
    const projectId = req.params.Project_id || req.params.project_id
    const loggedInUserId = SessionManager.getLoggedInUserId(req.session)
    const userId =
      loggedInUserId && /^[0-9a-f]{24}$/i.test(String(loggedInUserId))
        ? String(loggedInUserId)
        : null
    const { transcript, providerSettings } = req.body || {}

    if (!transcript || !providerSettings) {
      return res.status(400).json({ error: 'Missing transcript or providerSettings' })
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
    res.setHeader?.('Cache-Control', 'no-cache')
    res.setHeader?.('Connection', 'keep-alive')
    res.flushHeaders?.()

    // 1. Subscribe FIRST to avoid missing any live events
    const subClient = RedisWrapper.client('ai-assist')
    const channel = `ai-assist:run:${runId}:channel`
    let lastSentSeq = sinceSeq
    const liveBuffer = []
    let subscribed = false

    const onMessage = (chan, message) => {
      if (chan !== channel) return
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

    const cleanup = () => {
      try {
        subClient.unsubscribe(channel)
        subClient.removeListener('message', onMessage)
      } catch {}
    }

    req.on('close', cleanup)
    subClient.on('message', onMessage)
    await subClient.subscribe(channel)

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
      onMessage(channel, msg)
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
}

export default new AiAssistRunController()
