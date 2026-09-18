import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

/**
 * One Redis connection in subscriber mode, shared by every run stream in this
 * process.
 *
 * RedisWrapper.client() opens a new connection (and registers a shutdown
 * drainer) on every call, so a connection per SSE request leaks one per
 * stream, reconnect and page reload. Channels are reference-counted: Redis
 * SUBSCRIBE happens for the first listener, UNSUBSCRIBE after the last.
 */
export class AiAssistRunSubscriber {
  constructor({ clientFactory = () => RedisWrapper.client('ai-assist') } = {}) {
    this.clientFactory = clientFactory
    this._client = null
    this._listeners = new Map()
    this._pending = new Map()
    this._onMessage = (channel, message) => {
      const listeners = this._listeners.get(channel)
      if (!listeners) return
      for (const listener of [...listeners]) {
        try {
          listener(message)
        } catch {
          // One broken stream must not starve the others on this channel.
        }
      }
    }
  }

  _getClient() {
    if (!this._client) {
      this._client = this.clientFactory()
      this._client.on('message', this._onMessage)
    }
    return this._client
  }

  _remove(channel, listener, client) {
    const listeners = this._listeners.get(channel)
    if (!listeners) return
    listeners.delete(listener)
    if (listeners.size === 0) {
      this._listeners.delete(channel)
      Promise.resolve(client.unsubscribe(channel)).catch(() => {})
    }
  }

  async subscribe(channel, listener) {
    const client = this._getClient()
    let listeners = this._listeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this._listeners.set(channel, listeners)
    }
    listeners.add(listener)

    try {
      if (listeners.size === 1) {
        const pending = Promise.resolve(client.subscribe(channel))
        this._pending.set(channel, pending)
        try {
          await pending
        } finally {
          if (this._pending.get(channel) === pending) {
            this._pending.delete(channel)
          }
        }
      } else if (this._pending.has(channel)) {
        // A second stream joined while the first SUBSCRIBE is still in flight.
        await this._pending.get(channel)
      }
    } catch (err) {
      this._remove(channel, listener, client)
      throw err
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this._remove(channel, listener, client)
    }
  }
}

export default new AiAssistRunSubscriber()
