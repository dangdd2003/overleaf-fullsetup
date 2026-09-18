import RedisWrapper from '../../../../app/src/infrastructure/RedisWrapper.mjs'

const CHANNEL = 'ai-assist:run:control'

export class AiAssistRunControl {
  constructor({ clientFactory = () => RedisWrapper.client('ai-assist') } = {}) {
    this.clientFactory = clientFactory
    this._sub = null
    this._pub = null
  }

  async publish(runId, command) {
    if (!this._pub) this._pub = this.clientFactory()
    // runId only. Provider settings and the API key never leave the process.
    await this._pub.publish(CHANNEL, JSON.stringify({ runId, ...command }))
  }

  async start({ onCommand }) {
    this._sub = this.clientFactory()
    const handler = (_channel, message) => {
      let parsed
      try {
        parsed = JSON.parse(message)
      } catch {
        return
      }
      if (!parsed?.runId) return
      onCommand(parsed)
    }
    this._sub.on('message', handler)
    await this._sub.subscribe(CHANNEL)
    return () => {
      try {
        this._sub.unsubscribe(CHANNEL)
        this._sub.removeListener('message', handler)
      } catch {}
    }
  }
}

export default new AiAssistRunControl()
