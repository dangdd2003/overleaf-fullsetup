import logger from '@overleaf/logger'
import defaultStore, {
  isValidKey,
  MAX_LOOKUP_KEYS,
  MAX_STORE_ENTRIES,
  normalizeEntry,
} from './AiAssistLanguageCheckStore.mjs'

/** Lookups and saves of a project's shared language-check results. */
export class AiAssistLanguageCheckController {
  constructor({ store = defaultStore } = {}) {
    this.store = store
  }

  lookup = async (req, res) => {
    const projectId = req.params.Project_id
    const keys = req.body?.keys
    if (!Array.isArray(keys) || keys.length > MAX_LOOKUP_KEYS || !keys.every(isValidKey)) {
      return res.status(400).json({ error: 'Invalid keys' })
    }
    try {
      res.json({ entries: await this.store.lookup(projectId, keys) })
    } catch (err) {
      logger.error({ err, projectId }, '[AiAssist] language check lookup failed')
      res.status(500).json({ error: 'Lookup failed' })
    }
  }

  save = async (req, res) => {
    const projectId = req.params.Project_id
    const raw = req.body?.entries
    if (!Array.isArray(raw) || raw.length > MAX_STORE_ENTRIES) {
      return res.status(400).json({ error: 'Invalid entries' })
    }
    const items = []
    for (const item of raw) {
      const entry = normalizeEntry(item?.entry)
      if (!isValidKey(item?.key) || !entry) {
        return res.status(400).json({ error: 'Invalid entries' })
      }
      items.push({ key: item.key, entry })
    }
    try {
      await this.store.store(projectId, items)
      res.sendStatus(204)
    } catch (err) {
      logger.error({ err, projectId }, '[AiAssist] language check store failed')
      res.status(500).json({ error: 'Store failed' })
    }
  }
}

export default new AiAssistLanguageCheckController()
