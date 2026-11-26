// The only place the agent tools reach into core (app/src/Features). Every
// project read is checked against AuthorizationManager for the user that
// started the tool call, every write, compile or settings change is checked
// again per call and written to the audit log.
//
// The calling user and project come from a per-call scope (AsyncLocalStorage),
// so the tool code keeps its plain `(projectId, ...)` calls. A call with no
// scope fails closed.
import { AsyncLocalStorage } from 'node:async_hooks'
import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectOptionsHandler from '../../../../app/src/Features/Project/ProjectOptionsHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import {
  inspectPdfPage,
  overviewPdfPages,
  searchPdfText,
  highlightSourceInPdf,
  PdfPageError,
  PDF_PAGE_ERRORS,
  REGIONS,
  resolveBlock,
} from '../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'
import {
  diffBuilds,
  rememberBuildPages,
} from '../../../../app/src/Features/PdfInspection/PdfVisualDiff.mjs'
import { inspectCompiledStyle } from '../../../../app/src/Features/PdfInspection/PdfStyleInspector.mjs'
import {
  buildFingerprint,
  digestContent,
  diffFingerprints,
} from '../../../../app/src/Features/PdfInspection/BuildFingerprint.mjs'

// A positive read check is reused for a tool run so a long run does not query
// Mongo on every call. Writes are never cached.
const READ_CACHE_TTL_MS = 30_000

const scopeStore = new AsyncLocalStorage()

// Positive read checks, keyed by user and project, shared by the calls of a run.
const readOkUntil = new Map()
const MAX_READ_CACHE_ENTRIES = 1000
function rememberReadOk(key) {
  if (readOkUntil.size >= MAX_READ_CACHE_ENTRIES) readOkUntil.clear()
  readOkUntil.set(key, Date.now() + READ_CACHE_TTL_MS)
}

/** Runs fn with the project and user every gateway call in it is checked for. */
export function runInProjectScope({ projectId, userId, runId }, fn) {
  if (!projectId || !userId) {
    throw new Error('A tool call needs a project and a user')
  }
  return scopeStore.run(
    {
      projectId: String(projectId),
      userId: String(userId),
      runId: runId ?? null,
    },
    fn
  )
}

function currentScope() {
  const scope = scopeStore.getStore()
  if (!scope) throw new Error('AI tool call has no project scope')
  return scope
}

/**
 * Throws an Error with code 'accessRevoked' unless userId may do `level`
 * ('read' or 'write') on the project.
 */
export async function assertProjectAccess(projectId, userId, level) {
  let allowed
  if (level === 'read') {
    allowed = await AuthorizationManager.promises.canUserReadProject(
      userId,
      projectId,
      undefined
    )
  } else if (level === 'write') {
    allowed = await AuthorizationManager.promises.canUserWriteProjectContent(
      userId,
      projectId,
      undefined
    )
  } else {
    throw new Error(`Unknown access level: ${level}`)
  }
  if (!allowed) {
    const err = new Error(`Access to project ${projectId} was revoked`)
    err.code = 'accessRevoked'
    throw err
  }
}

async function checkRead(projectId) {
  const scope = currentScope()
  const pid = String(projectId ?? scope.projectId)
  if (pid !== scope.projectId) {
    const err = new Error('Tool call tried to reach another project')
    err.code = 'accessRevoked'
    throw err
  }
  const key = `${scope.userId}:${pid}`
  const until = readOkUntil.get(key)
  if (until && until > Date.now()) return
  await assertProjectAccess(pid, scope.userId, 'read')
  rememberReadOk(key)
}

/** Read check for the project in the current scope, for code that serves cached data. */
export function checkProjectRead() {
  return checkRead(currentScope().projectId)
}

async function checkWrite(projectId, op, target) {
  const scope = currentScope()
  const pid = String(projectId ?? scope.projectId)
  if (pid !== scope.projectId) {
    const err = new Error('Tool call tried to reach another project')
    err.code = 'accessRevoked'
    throw err
  }
  await assertProjectAccess(pid, scope.userId, 'write')
  logger.info(
    {
      runId: scope.runId ?? undefined,
      projectId: pid,
      userId: scope.userId,
      op,
      path: target ?? undefined,
    },
    'ai-assist project mutation'
  )
}

/** Wraps a core promise-returning function behind a read check. */
function read(fn) {
  return async (projectId, ...rest) => {
    await checkRead(projectId)
    return fn(projectId, ...rest)
  }
}

/** Wraps a core promise-returning function behind a write check and audit line. */
function write(op, fn, { targetIndex = -1 } = {}) {
  return async (projectId, ...rest) => {
    const target = targetIndex >= 0 ? rest[targetIndex] : undefined
    await checkWrite(projectId, op, target)
    return fn(projectId, ...rest)
  }
}

/** Callback-style core function as a promise (the callback is the last argument). */
function callbackAsPromise(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (err, result) => (err ? reject(err) : resolve(result)))
    })
}

