import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import defaultCheckpointStore, {
  isValidChatId,
  isValidUserMessageId,
} from './AiAssistCheckpointStore.mjs'
import defaultChatHistoryStore from './AiAssistChatHistoryStore.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

export class AiAssistCheckpointController {
  constructor({
    checkpointStore = defaultCheckpointStore,
    chatHistoryStore = defaultChatHistoryStore,
    docUpdater = DocumentUpdaterHandler.promises,
    entityHandler = ProjectEntityHandler.promises,
    editorController = EditorController,
  } = {}) {
    this.checkpointStore = checkpointStore
    this.chatHistoryStore = chatHistoryStore
    this.docUpdater = docUpdater
    this.entityHandler = entityHandler
    this.editorController = editorController
  }

  #checkEnabled(res) {
    if (!Settings.aiAssist?.enabled) {
      res.status(403).json({ error: 'AI Assist is disabled' })
      return false
    }
    return true
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

  #userMessageIds(req) {
    const ids = req.body?.userMessageIds
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
      return undefined
    }
    return ids
  }

  async #fetchCurrentFiles(projectId, checkpointFiles) {
    const currentFiles = {}
    // The project's docs are read at most once, and only if a file needs them
    let allDocs = null
    for (const [filePath, fileInfo] of Object.entries(checkpointFiles || {})) {
      const normalizedPath = filePath.replace(/^\//, '')
      let docId = fileInfo.docId

      if (!docId && this.entityHandler?.getDocIdByPath) {
        try {
          docId = await this.entityHandler.getDocIdByPath(
            projectId,
            normalizedPath
          )
        } catch {}
      }

      let content = null
      if (docId && this.docUpdater?.getDocument) {
        try {
          const doc = await this.docUpdater.getDocument(projectId, docId, -1)
          if (doc?.lines) {
            content = doc.lines.join('\n')
          }
        } catch {}
      }

      if (content === null && this.entityHandler?.getAllDocs) {
        try {
          allDocs ??= this.entityHandler.getAllDocs(projectId)
          // getAllDocs returns docs keyed by '/path'
          const doc = (await allDocs)?.[`/${normalizedPath}`]
          if (doc) {
            content = (doc.lines || []).join('\n')
          }
        } catch {}
      }

      currentFiles[filePath] = content
    }
    return currentFiles
  }

  // The stored docId if the doc still exists, else the doc at the path, else null.
  async #resolveDocId(projectId, normalizedPath, storedDocId) {
    if (storedDocId) {
      if (!this.entityHandler?.getDocPathByProjectIdAndDocId) {
        return storedDocId
      }
      try {
        await this.entityHandler.getDocPathByProjectIdAndDocId(
          projectId,
          storedDocId
        )
        return storedDocId
      } catch {}
    }

    if (this.entityHandler?.getDocIdByPath) {
      try {
        return (
          (await this.entityHandler.getDocIdByPath(
            projectId,
            normalizedPath
          )) || null
        )
      } catch {}
    }
    return null
  }

  async #restoreFile(ids, filePath, fileInfo, restoredFiles) {
    const normalizedPath = filePath.replace(/^\//, '')
    const docId = await this.#resolveDocId(
      ids.projectId,
      normalizedPath,
      fileInfo.docId
    )

    if (fileInfo.isNew) {
      let deleted = false
      if (docId) {
        if (this.editorController?.promises?.deleteEntity) {
          await this.editorController.promises.deleteEntity(
            ids.projectId,
            docId,
            'doc',
            'ai-assist',
            ids.userId
          )
          deleted = true
        }
      }
      if (
        !deleted &&
        this.editorController?.promises?.deleteEntityWithPath
      ) {
        try {
          await this.editorController.promises.deleteEntityWithPath(
            ids.projectId,
            normalizedPath,
            'ai-assist',
            ids.userId
          )
        } catch {}
      }
      restoredFiles.push(filePath)
      return
    }

    const lines = (fileInfo.originalContent ?? '').split('\n')
    if (docId && this.docUpdater?.setDocument) {
      await this.docUpdater.setDocument(
        ids.projectId,
        docId,
        ids.userId,
        lines,
        'ai-assist'
      )
    } else if (this.editorController?.promises?.upsertDocWithPath) {
      // The doc was deleted after the checkpoint: recreate it at its path.
      await this.editorController.promises.upsertDocWithPath(
        ids.projectId,
        normalizedPath,
        lines,
        'ai-assist',
        ids.userId
      )
    } else {
      throw new Error('document no longer exists')
    }
    restoredFiles.push(filePath)
  }

  check = async (req, res) => {
    if (!this.#checkEnabled(res)) return
    const ids = this.#ids(req, res)
    if (!ids) return

    const userMessageId = req.body?.userMessageId
    if (!isValidUserMessageId(userMessageId)) {
      return res.status(400).json({ error: 'Invalid or missing userMessageId' })
    }
    const userMessageIds = this.#userMessageIds(req)

    try {
      const checkpoint = await this.checkpointStore.getRewindCheckpoint(
        ids.projectId,
        ids.userId,
        ids.chatId,
        userMessageId,
        { userMessageIds }
      )

      if (!checkpoint) {
        return res.json({
          canRewind: false,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
        })
      }

      let currentFiles = req.body?.currentFiles
      if (!currentFiles || typeof currentFiles !== 'object') {
        currentFiles = await this.#fetchCurrentFiles(
          ids.projectId,
          checkpoint.files
        )
      }

      const result = await this.checkpointStore.checkRewind(
        ids.projectId,
        ids.userId,
        ids.chatId,
        userMessageId,
        currentFiles,
        { userMessageIds, checkpoint }
      )

      res.json(result)
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId, chatId: ids.chatId, userMessageId },
        '[AiAssist] check rewind failed'
      )
      res.status(500).json({ error: 'Failed to check rewind' })
    }
  }

  rewind = async (req, res) => {
    if (!this.#checkEnabled(res)) return
    const ids = this.#ids(req, res)
    if (!ids) return

    const userMessageId = req.body?.userMessageId
    if (!isValidUserMessageId(userMessageId)) {
      return res.status(400).json({ error: 'Invalid or missing userMessageId' })
    }

    const restoreCode = Boolean(req.body?.restoreCode)
    const restoreConversation = Boolean(req.body?.restoreConversation)
    const userMessageIds = this.#userMessageIds(req)

    try {
      const restoredFiles = []
      const failedFiles = []

      if (restoreCode) {
        const checkpoint = await this.checkpointStore.getRewindCheckpoint(
          ids.projectId,
          ids.userId,
          ids.chatId,
          userMessageId,
          { userMessageIds }
        )

        for (const filePath of Object.keys(checkpoint?.files || {})) {
          try {
            await this.#restoreFile(
              ids,
              filePath,
              checkpoint.files[filePath],
              restoredFiles
            )
          } catch (err) {
            logger.warn(
              {
                err,
                projectId: ids.projectId,
                chatId: ids.chatId,
                userMessageId,
                path: filePath,
              },
              '[AiAssist] failed to restore file during rewind'
            )
            failedFiles.push({
              path: filePath,
              error: err?.message || String(err),
            })
          }
        }

        if (failedFiles.length > 0 && restoredFiles.length === 0) {
          return res
            .status(500)
            .json({ error: 'Failed to rewind', failedFiles })
        }
      }

      let transcript = undefined
      if (restoreConversation) {
        const inclusive = req.body?.inclusive !== false
        const updatedChat = await this.chatHistoryStore.truncateChat(
          ids.projectId,
          ids.userId,
          ids.chatId,
          userMessageId,
          { inclusive }
        )
        if (updatedChat && Array.isArray(updatedChat.transcript)) {
          transcript = updatedChat.transcript
        } else {
          transcript = []
        }
      }

      const response = {
        success: true,
        restoredFiles,
        failedFiles,
      }
      if (transcript !== undefined) {
        response.transcript = transcript
      }
      res.json(response)
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId, chatId: ids.chatId, userMessageId },
        '[AiAssist] rewind failed'
      )
      res.status(500).json({ error: 'Failed to rewind' })
    }
  }

  fork = async (req, res) => {
    if (!this.#checkEnabled(res)) return
    const ids = this.#ids(req, res)
    if (!ids) return

    const targetChatId = req.body?.targetChatId
    if (!isValidChatId(targetChatId)) {
      return res.status(400).json({ error: 'Invalid target chat id' })
    }
    const userMessageIds = req.body?.userMessageIds
    if (!Array.isArray(userMessageIds)) {
      return res.status(400).json({ error: 'userMessageIds must be an array' })
    }

    try {
      const copied = await this.checkpointStore.copyCheckpoints(
        ids.projectId,
        ids.userId,
        ids.chatId,
        targetChatId,
        userMessageIds
      )
      res.json({ copied })
    } catch (err) {
      logger.error(
        { err, projectId: ids.projectId, chatId: ids.chatId, targetChatId },
        '[AiAssist] fork checkpoints failed'
      )
      res.status(500).json({ error: 'Failed to fork checkpoints' })
    }
  }
}

export default new AiAssistCheckpointController()
