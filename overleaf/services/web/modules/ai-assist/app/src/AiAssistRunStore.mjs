import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import { normalizeMode } from './AiAssistModePolicy.mjs'

const RUN_TTL_SECONDS = 7 * 24 * 3600 // 7 days retention
const MAX_HEARTBEAT_ENTRIES = 10_000
const ACTIVE_RUNS_KEY = 'ai-assist:active-runs'

export const TERMINAL_STATUSES = ['done', 'stopped', 'error', 'interrupted']

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

  async createRun({ runId, projectId, userId, metadata = {}, mode = 'manual' }) {
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._key(runId)
    const now = Date.now()
    await rclient.hset(key, {
      runId,
      projectId,
      userId,
      mode: normalizeMode(mode),
      status: 'running',
      heartbeat: String(now),
      createdAt: String(now),
      watchers: '0',
      followers: '0',
      zeroSince: '',
      metadata: JSON.stringify(metadata),
    })
    await rclient.sadd(ACTIVE_RUNS_KEY, runId)
    await rclient.expire(ACTIVE_RUNS_KEY, RUN_TTL_SECONDS)
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
      mode: normalizeMode(data.mode),
      heartbeat: Number(data.heartbeat || 0),
      createdAt: Number(data.createdAt || 0),
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
    }
  }

  async setMode(runId, mode) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), {
      mode: normalizeMode(mode),
      heartbeat: String(Date.now()),
    })
  }

  async updateStatus(runId, status, error = null) {
    if (TERMINAL_STATUSES.includes(status)) {
      this._lastHeartbeats.delete(runId)
    }
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
    if (TERMINAL_STATUSES.includes(status)) {
      await rclient.srem(ACTIVE_RUNS_KEY, runId)
    }
  }

  // `watchers` are editors showing the run: they can compile for it.
  // `followers` are panels following a chat that is not on screen: they only
  // keep the run from being reaped as abandoned, the reaper counts both.
  _watchField(follower) {
    return follower ? 'followers' : 'watchers'
  }

  async addWatcher(runId, { follower = false } = {}) {
    const rclient = this.getClient()
    if (!rclient) return 0
    const count = Number(
      await rclient.hincrby(this._key(runId), this._watchField(follower), 1)
    )
    // Somebody is watching again: the orphan clock stops.
    if (count > 0) await rclient.hset(this._key(runId), 'zeroSince', '')
    return count
  }

  async removeWatcher(runId, { follower = false } = {}) {
    const rclient = this.getClient()
    if (!rclient) return 0
    const field = this._watchField(follower)
    const count = Number(await rclient.hincrby(this._key(runId), field, -1))
    // A connection that never finished subscribing must not drive this below 0,
    // or a later reconnect would look like a watcher that is not there.
    if (count < 0) {
      await rclient.hset(this._key(runId), { [field]: '0' })
      return 0
    }
    // Nobody at all is watching now: start the orphan clock. The reaper reads this.
    if (count === 0) {
      const other = this._watchField(!follower)
      const otherCount = await rclient.hget(this._key(runId), other)
      if (!Number(otherCount || 0)) {
        await rclient.hset(this._key(runId), 'zeroSince', String(Date.now()))
      }
    }
    return count
  }

  async getWatcherCount(runId) {
    const rclient = this.getClient()
    if (!rclient) return 0
    return Number((await rclient.hget(this._key(runId), 'watchers')) || 0)
  }

  async setZeroSince(runId, ms) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), 'zeroSince', String(ms))
  }

  async clearZeroSince(runId) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), 'zeroSince', '')
  }

  async getActiveRuns() {
    const rclient = this.getClient()
    if (!rclient) return []
    return await rclient.smembers(ACTIVE_RUNS_KEY)
  }

  async reconcileStaleRuns({ heartbeatStaleMs = 1800_000 } = {}) {
    const rclient = this.getClient()
    if (!rclient) return []
    const runIds = await rclient.smembers(ACTIVE_RUNS_KEY)
    const acted = []
    const now = Date.now()
    for (const runId of runIds) {
      const run = await this.getRun(runId)
      // A run missing from its hash is already gone; drop it from the index.
      if (!run) { await rclient.srem(ACTIVE_RUNS_KEY, runId); continue }
      const terminal = TERMINAL_STATUSES.includes(run.status)
      if (terminal) { await rclient.srem(ACTIVE_RUNS_KEY, runId); continue }
      if (now - (run.heartbeat || 0) < heartbeatStaleMs) continue
      // Nothing has emitted for a very long time: the process driving this run
      // is gone. Mark it so a reconnecting client stops showing "thinking"
      // forever. This never aborts a live loop — see the heartbeat trap.
      const events = await this.getEvents(runId)
      const alreadyFinished = events.some(e => e?.event?.type === 'turnFinished')
      await this.updateStatus(runId, 'interrupted')
      if (!alreadyFinished) {
        await this.appendEvent(runId, { type: 'turnFinished', reason: 'interrupted' })
      }
      await rclient.srem(ACTIVE_RUNS_KEY, runId)
      acted.push(runId)
    }
    return acted
  }

  async touchHeartbeat(runId, minIntervalMs = 3000) {
    const rclient = this.getClient()
    if (!rclient) return
    const now = Date.now()
    const last = this._lastHeartbeats.get(runId) || 0
    if (now - last < minIntervalMs) return
    this._lastHeartbeats.delete(runId)
    // Sweep expired runs only when the map is full: a full scan on every touch is O(runs)
    if (this._lastHeartbeats.size >= MAX_HEARTBEAT_ENTRIES) {
      // Map order is last-touch order, so the expired entries come first
      for (const [cachedRunId, timestamp] of this._lastHeartbeats) {
        if (now - timestamp < RUN_TTL_SECONDS * 1000) break
        this._lastHeartbeats.delete(cachedRunId)
      }
    }
    while (this._lastHeartbeats.size >= MAX_HEARTBEAT_ENTRIES) {
      this._lastHeartbeats.delete(this._lastHeartbeats.keys().next().value)
    }
    this._lastHeartbeats.set(runId, now)
    await rclient.hset(this._key(runId), 'heartbeat', String(now))
  }

  async appendEvent(runId, event) {
    const rclient = this.getClient()
    if (!rclient) return 0
    const seqKey = `${this._key(runId)}:seq`
    const seq = await rclient.incr(seqKey)
    const payload = JSON.stringify({ seq, event })
    if (event?.type !== 'turnFinished') {
      this.touchHeartbeat(runId).catch(() => {})
    }
    await Promise.all([
      rclient.rpush(this._eventsKey(runId), payload),
      rclient.publish(this._channel(runId), payload),
    ])
    return seq
  }

  async getEvents(runId, sinceSeq = 0) {
    const rclient = this.getClient()
    if (!rclient) return []
    // seq N normally sits at list index N-1, because appendEvent INCRs then
    // RPUSHes and the run loop serialises its writes. Writers outside that
    // chain (stale-run reconciliation, the no-control-channel stop fallback)
    // can interleave, so read a little early and keep the seq filter.
    const SLACK = 16
    const since = Math.max(0, Number(sinceSeq) || 0)
    const start = Math.max(0, since - SLACK)
    const rawList = await rclient.lrange(this._eventsKey(runId), start, -1)
    const parsed = rawList.map(item => JSON.parse(item))
    return parsed.filter(item => item.seq > since)
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

  async clearPendingApproval(runId, nextStatus = 'running') {
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._key(runId)
    const heartbeat = String(Date.now())
    // A local approval may resume and finish the run before this cleanup
    // reaches Redis. Only change status while the approval is still pending,
    // so a late cleanup cannot replace a terminal status with `running`.
    await rclient.eval(
      `if redis.call('HGET', KEYS[1], 'status') == 'awaitingApproval' then
         redis.call('HSET', KEYS[1], 'status', ARGV[1], 'pendingApproval', '', 'heartbeat', ARGV[2])
       else
         redis.call('HSET', KEYS[1], 'pendingApproval', '', 'heartbeat', ARGV[2])
       end
       return 1`,
      1,
      key,
      nextStatus,
      heartbeat
    )
  }
}

export default new AiAssistRunStore()
