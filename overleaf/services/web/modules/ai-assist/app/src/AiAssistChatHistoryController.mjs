import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultStore, { isValidChatId } from './AiAssistChatHistoryStore.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistChatHistoryController {
  constructor({ store = defaultStore } = {}) {
    this.store = store
  }

  #ids(req, res) {
    const projectId = req.params.Project_id
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    const chatId = req.params.chatId
    if (chatId !== undefined && !isValidChatId(chatId)) {
      res.status(400).json({ error: 'Invalid chat id' })
      return null
    }
    return { projectId, userId, chatId }
  }

  list = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    try {
      res.json({ chats: await this.store.listChats(ids.projectId, ids.userId) })
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] list chats failed')
      res.status(500).json({ error: 'Failed to list chats' })
    }
  }

  get = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    try {
      const chat = await this.store.getChat(ids.projectId, ids.userId, ids.chatId)
      if (!chat) return res.status(404).json({ error: 'Chat not found' })
      res.json(chat)
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] get chat failed')
      res.status(500).json({ error: 'Failed to load chat' })
    }
  }

  save = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const transcript = req.body?.transcript
    const mode = req.body?.mode
    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: 'transcript must be an array' })
    }
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 5000000
    if (Buffer.byteLength(JSON.stringify(transcript)) > maxBytes) {
      return res.status(413).json({ error: 'Conversation is too large to save' })
    }
    try {
      res.json(
        await this.store.saveChat(ids.projectId, ids.userId, ids.chatId, transcript, mode)
      )
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] save chat failed')
      res.status(500).json({ error: 'Failed to save chat' })
    }
  }

  delete = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    try {
      await this.store.deleteChat(ids.projectId, ids.userId, ids.chatId)
      res.sendStatus(204)
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] delete chat failed')
      res.status(500).json({ error: 'Failed to delete chat' })
    }
  }
}

export default new AiAssistChatHistoryController()
