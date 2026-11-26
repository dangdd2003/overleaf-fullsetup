import crypto from 'node:crypto'
import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'
import { normalizeMode } from './AiAssistModePolicy.mjs'

const RUN_TTL_SECONDS = 7 * 24 * 3600 // 7 days retention
const MAX_HEARTBEAT_ENTRIES = 10_000
const ACTIVE_RUNS_KEY = 'ai-assist:active-runs'

// Each process owns its runs under a random id and keeps a short lease alive
// while it has runs. A run whose owner lease is gone was driven by a process
// that is no longer there, whatever its heartbeat or watcher counts say.
export const OWNER_ID = `owner_${crypto.randomUUID()}`
export const OWNER_LEASE_TTL_SECONDS = 60
export const OWNER_LEASE_RENEW_MS = 20_000
// Grace after the lease is first seen missing before a run is marked orphaned
export const ORPHAN_GRACE_MS = 90_000

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

  // The user's own runs in the active index, so a per-user count does not
  // read every user's runs
  _userActiveKey(userId) {
    return `${ACTIVE_RUNS_KEY}:user:${userId}`
  }

  _eventsKey(runId) {
    return `ai-assist:run:${runId}:events`
  }

  _channel(runId) {
    return `ai-assist:run:${runId}:channel`
  }

  _ownerKey(ownerId) {
    return `ai-assist:owner:${ownerId}`
  }

  _chatLockKey(projectId, userId, chatId) {
    return `ai-assist:chat-run:${projectId}:${userId}:${chatId}`
  }

  async acquireChatRunLock(projectId, userId, chatId, runId) {
    if (!chatId) return true
    const rclient = this.getClient()
    if (!rclient || typeof rclient.set !== 'function') return true
    const res = await rclient.set(
      this._chatLockKey(projectId, userId, chatId),
      runId,
      'EX',
      3600,
      'NX'
    )
    return res === 'OK' || res === true
  }

  async releaseChatRunLock(projectId, userId, chatId, runId) {
    if (!chatId) return
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._chatLockKey(projectId, userId, chatId)
    if (typeof rclient.eval === 'function') {
      await rclient
        .eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then
             return redis.call('DEL', KEYS[1])
           end
           return 0`,
          1,
          key,
          runId
        )
        .catch(() => {})
    } else if (typeof rclient.del === 'function') {
      await rclient.del(key).catch(() => {})
    }
  }

  async purgeUserRuns(userId, runIds = null) {
    const rclient = this.getClient()
    if (!rclient || !userId) return
    const ids = Array.isArray(runIds)
      ? runIds
      : await this.getActiveRunsForUser(userId)
    for (const runId of ids) {
      await Promise.allSettled([
        rclient.del?.(this._key(runId)),
        rclient.del?.(`${this._key(runId)}:seq`),
        rclient.del?.(this._eventsKey(runId)),
        rclient.srem?.(ACTIVE_RUNS_KEY, runId),
      ])
    }
    await rclient.del?.(this._userActiveKey(userId))?.catch?.(() => {})
  }

  /** Keeps this process's lease alive. Called by the run manager while it has runs. */
  async renewOwnerLease(ownerId = OWNER_ID) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.set(this._ownerKey(ownerId), '1', 'EX', OWNER_LEASE_TTL_SECONDS)
  }

  async isOwnerAlive(ownerId) {
    const rclient = this.getClient()
    if (!rclient || !ownerId) return true
    return Number(await rclient.exists(this._ownerKey(ownerId))) > 0
  }

  async createRun({
    runId,
    projectId,
    userId,
    metadata = {},
    mode = 'manual',
    ownerId = OWNER_ID,
  }) {
    const rclient = this.getClient()
    if (!rclient) return
    const key = this._key(runId)
    const now = Date.now()
    const fields = {
      runId,
      projectId,
      userId,
      ownerId,
      mode: normalizeMode(mode),
      status: 'running',
      heartbeat: String(now),
      createdAt: String(now),
      watchers: '0',
      followers: '0',
      zeroSince: '',
      metadata: JSON.stringify(metadata),
    }
    if (typeof rclient.multi === 'function') {
      const multi = rclient.multi()
      multi.hset(key, fields)
      multi.expire(key, RUN_TTL_SECONDS)
      multi.sadd(ACTIVE_RUNS_KEY, runId)
      multi.expire(ACTIVE_RUNS_KEY, RUN_TTL_SECONDS)
      if (userId) {
        const userKey = this._userActiveKey(userId)
        multi.sadd(userKey, runId)
        multi.expire(userKey, RUN_TTL_SECONDS)
      }
      await multi.exec()
      return
    }
    await rclient.hset(key, fields)
    await rclient.expire(key, RUN_TTL_SECONDS)
    await rclient.sadd(ACTIVE_RUNS_KEY, runId)
    await rclient.expire(ACTIVE_RUNS_KEY, RUN_TTL_SECONDS)
    if (userId) {
      const userKey = this._userActiveKey(userId)
      await rclient.sadd(userKey, runId)
      await rclient.expire(userKey, RUN_TTL_SECONDS)
    }
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

  /**
   * A durable stop: written in addition to the control-channel broadcast, so
   * a stop is not lost when the owning process does not hear it. The loop
   * checks it at every step boundary and while it waits.
   */
  async requestStop(runId) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), 'stopRequested', '1')
  }

  async isStopRequested(runId) {
    const rclient = this.getClient()
    if (!rclient) return false
    return (await rclient.hget(this._key(runId), 'stopRequested')) === '1'
  }

  /** Where the run is now (provider, tool:<name>, approval, ...), for telemetry. */
  async setPhase(runId, phase) {
    const rclient = this.getClient()
    if (!rclient) return
    await rclient.hset(this._key(runId), {
      phase,
      phaseSince: String(Date.now()),
    })
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
      const userId = await rclient.hget(this._key(runId), 'userId')
      if (userId) await rclient.srem(this._userActiveKey(userId), runId)
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

  async getActiveRunsForUser(userId) {
    const rclient = this.getClient()
    if (!rclient || !userId) return []
    return await rclient.smembers(this._userActiveKey(userId))
  }

  async removeActiveRunForUser(userId, runId) {
    const rclient = this.getClient()
    if (!rclient || !userId) return
    await rclient.srem(this._userActiveKey(userId), runId)
  }

  async _claimStaleTransition(rclient, runId, nextStatus, error = null) {
    const key = this._key(runId)
    const now = String(Date.now())
    if (typeof rclient.eval === 'function') {
      const res = await rclient.eval(
        `local cur = redis.call('HGET', KEYS[1], 'status')
         if not cur or cur == 'done' or cur == 'stopped' or cur == 'error' or cur == 'interrupted' then
           return 0
         end
         redis.call('HSET', KEYS[1], 'status', ARGV[1], 'heartbeat', ARGV[2])
         if ARGV[3] ~= '' then
           redis.call('HSET', KEYS[1], 'error', ARGV[3])
         end
         return 1`,
        1,
        key,
        nextStatus,
        now,
        error ? JSON.stringify(error) : ''
      )
      return Number(res) === 1
    }
    const fresh = await this.getRun(runId)
    if (!fresh || TERMINAL_STATUSES.includes(fresh.status)) return false
    await this.updateStatus(runId, nextStatus, error)
    return true
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

      // The owner's lease is gone: its process died. Watchers are irrelevant
      // here (their counts have no TTL and may be stale), only the lease counts.
      if (run.ownerId && !(await this.isOwnerAlive(run.ownerId))) {
        const since = Number(run.ownerMissingSince || 0)
        if (!since) {
          await rclient.hset(this._key(runId), 'ownerMissingSince', String(now))
          continue
        }
        if (now - since < ORPHAN_GRACE_MS) continue
        const message = 'This run was interrupted: the server process running it stopped.'
        const claimed = await this._claimStaleTransition(rclient, runId, 'error', { message })
        if (claimed) {
          await this.appendEvent(runId, { type: 'error', code: 'runOrphaned', message })
          await this.appendEvent(runId, { type: 'turnFinished', reason: 'stop' })
          await rclient.srem(ACTIVE_RUNS_KEY, runId)
          if (run.userId) await rclient.srem(this._userActiveKey(run.userId), runId)
          acted.push(runId)
        }
        continue
      }
      if (run.ownerMissingSince) {
        await rclient.hset(this._key(runId), 'ownerMissingSince', '')
      }

      if (now - (run.heartbeat || 0) < heartbeatStaleMs) continue
      // Nothing has emitted for a very long time: the process driving this run
      // is gone. Mark it so a reconnecting client stops showing "thinking"
      // forever. This never aborts a live loop — see the heartbeat trap.
      const claimed = await this._claimStaleTransition(rclient, runId, 'interrupted')
      if (claimed) {
        const events = await this.getEvents(runId)
        const alreadyFinished = events.some(e => e?.event?.type === 'turnFinished')
        if (!alreadyFinished) {
          await this.appendEvent(runId, { type: 'turnFinished', reason: 'interrupted' })
        }
        await rclient.srem(ACTIVE_RUNS_KEY, runId)
        if (run.userId) await rclient.srem(this._userActiveKey(run.userId), runId)
        acted.push(runId)
      }
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
    const eventsKey = this._eventsKey(runId)
    const seq = await rclient.incr(seqKey)
    const payload = JSON.stringify({ seq, event })
    if (event?.type !== 'turnFinished') {
      this.touchHeartbeat(runId).catch(() => {})
    }
    // The seq key and events list are created here, so they take their TTL
    // here too; sent together, the EXPIREs add no round trip
    await Promise.all([
      rclient.expire(seqKey, RUN_TTL_SECONDS),
      rclient.rpush(eventsKey, payload),
      rclient.expire(eventsKey, RUN_TTL_SECONDS),
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
