import logger from '@overleaf/logger'
import defaultStore from './AiAssistUserSettingsStore.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistUserSettingsController {
  constructor({ store = defaultStore } = {}) {
    this.store = store
  }

  get = async (req, res) => {
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    try {
      const settings = await this.store.getUserSettings(userId)
      res.json(settings)
    } catch (err) {
      logger.error({ err, userId }, '[AiAssist] read user settings failed')
      res.status(500).json({ error: 'Failed to read user settings' })
    }
  }

  save = async (req, res) => {
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    const { provider, fastProvider, webSearch } = req.body || {}
    try {
      const settings = await this.store.saveUserSettings(userId, {
        provider,
        fastProvider,
        webSearch,
      })
      res.json(settings)
    } catch (err) {
      logger.error({ err, userId }, '[AiAssist] save user settings failed')
      res.status(500).json({ error: 'Failed to save user settings' })
    }
  }
}

export default new AiAssistUserSettingsController()
