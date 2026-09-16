import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

const RUN_TTL_SECONDS = 7 * 24 * 3600 // 7 days retention

export class AiAssistRunStore {
  constructor(redisClient = null) {
    this._rclient = redisClient
    this._lastHeartbeats = new Map()
  }

  getClient() {
    if (!this._rclient) {
      try {
        this._rclient = RedisWrapper.client('ai-assist')
      } catch (err) {
        return null
      }
    }
    return this._rclient
  }

  _key(runId) {
    return `ai-assist:run:${runId}`
  }

  _eventsKey(runId) {
    return `ai-assist:run:${runId}:events`
  }

  _channel(runId) {
    return `ai-assist:run:${runId}:channel`
  }

  async createRun({ runId, projectId, userId, metadata = {} }) {
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._key(runId)
    const now = Date.now()
    await rclient.hset(key, {
      runId,
      projectId,
      userId,
      status: 'running',
      heartbeat: String(now),
      createdAt: String(now),
      metadata: JSON.stringify(metadata),
    })
    await rclient.expire(key, RUN_TTL_SECONDS)
    await rclient.expire(this._eventsKey(runId), RUN_TTL_SECONDS)
  }

  async getRun(runId) {
    const rclient = this.getClient()
    if (!rclient) return null
    const data = await rclient.hgetall(this._key(runId))
    if (!data || Object.keys(data).length === 0) return null
    return {
      ...data,
      heartbeat: Number(data.heartbeat || 0),
      createdAt: Number(data.createdAt || 0),
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
    }
  }

  async updateStatus(runId, status, error = null) {
    const rclient = this.getClient()
    if (!rclient) return
    const updates = {
      status,
      heartbeat: String(Date.now()),
    }
    if (error) {
      updates.error = JSON.stringify(error)
    }
    await rclient.hset(this._key(runId), updates)
  }

  async touchHeartbeat(runId, minIntervalMs = 3000) {
    const rclient = this.getClient()
    if (!rclient) return
    const now = Date.now()
    const last = this._lastHeartbeats.get(runId) || 0
    if (now - last < minIntervalMs) return
    this._lastHeartbeats.set(runId, now)
    await rclient.hset(this._key(runId), 'heartbeat', String(now))
  }

  async appendEvent(runId, event) {
    const rclient = this.getClient()
    if (!rclient) return 0
    const seqKey = `${this._key(runId)}:seq`
    const seq = await rclient.incr(seqKey)
    const payload = JSON.stringify({ seq, event })
    void this.touchHeartbeat(runId)
    await Promise.all([
      rclient.rpush(this._eventsKey(runId), payload),
      rclient.publish(this._channel(runId), payload),
    ])
    return seq
  }

  async getEvents(runId, sinceSeq = 0) {
    const rclient = this.getClient()
    if (!rclient) return []
    const rawList = await rclient.lrange(this._eventsKey(runId), 0, -1)
    const parsed = rawList.map(item => JSON.parse(item))
    return parsed.filter(item => item.seq > sinceSeq)
  }

  async setPendingApproval(runId, approvalData) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), {
      status: 'awaitingApproval',
      pendingApproval: JSON.stringify(approvalData),
      heartbeat: String(Date.now()),
    })
  }

  async getPendingApproval(runId) {
    const run = await this.getRun(runId)
    if (!run?.pendingApproval) return null
    return typeof run.pendingApproval === 'string'
      ? JSON.parse(run.pendingApproval)
      : run.pendingApproval
  }

  async clearPendingApproval(runId, nextStatus = 'running') {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), {
      status: nextStatus,
      pendingApproval: '',
      heartbeat: String(Date.now()),
    })
  }
}

export default new AiAssistRunStore()
