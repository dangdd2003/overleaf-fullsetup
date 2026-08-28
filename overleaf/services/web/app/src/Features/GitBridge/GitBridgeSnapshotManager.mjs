import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import UserGetter from '../User/UserGetter.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../Editor/EditorController.mjs'
import GitBridgeFileTokenManager from './GitBridgeFileTokenManager.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { fetchJson, fetchNothing } from '@overleaf/fetch-utils'
import { db, ObjectId } from '../../infrastructure/mongodb.mjs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

async function _getProject(projectId, projection) {
  const fn =
    ProjectGetter.promises?.getProjectWithoutLock ||
    ProjectGetter.getProjectWithoutLock
  if (typeof fn === 'function') {
    return await fn(projectId, projection)
  }
  return null
}

async function _getUser(userId, projection) {
  if (UserGetter.promises?.getUser) {
    return await UserGetter.promises.getUser(userId, projection)
  }
  if (typeof UserGetter.getUser === 'function') {
    return await new Promise(resolve => {
      UserGetter.getUser(userId, projection, (err, user) => {
        if (err) resolve(null)
        else resolve(user)
      })
    })
  }
  return null
}

const GitBridgeSnapshotManager = {
  async getDoc(projectId) {
    try {
      if (DocumentUpdaterHandler?.promises?.flushProjectToMongo) {
        await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
      } else if (
        typeof DocumentUpdaterHandler?.flushProjectToMongo === 'function'
      ) {
        await new Promise(resolve => {
          DocumentUpdaterHandler.flushProjectToMongo(projectId, () => resolve())
        })
      }
    } catch (err) {
      logger.debug({ err, projectId }, 'failed to flush project before getDoc')
    }

    const project = await _getProject(projectId, {
      _id: 1,
      version: 1,
      lastUpdatedAt: 1,
      owner_ref: 1,
    })
    if (!project) return null

    let historyVersion = null
    if (Settings.apis?.project_history?.url) {
      try {
        const historyData = await fetchJson(
          `${Settings.apis.project_history.url}/project/${projectId}/version`,
          { signal: AbortSignal.timeout(5000) }
        )
        if (typeof historyData?.version === 'number') {
          historyVersion = historyData.version
        }
      } catch (err) {
        logger.debug(
          { err, projectId },
          'could not get version from project-history'
        )
      }
    }

    let docVersionsSum = 0
    try {
      let docVersions = []
      if (DocstoreManager.promises?.getAllDocVersions) {
        docVersions =
          await DocstoreManager.promises.getAllDocVersions(projectId)
      } else if (typeof DocstoreManager.getAllDocVersions === 'function') {
        docVersions = await new Promise((resolve, reject) => {
          DocstoreManager.getAllDocVersions(projectId, (err, docs) =>
            err ? reject(err) : resolve(docs)
          )
        })
      }
      if (Array.isArray(docVersions)) {
        for (const doc of docVersions) {
          if (typeof doc?.version === 'number') {
            docVersionsSum += doc.version
          }
        }
      }
    } catch (err) {
      logger.debug(
        { err, projectId },
        'could not get doc versions from docstore'
      )
    }

    const baseProjectVersion = project.version || 0
    const docstoreVersion = baseProjectVersion + docVersionsSum
    const latestVerId = Math.max(
      historyVersion || 0,
      docstoreVersion,
      baseProjectVersion
    )

    let authorEmail = 'git@overleaf.com'
    let authorName = 'Overleaf User'

    if (project.owner_ref) {
      let user = project.owner_ref
      if (
        typeof user === 'string' ||
        (user && !user.email && !user.first_name)
      ) {
        try {
          const fetchedUser = await _getUser(project.owner_ref, {
            email: 1,
            first_name: 1,
            last_name: 1,
            name: 1,
          })
          if (fetchedUser) {
            user = fetchedUser
          }
        } catch (err) {
          logger.warn({ err, projectId }, 'failed to fetch project owner user')
        }
      }
      if (user && user.email) {
        authorEmail = user.email
      }
      const fullName =
        `${user?.first_name || ''} ${user?.last_name || ''}`.trim() ||
        user?.name
      if (fullName) {
        authorName = fullName
      }
    }

    return {
      latestVerId,
      latestVerAt: project.lastUpdatedAt
        ? new Date(project.lastUpdatedAt).toISOString()
        : new Date().toISOString(),
      latestVerBy: {
        email: authorEmail,
        name: authorName,
      },
    }
  },

  async getSavedVers(projectId) {
    const docInfo = await this.getDoc(projectId)
    if (!docInfo) return []

    const savedVers = []
    const seenVersionIds = new Set()

    try {
      if (db.projectHistoryLabels?.find && ObjectId.isValid(projectId)) {
        const labels = await db.projectHistoryLabels
          .find({ project_id: new ObjectId(projectId) })
          .sort({ version: 1, created_at: 1 })
          .toArray()

        for (const label of labels || []) {
          const verId =
            typeof label.version === 'number'
              ? label.version
              : parseInt(label.version, 10)
          if (isNaN(verId)) continue

          let labelAuthorEmail = docInfo.latestVerBy.email
          let labelAuthorName = docInfo.latestVerBy.name

          if (label.user_id) {
            try {
              const labelUser = await _getUser(label.user_id, {
                email: 1,
                first_name: 1,
                last_name: 1,
                name: 1,
              })
              if (labelUser?.email) {
                labelAuthorEmail = labelUser.email
              }
              const fullName =
                `${labelUser?.first_name || ''} ${labelUser?.last_name || ''}`.trim() ||
                labelUser?.name
              if (fullName) {
                labelAuthorName = fullName
              }
            } catch (err) {
              logger.debug(
                { err, labelUserId: label.user_id },
                'failed to fetch label user'
              )
            }
          }

          seenVersionIds.add(verId)
          savedVers.push({
            versionId: verId,
            comment: label.comment || `Version ${verId}`,
            user: {
              email: labelAuthorEmail,
              name: labelAuthorName,
            },
            createdAt: label.created_at
              ? new Date(label.created_at).toISOString()
              : new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      logger.warn(
        { err, projectId },
        'failed to fetch projectHistoryLabels for getSavedVers'
      )
    }

    if (!seenVersionIds.has(docInfo.latestVerId)) {
      savedVers.push({
        versionId: docInfo.latestVerId,
        comment: 'Current version',
        user: docInfo.latestVerBy,
        createdAt: docInfo.latestVerAt,
      })
    }

    return savedVers
  },

  async getSnapshotForVersion(projectId, versionId) {
    const docInfo = await this.getDoc(projectId)
    if (!docInfo) return null

    try {
      if (DocumentUpdaterHandler?.promises?.flushProjectToMongo) {
        await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
      } else if (
        typeof DocumentUpdaterHandler?.flushProjectToMongo === 'function'
      ) {
        await new Promise(resolve => {
          DocumentUpdaterHandler.flushProjectToMongo(projectId, () => resolve())
        })
      }
    } catch (err) {
      logger.debug(
        { err, projectId },
        'failed to flush project before getSnapshotForVersion'
      )
    }

    const project = await _getProject(projectId, {
      _id: 1,
      version: 1,
      rootFolder: 1,
    })
    if (!project) return null

    const srcs = []
    const atts = []
    const baseUrl =
      process.env.GIT_BRIDGE_INTERNAL_URL ||
      Settings.apis?.web?.url ||
      `http://${Settings.internalHost || (process.env.NODE_ENV === 'development' ? 'web' : '127.0.0.1')}:${Settings.port || 3000}`

    // Fetch all docs in batch to avoid N+1 queries
    let allDocsMap = {}
    try {
      const getAllDocsFn =
        DocstoreManager.promises?.getAllDocs || DocstoreManager.getAllDocs
      if (typeof getAllDocsFn === 'function') {
        const batchDocs = await getAllDocsFn(projectId)
        if (Array.isArray(batchDocs)) {
          for (const doc of batchDocs) {
            if (doc?._id) {
              allDocsMap[doc._id.toString()] = doc
            }
          }
        } else if (batchDocs && typeof batchDocs === 'object') {
          allDocsMap = batchDocs
        }
      }
    } catch (err) {
      logger.warn(
        { err, projectId },
        'error fetching batch docs from docstore, falling back to individual'
      )
    }

    async function traverseFolder(folder, currentPath = '') {
      for (const doc of folder.docs || []) {
        if (!doc?._id) continue
        const filePath = currentPath ? `${currentPath}/${doc.name}` : doc.name
        let content = ''
        const docIdStr = doc._id.toString()

        if (allDocsMap[docIdStr] !== undefined) {
          const docData = allDocsMap[docIdStr]
          const lines = docData?.lines !== undefined ? docData.lines : docData
          content = Array.isArray(lines) ? lines.join('\n') : lines || ''
        } else {
          try {
            let lines
            if (DocstoreManager.promises?.getDoc) {
              const docData = await DocstoreManager.promises.getDoc(
                projectId,
                docIdStr
              )
              lines = docData?.lines !== undefined ? docData.lines : docData
            } else {
              const docData = await new Promise((resolve, reject) => {
                DocstoreManager.getDoc(projectId, docIdStr, (err, doc) =>
                  err ? reject(err) : resolve(doc)
                )
              })
              lines = docData?.lines !== undefined ? docData.lines : docData
            }
            content = Array.isArray(lines) ? lines.join('\n') : lines || ''
          } catch (err) {
            logger.warn(
              { err, projectId, docId: doc._id },
              'error getting doc lines from docstore'
            )
          }
        }
        srcs.push([content, filePath])
      }
      for (const file of folder.fileRefs || []) {
        if (!file?._id) continue
        const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
        // Git Bridge binary file endpoint. git-bridge fetches this URL itself
        // with an unauthenticated GET, so the URL carries a short-lived token
        // scoped to this project + file. The parameter must be named `token`
        // for git-bridge's resource cache to strip it from its cache keys.
        const fileId = file._id.toString()
        const token = GitBridgeFileTokenManager.createFileToken(
          projectId.toString(),
          fileId
        )
        let fileUrl = `${baseUrl}/api/v0/docs/${projectId}/file/${fileId}`
        if (token) {
          fileUrl += `?token=${encodeURIComponent(token)}`
        }
        atts.push([fileUrl, filePath])
      }
      for (const subFolder of folder.folders || []) {
        const subPath = currentPath
          ? `${currentPath}/${subFolder.name}`
          : subFolder.name
        await traverseFolder(subFolder, subPath)
      }
    }

    if (project.rootFolder && project.rootFolder[0]) {
      await traverseFolder(project.rootFolder[0])
    }

    return { srcs, atts }
  },

  async validatePushVersion(projectId, latestVerId) {
    const docInfo = await this.getDoc(projectId)
    if (!docInfo) {
      return { valid: false, code: 'invalidProject' }
    }
    const currentVer = docInfo.latestVerId
    if (
      latestVerId !== undefined &&
      latestVerId !== null &&
      currentVer !== latestVerId
    ) {
      return { valid: false, code: 'outOfDate' }
    }
    return { valid: true }
  },

  async processPush(projectId, user, files, postbackUrl) {
    const userId = typeof user === 'object' && user !== null ? user._id : user
    logger.info(
      { projectId, userId, fileCount: files?.length },
      'processing git-bridge push'
    )
    const source = 'git-bridge'
    const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'git-push-'))

    try {
      // Collect incoming file paths
      const incomingFilePaths = new Set()
      for (const file of files || []) {
        const rawPath = file.name || file.path || ''
        if (!rawPath) continue
        const filePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        incomingFilePaths.add(filePath)
      }

      // 1. Process added or modified files (files with URL) — downloads occur first
      for (const file of files || []) {
        const rawPath = file.name || file.path || ''
        if (!rawPath || !file.url) continue
        const filePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        const relativePath = filePath.replace(/^\/+/, '')

        // Download updated file content from git-bridge raw URL
        const response = await fetch(file.url)
        if (!response.ok) {
          throw new Error(`Failed to fetch file from git-bridge: ${file.url}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())

        // Avoid flat temp file collisions by preserving relative paths in temp dir
        const localTmpFile = path.join(tmpDir, relativePath)
        const resolvedTmp = path.resolve(localTmpFile)
        if (!resolvedTmp.startsWith(path.resolve(tmpDir) + path.sep)) {
          logger.warn(
            { projectId, relativePath },
            'path traversal rejected in git push'
          )
          continue
        }
        await fsPromises.mkdir(path.dirname(localTmpFile), { recursive: true })
        await fsPromises.writeFile(localTmpFile, buffer)

        const ext = path.extname(filePath).slice(1).toLowerCase()
        const textExtensions = Settings.textExtensions || [
          'tex',
          'latex',
          'sty',
          'cls',
          'bst',
          'bib',
          'bibtex',
          'txt',
          'tikz',
          'mtx',
          'rtex',
          'md',
          'asy',
          'dtx',
          'ins',
          'csv',
        ]
        const baseName = path.basename(filePath).toLowerCase()
        const isKnownTextFile = [
          'makefile',
          'dockerfile',
          'licence',
          'license',
          'readme',
          '.gitignore',
          '.latexmkrc',
          'latexmkrc',
        ].includes(baseName)
        const isText =
          textExtensions.includes(ext) ||
          isKnownTextFile ||
          (!ext && !baseName.includes('.'))

        if (isText) {
          const content = buffer.toString('utf8')
          const lines = content.split(/\r\n|\n|\r/)
          if (EditorController.promises?.upsertDocWithPath) {
            await EditorController.promises.upsertDocWithPath(
              projectId,
              filePath,
              lines,
              source,
              userId
            )
          } else if (typeof EditorController.upsertDocWithPath === 'function') {
            await new Promise((resolve, reject) => {
              EditorController.upsertDocWithPath(
                projectId,
                filePath,
                lines,
                source,
                userId,
                (err, res) => (err ? reject(err) : resolve(res))
              )
            })
          }
        } else {
          if (EditorController.promises?.upsertFileWithPath) {
            await EditorController.promises.upsertFileWithPath(
              projectId,
              filePath,
              localTmpFile,
              null,
              source,
              userId
            )
          } else if (
            typeof EditorController.upsertFileWithPath === 'function'
          ) {
            await new Promise((resolve, reject) => {
              EditorController.upsertFileWithPath(
                projectId,
                filePath,
                localTmpFile,
                null,
                source,
                userId,
                (err, res) => (err ? reject(err) : resolve(res))
              )
            })
          }
        }
      }

      // 2. Fetch authoritative entity list from project document
      const existingPaths = []
      try {
        const entities =
          await ProjectEntityHandler.promises.getAllEntities(projectId)
        for (const { path: docPath } of entities.docs || []) {
          const fp = docPath.startsWith('/') ? docPath : `/${docPath}`
          existingPaths.push(fp)
        }
        for (const { path: filePath } of entities.files || []) {
          const fp = filePath.startsWith('/') ? filePath : `/${filePath}`
          existingPaths.push(fp)
        }
        for (const { path: folderPath } of entities.folders || []) {
          const fp = folderPath.startsWith('/') ? folderPath : `/${folderPath}`
          existingPaths.push(fp)
        }
      } catch (err) {
        logger.warn(
          { err, projectId },
          'could not fetch project entities for deletion comparison'
        )
      }

      // 3. Delete files/folders removed from git (deeper paths first)
      existingPaths.sort((a, b) => b.length - a.length)
      for (const existingPath of existingPaths) {
        if (!incomingFilePaths.has(existingPath)) {
          if (EditorController.promises?.deleteEntityWithPath) {
            await EditorController.promises
              .deleteEntityWithPath(projectId, existingPath, source, userId)
              .catch(err => {
                logger.warn(
                  { err, projectId, existingPath },
                  'failed to delete entity removed in git'
                )
              })
          } else if (
            typeof EditorController.deleteEntityWithPath === 'function'
          ) {
            await new Promise(resolve => {
              EditorController.deleteEntityWithPath(
                projectId,
                existingPath,
                source,
                userId,
                err => {
                  if (err) {
                    logger.warn(
                      { err, projectId, existingPath },
                      'failed to delete entity removed in git'
                    )
                  }
                  resolve()
                }
              )
            })
          }
        }
      }

      const docInfo = await this.getDoc(projectId)
      const newVersion = docInfo?.latestVerId || 0

      if (postbackUrl) {
        logger.info(
          { postbackUrl, newVersion },
          'sending postback to git-bridge'
        )
        await fetchNothing(postbackUrl, {
          method: 'POST',
          json: {
            code: 'upToDate',
            latestVerId: newVersion,
          },
        })
      }
    } catch (err) {
      logger.error({ err, projectId, postbackUrl }, 'error processing git push')
      if (postbackUrl) {
        try {
          await fetchNothing(postbackUrl, {
            method: 'POST',
            json: {
              code: 'error',
              message: err.message,
            },
          })
        } catch (postbackErr) {
          logger.error(
            { postbackErr },
            'failed to send error postback to git-bridge'
          )
        }
      }
      throw err
    } finally {
      await fsPromises
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => {})
    }
  },
}

export default GitBridgeSnapshotManager
