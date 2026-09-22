import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultStore, { isValidChatId } from './AiAssistChatHistoryStore.mjs'
import { createProviderClient } from './AiAssistProviders.mjs'
import { generateChatTitle } from './AiAssistChatTitler.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistChatHistoryController {
  constructor({
    store = defaultStore,
    clientFactory = createProviderClient,
  } = {}) {
    this.store = store
    this.clientFactory = clientFactory
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
    const title = req.body?.title
    const titleGenerated = req.body?.titleGenerated
    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: 'transcript must be an array' })
    }
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 5000000
    if (Buffer.byteLength(JSON.stringify(transcript)) > maxBytes) {
      return res.status(413).json({ error: 'Conversation is too large to save' })
    }
    try {
      res.json(
        await this.store.saveChat(
          ids.projectId,
          ids.userId,
          ids.chatId,
          transcript,
          mode,
          title,
          titleGenerated
        )
      )
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] save chat failed')
      res.status(500).json({ error: 'Failed to save chat' })
    }
  }

  rename = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const title = req.body?.title
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title must be a non-empty string' })
    }
    try {
      const summary = await this.store.saveChatTitle(
        ids.projectId,
        ids.userId,
        ids.chatId,
        title
      )
      res.json(summary)
    } catch (err) {
      logger.error({ err, projectId: ids.projectId }, '[AiAssist] rename chat failed')
      res.status(500).json({ error: 'Failed to rename chat' })
    }
  }

  generateTitle = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const { providerSettings, prompt, assistantReply } = req.body || {}
    if (!providerSettings) {
      return res.status(400).json({ error: 'Missing providerSettings' })
    }
    try {
      const client = this.clientFactory(providerSettings)
      const title = await generateChatTitle({
        client,
        firstMessageText: prompt || '',
        assistantReplyText: assistantReply || '',
      })
      if (title && ids.chatId) {
        await this.store.saveChatTitle(ids.projectId, ids.userId, ids.chatId, title)
      }
      res.json({ title })
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] generate chat title failed'
      )
      res.status(500).json({ error: 'Failed to generate title' })
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
