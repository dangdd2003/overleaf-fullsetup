import logger from '@overleaf/logger'
import defaultStore from './AiAssistPreferencesStore.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistPreferencesController {
  constructor({ store = defaultStore } = {}) {
    this.store = store
  }

  get = async (req, res) => {
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    try {
      res.json({ preferences: await this.store.get(userId) })
    } catch (err) {
      logger.error({ err, userId }, '[AiAssist] read preferences failed')
      res.status(500).json({ error: 'Failed to read preferences' })
    }
  }

  save = async (req, res) => {
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    try {
      const preferences = await this.store.save(userId, req.body?.preferences)
      res.json({ preferences })
    } catch (err) {
      logger.error({ err, userId }, '[AiAssist] save preferences failed')
      res.status(500).json({ error: 'Failed to save preferences' })
    }
  }
}

export default new AiAssistPreferencesController()