// Document updater: the live text of the project's documents.
const docUpdater = {
  getDocument: read((projectId, docId, fromVersion) =>
    DocumentUpdaterHandler.promises.getDocument(projectId, docId, fromVersion)
  ),
  // Writes the live doc. `docId` is the audit target.
  setDocument: async (projectId, docId, userId, lines, source) => {
    await checkWrite(projectId, 'setDocument', docId)
    return DocumentUpdaterHandler.promises.setDocument(
      projectId,
      docId,
      userId,
      lines,
      source
    )
  },
  flushProjectToMongo: read(projectId =>
    DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  ),
}

const entityHandler = {
  getAllDocs: read(projectId => ProjectEntityHandler.promises.getAllDocs(projectId)),
  getAllFiles: read(projectId => ProjectEntityHandler.promises.getAllFiles(projectId)),
}

const projectGetter = {
  getProject: read((projectId, projection) =>
    ProjectGetter.promises.getProject(projectId, projection)
  ),
}

const editorPromises = {
  upsertDocWithPath: write(
    'upsertDocWithPath',
    (projectId, path, lines, source, userId) =>
      EditorController.promises.upsertDocWithPath(
        projectId,
        path,
        lines,
        source,
        userId
      ),
    { targetIndex: 0 }
  ),
  setCompiler: write('setCompiler', (projectId, compiler) =>
    EditorController.promises.setCompiler(projectId, compiler)
  ),
  setImageName: write('setImageName', (projectId, imageName) =>
    EditorController.promises.setImageName(projectId, imageName)
  ),
  setRootDoc: write('setRootDoc', (projectId, rootDocId) =>
    EditorController.promises.setRootDoc(projectId, rootDocId)
  ),
}

const editorController = {
  promises: editorPromises,
  // Callback style, as EditorController.addDoc is. Checked like the promise
  // wrappers.
  addDoc: (projectId, folderId, docName, docLines, source, userId, callback) => {
    checkWrite(projectId, 'addDoc', docName)
      .then(() =>
        callbackAsPromise(EditorController.addDoc)(
          projectId,
          folderId,
          docName,
          docLines,
          source,
          userId
        )
      )
      .then(
        doc => callback(null, doc),
        err => callback(err)
      )
  },
  setRootDoc: (projectId, rootDocId, callback) => {
    checkWrite(projectId, 'setRootDoc', rootDocId)
      .then(() => EditorController.promises.setRootDoc(projectId, rootDocId))
      .then(
        () => callback(null),
        err => callback(err)
      )
  },
}

const projectOptionsHandler = {
  setCompiler: write('setCompiler', (projectId, compiler) =>
    ProjectOptionsHandler.promises.setCompiler(projectId, compiler)
  ),
  setImageName: write('setImageName', (projectId, imageName) =>
    ProjectOptionsHandler.promises.setImageName(projectId, imageName)
  ),
}

const compileManager = {
  compile: write('compile', (projectId, userId, options) =>
    CompileManager.promises.compile(projectId, userId, options)
  ),
  deleteAuxFiles: write('deleteAuxFiles', (projectId, userId, limits) =>
    CompileManager.promises.deleteAuxFiles(projectId, userId, limits)
  ),
}

const clsiManager = {
  getOutputFileStream: read(
    (projectId, userId, clsiServerId, buildId, path) =>
      ClsiManager.promises.getOutputFileStream(
        projectId,
        userId,
        clsiServerId,
        buildId,
        path
      )
  ),
}

// Reads the signed-in user's own record (the ACE settings), not a project.
const userModel = {
  findById: async userId => {
    const scope = currentScope()
    if (String(userId ?? '') !== scope.userId) {
      const err = new Error('Tool call tried to reach another user')
      err.code = 'accessRevoked'
      throw err
    }
    return User.findById(userId)
  },
}

// PDF builds: a read of compile output for one project. The inspectors take
// the project in their options object.
function pdfRead(fn) {
  return async options => {
    await checkRead(options?.projectId)
    return fn(options)
  }
}

const pdfPageInspector = {
  inspect: pdfRead(inspectPdfPage),
  overview: pdfRead(overviewPdfPages),
  search: pdfRead(searchPdfText),
  highlight: pdfRead(highlightSourceInPdf),
}

const pdfStyleInspector = {
  inspect: pdfRead(options => inspectCompiledStyle(options)),
}

const pdfVisualDiff = {
  diff: pdfRead(options => diffBuilds(options)),
  remember: pdfRead(options => rememberBuildPages(options)),
}

/**
 * The core handlers the tools use, in the shape AiAssistTools takes them.
 * Pass an object with the same keys to AiAssistTools to test without core.
 */
export const projectGateway = {
  docUpdater,
  entityHandler,
  projectGetter,
  editorController,
  compileManager,
  clsiManager,
  projectOptionsHandler,
  userModel,
  pdfPageInspector,
  pdfStyleInspector,
  pdfVisualDiff,
}

// Pure helpers and error classes from core. They touch no project data, so
// they are re-exported here rather than imported by the tools.
export {
  PdfPageError,
  PDF_PAGE_ERRORS,
  REGIONS,
  resolveBlock,
  buildFingerprint,
  digestContent,
  diffFingerprints,
}

export default projectGateway
