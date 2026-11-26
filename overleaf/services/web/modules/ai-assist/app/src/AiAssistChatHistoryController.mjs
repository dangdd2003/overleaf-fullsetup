import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultStore, {
  ChatQuotaError,
  MAX_CHATS_PER_USER,
  compactEntriesProblem,
  isValidChatCursor,
  isValidChatId,
} from './AiAssistChatHistoryStore.mjs'
import {
  createProviderClient,
  normalizeProviderBaseUrl,
  validateSafeProviderBaseUrl,
} from './AiAssistProviders.mjs'
import { OBJECT_ID } from './AiAssistCheckpointStore.mjs'
import { generateChatTitle } from './AiAssistChatTitler.mjs'
import defaultUserSettingsStore, {
  MASKED_SECRET,
  applyStoredProviderSecret,
  stripMaskedProviderSecret,
} from './AiAssistUserSettingsStore.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

const ALLOWED_STATS_KEYS = [
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedTokens',
  'reasoningTokens',
  'toolCalls',
]

function sanitizeStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out = {}
  for (const key of ALLOWED_STATS_KEYS) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) {
      out[key] = raw[key]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export class AiAssistChatHistoryController {
  constructor({
    store = defaultStore,
    clientFactory = createProviderClient,
    userSettingsStore = defaultUserSettingsStore,
  } = {}) {
    this.store = store
    this.clientFactory = clientFactory
    this.userSettingsStore = userSettingsStore
  }

  #ids(req, res) {
    const projectId = req.params.Project_id
    const userId = String(SessionManager.getLoggedInUserId(req.session) || '')
    const chatId = req.params.chatId
    // The ids name the storage directory, so they must be exactly what the
    // store writes under: an ObjectId hex each
    if (!OBJECT_ID.test(String(projectId)) || !OBJECT_ID.test(userId)) {
      res.status(400).json({ error: 'Invalid project or user id' })
      return null
    }
    if (chatId !== undefined && !isValidChatId(chatId)) {
      res.status(400).json({ error: 'Invalid chat id' })
      return null
    }
    return { projectId, userId, chatId }
  }

  list = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const cursor = req.query?.cursor
    const rawLimit = req.query?.limit
    if (cursor !== undefined && !isValidChatCursor(cursor)) {
      return res.status(400).json({ error: 'Invalid cursor' })
    }
    const limit = rawLimit === undefined ? undefined : Number(rawLimit)
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_CHATS_PER_USER)
    ) {
      return res.status(400).json({ error: 'Invalid limit' })
    }
    try {
      // Without a cursor or limit the answer is every chat, as before; the
      // nextCursor field is only there for a client that pages
      const page = this.store.listChatPage
        ? await this.store.listChatPage(ids.projectId, ids.userId, {
            cursor,
            limit,
          })
        : {
            chats: await this.store.listChats(ids.projectId, ids.userId),
            nextCursor: null,
          }
      res.json({ chats: page.chats, nextCursor: page.nextCursor ?? null })
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] list chats failed'
      )
      res.status(500).json({ error: 'Failed to list chats' })
    }
  }

  get = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    try {
      const chat = await this.store.getChat(
        ids.projectId,
        ids.userId,
        ids.chatId
      )
      if (!chat) return res.status(404).json({ error: 'Chat not found' })
      res.json(chat)
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] get chat failed'
      )
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
    const stats = sanitizeStats(req.body?.stats)
    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: 'transcript must be an array' })
    }
    const compactProblem = compactEntriesProblem(transcript)
    if (compactProblem) {
      return res.status(400).json({ error: compactProblem })
    }
    const maxBytes = Settings.aiAssist?.maxTranscriptBytes ?? 32 * 1024 * 1024
    if (Buffer.byteLength(JSON.stringify(transcript)) > maxBytes) {
      return res
        .status(413)
        .json({ error: 'Conversation is too large to save' })
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
          titleGenerated,
          stats
        )
      )
    } catch (err) {
      if (err instanceof ChatQuotaError) {
        // The same refusal as an oversized save: the panel keeps the chat locally
        return res.status(413).json({ error: 'Chat history is full' })
      }
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] save chat failed'
      )
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
      if (!summary) return res.status(404).json({ error: 'Chat not found' })
      res.json(summary)
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] rename chat failed'
      )
      res.status(500).json({ error: 'Failed to rename chat' })
    }
  }

  generateTitle = async (req, res) => {
    const ids = this.#ids(req, res)
    if (!ids) return
    const { prompt } = req.body || {}
    let providerSettings = req.body?.providerSettings
    const needsStored =
      !providerSettings ||
      typeof providerSettings !== 'object' ||
      !providerSettings.type ||
      !providerSettings.apiKey ||
      providerSettings.apiKey === MASKED_SECRET
    if (ids.userId && needsStored) {
      try {
        const internal = await this.userSettingsStore.getInternalUserSettings(
          ids.userId
        )
        const requestedSlot = req.body?.slot || providerSettings?.slot
        const slot =
          requestedSlot === 'fastProvider' ? 'fastProvider' : 'provider'
        const fallbackSlots = requestedSlot
          ? []
          : [slot === 'provider' ? 'fastProvider' : 'provider']
        providerSettings = applyStoredProviderSecret(providerSettings, internal, {
          slot,
          fallbackSlots,
        })
      } catch {}
    }
    providerSettings = stripMaskedProviderSecret(providerSettings)
    if (
      !providerSettings ||
      typeof providerSettings !== 'object' ||
      !providerSettings.type
    ) {
      return res.status(400).json({ error: 'Missing providerSettings' })
    }
    const rawBaseUrl = providerSettings.baseUrl || providerSettings.baseURL
    if (rawBaseUrl) {
      try {
        const baseUrl = normalizeProviderBaseUrl(providerSettings.type, rawBaseUrl)
        if (baseUrl) {
          validateSafeProviderBaseUrl(baseUrl)
          providerSettings = { ...providerSettings, baseUrl }
        }
      } catch (err) {
        return res.status(400).json({ error: err.message })
      }
    }
    try {
      // A title is a few words; it runs at the provider's default effort
      const { baseURL: _omitBaseURL, ...restSettings } = providerSettings
      const rawBaseUrl = providerSettings.baseUrl || providerSettings.baseURL
      const client = this.clientFactory({
        ...restSettings,
        ...(rawBaseUrl ? { baseUrl: rawBaseUrl } : {}),
        reasoningEffort: undefined,
        thinking: undefined,
      })
      const title = await generateChatTitle({
        client,
        firstMessageText: typeof prompt === 'string' ? prompt : '',
      })
      if (title && ids.chatId) {
        await this.store.saveChatTitle(
          ids.projectId,
          ids.userId,
          ids.chatId,
          title
        )
      }
      res.json({ title })
    } catch (err) {
      if (
        err?.status === 400 ||
        err?.code === 'invalidProviderUrl' ||
        err?.code === 'restrictedProviderUrl' ||
        err?.code === 'invalidProviderSettings'
      ) {
        return res.status(400).json({ error: err.message })
      }
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
      logger.error(
        { err, projectId: ids.projectId },
        '[AiAssist] delete chat failed'
      )
      res.status(500).json({ error: 'Failed to delete chat' })
    }
  }
}

export default new AiAssistChatHistoryController()
