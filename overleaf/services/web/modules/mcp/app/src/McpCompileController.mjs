import { pipeline } from 'node:stream/promises'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import DocumentHelper from '../../../../app/src/Features/Documents/DocumentHelper.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectEntityUpdateHandler from '../../../../app/src/Features/Project/ProjectEntityUpdateHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import McpErrors from './McpErrors.mjs'
import { summarizeCompileLogs } from './CompileLogSummary.mjs'
import { limitBinaryStream } from './McpBinaryLimit.mjs'
import {
  MAX_OUTPUT_LOG_BYTES,
  readBounded,
} from '../../../../app/src/Features/PdfInspection/BoundedStream.mjs'
import { buildFingerprint, diffFingerprints } from '../../../../app/src/Features/PdfInspection/BuildFingerprint.mjs'
import {
  findBuild,
  latestBuild,
  previousBuild,
  rememberBuild,
} from './McpBuildRecords.mjs'
import PdfVisualDiff, { VISUAL_DIFF_ERRORS } from '../../../../app/src/Features/PdfInspection/PdfVisualDiff.mjs'
import PdfPageInspector, {
  PdfPageError,
  PDF_PAGE_ERRORS,
  REGIONS,
} from '../../../../app/src/Features/PdfInspection/PdfPageInspector.mjs'

// Resolve a project path to a text document, for the rootDocPath override.
// Returns null when the path is missing or names a file or folder.
async function resolveRootDoc(projectId, rootDocPath) {
  const path = `/${String(rootDocPath).replace(/^\/+/, '')}`
  try {
    const { element, type } = await ProjectLocator.promises.findElementByPath({
      project_id: projectId,
      path,
    })
    if (type !== 'doc') return null
    return { rootDoc_id: element._id, rootResourcePath: path.slice(1) }
  } catch (err) {
    if (err instanceof Errors.NotFoundError) return null
    throw err
  }
}

/**
 * A JSON boolean flag. Absent or null is false; anything other than a boolean
 * is rejected, so the string "false" does not switch the flag on.
 * Returns `{ value }`, or `null` when the input is not a boolean.
 */
function booleanFlag(value) {
  if (value == null) return { value: false }
  if (typeof value !== 'boolean') return null
  return { value }
}

/**
 * The root document of a project without writing to it. CompileManager's own
 * fallback (ensureRootDocumentIsValid) unsets a stale root and saves an
 * automatic one, which a read-only caller must not cause. Returns null when no
 * text document can serve as the root.
 */
async function readOnlyRootDoc(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootDoc_id: 1,
    rootFolder: 1,
  })
  if (!project) return null
  const current = await rootPathOf(project)
  if (current) {
    return { rootDoc_id: project.rootDoc_id, rootResourcePath: current }
  }
  // Same choice setRootDocAutomatically makes, without saving it.
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  for (const [path, doc] of Object.entries(docs)) {
    if (
      ProjectEntityUpdateHandler.isPathValidForRootDoc(path) &&
      DocumentHelper.contentHasDocumentclass(doc.lines) &&
      doc._id
    ) {
      return {
        rootDoc_id: doc._id,
        rootResourcePath: path.replace(/^\/+/, ''),
      }
    }
  }
  return null
}

async function compile(req, res) {
  const { compiler, draft, stopOnFirstError, rootDocPath, diagnostics } =
    req.body || {}
  if (
    (compiler != null && typeof compiler !== 'string') ||
    (rootDocPath != null && typeof rootDocPath !== 'string')
  ) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'compiler and rootDocPath must be strings'
    )
  }
  const draftFlag = booleanFlag(draft)
  const stopFlag = booleanFlag(stopOnFirstError)
  if (!draftFlag || !stopFlag) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'draft and stopOnFirstError must be true or false'
    )
  }
  const diagnosticsFlag = booleanFlag(diagnostics)
  if (!diagnosticsFlag) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'diagnostics must be true or false'
    )
  }
  if (compiler && !Settings.safeCompilers.includes(compiler)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `compiler must be one of ${Settings.safeCompilers.join(', ')}`
    )
  }
  const projectId = req.params.projectId
  const options = {
    draft: draftFlag.value,
    stopOnFirstError: stopFlag.value,
    // Ask LaTeX for "file:line: message" errors, so each error names its file
    // and line instead of only the file that was open at the time.
    fileLineErrors: true,
  }
  if (compiler) {
    options.compiler = compiler
  }
  if (rootDocPath) {
    const root = await resolveRootDoc(projectId, rootDocPath)
    if (!root) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        'rootDocPath does not name a text document in this project',
        {
          hint: 'Call list_files to get the exact path of the .tex file, e.g. /chapters/main.tex.',
        }
      )
    }
    options.rootDoc_id = root.rootDoc_id
    options.rootResourcePath = root.rootResourcePath
  } else if (
    !(await AuthorizationManager.promises.canUserWriteProjectContent(
      req.mcpUserId,
      projectId,
      null
    ))
  ) {
    const root = await readOnlyRootDoc(projectId)
    if (!root) {
      // What CompileManager would answer, without the root-document writes.
      return res.json({
        status: 'validation-problems',
        buildId: null,
        clsiServerId: null,
        rootDocPath: null,
        pdf: null,
        pdfProduced: false,
        outputFiles: [],
        validationProblems: { mainFile: 'no main file specified' },
      })
    }
    options.rootDoc_id = root.rootDoc_id
    options.rootResourcePath = root.rootResourcePath
  }
  // Taken before the build, so an edit made while LaTeX runs counts as a change.
  let fingerprint = null
  try {
    fingerprint = await fingerprintOf(
      projectId,
      options.rootResourcePath,
      compiler
    )
  } catch (err) {
    logger.warn({ err, projectId }, 'could not fingerprint project for compile')
  }
  const result = await CompileManager.promises.compile(
    projectId,
    req.mcpUserId,
    options
  )
  const outputFiles = result.outputFiles || []
  if (result.buildId && fingerprint) {
    rememberBuild(projectId, {
      buildId: result.buildId,
      clsiServerId: result.clsiServerId ?? null,
      fingerprint,
      fromOverride: options.rootResourcePath != null,
    })
  }
  if (result.buildId && outputFiles.some(f => f.path === 'output.pdf')) {
    // Keep the pages now, so a later diff still has this build after the
    // compile server has dropped it. Failure is not the compile's problem.
    PdfVisualDiff.rememberBuildPages({
      projectId,
      userId: req.mcpUserId,
      buildId: result.buildId,
      clsiServerId: result.clsiServerId ?? null,
    }).catch(err =>
      logger.warn({ err, projectId }, 'could not keep build pages for a diff')
    )
  }
  const pdfFile = outputFiles.find(f => f.path === 'output.pdf')
  const body = {
    status: result.status,
    buildId: result.buildId ?? null,
    clsiServerId: result.clsiServerId ?? null,
    rootDocPath: options.rootResourcePath ?? null,
    pdf: pdfFile ? { build: pdfFile.build, path: pdfFile.path } : null,
    pdfProduced: pdfFile != null,
    outputFiles: outputFiles.map(f => ({ path: f.path, build: f.build })),
  }
  if (result.validationProblems) {
    body.validationProblems = result.validationProblems
  }
  if (compiler) {
    // The compiler this build used: the requested one, for this compile only
    body.compiler = compiler
  }
  if (diagnosticsFlag.value && result.buildId) {
    // The same view get_compile_diagnostics gives, so a failed build needs no
    // second call. A failure here is reported, not made the compile's failure.
    try {
      const root = rootDocPath
        ? options.rootResourcePath
        : await currentRootDocPath(projectId)
      const view = await buildDiagnostics(
        projectId,
        req.mcpUserId,
        result.clsiServerId ?? null,
        result.buildId,
        root
      )
      if (view.tooLarge) {
        body.diagnosticsError = 'build log is too large'
      } else {
        body.diagnostics = view
      }
    } catch (err) {
      logger.warn({ err, projectId }, 'could not read compile diagnostics')
      body.diagnosticsError = 'could not read the build logs'
    }
  }
  res.json(body)
}

const BUILD_ID_RE = /^[a-f0-9]+-[a-f0-9]+$/
const CLSI_SERVER_ID_RE = /^[a-z0-9-]+$/

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ABORT_ERR',
])

// The build a request is about: the one it names, or else the newest build
// this process recorded for the project, with its compile server. Returns null
// when no buildId is named and no build is recorded.
function resolveBuild(projectId, query) {
  const { buildId, clsiserverid: clsiServerId } = query || {}
  if (buildId) return { buildId, clsiServerId }
  const latest = latestBuild(projectId)
  if (!latest) return null
  return {
    buildId: latest.buildId,
    clsiServerId: clsiServerId || latest.clsiServerId,
  }
}

function sendNoBuild(res) {
  return McpErrors.send(
    res,
    McpErrors.CODES.VALIDATION,
    'no build recorded for this project; call compile_project first',
    {
      hint: 'Call compile_project to build the project, then retry without buildId to use its latest build.',
    }
  )
}

// Validate the CLSI passthrough params at the controller boundary so a
// malformed value becomes a 400 validation_error rather than a 502 from deep
// inside ClsiManager. Returns an error message string, or null when valid.
function validateBuildParams({ buildId, clsiServerId }) {
  if (buildId != null && !BUILD_ID_RE.test(String(buildId))) {
    return 'invalid buildId'
  }
  if (
    clsiServerId != null &&
    clsiServerId !== '' &&
    !CLSI_SERVER_ID_RE.test(String(clsiServerId))
  ) {
    return 'invalid clsiserverid'
  }
  return null
}

function isTransientFetchError(err) {
  const status = err?.info?.status ?? err?.response?.status
  if (status != null) {
    return status >= 500
  }
  // Only genuine network / timeout / abort errors have no HTTP status but are
  // still transient. Anything else (ZodError, TypeError, …) is a real bug and
  // must not be masked as a 502.
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || NETWORK_ERROR_CODES.has(err.code))
  )
}

async function getLog(req, res) {
  const { fromLine } = req.query || {}
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  // maxLines, when given, is the size of the trailing window (or of a window
  // starting at fromLine). Without it the whole log is returned.
  const parsedMax = parseInt((req.query || {}).maxLines, 10)
  const maxLines =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null
  // 1-based first line of a forward window; absent means the trailing lines
  // (or, with no maxLines either, every line).
  const parsedFrom = parseInt(fromLine, 10)
  const fromLineNo =
    Number.isFinite(parsedFrom) && parsedFrom > 0 ? parsedFrom : null

  let stream
  try {
    stream = await ClsiManager.promises.getOutputFileStream(
      req.params.projectId,
      req.mcpUserId,
      clsiServerId,
      buildId,
      'output.log'
    )
  } catch (err) {
    if (
      err instanceof Errors.OutputFileFetchFailedError ||
      err instanceof Errors.NotFoundError
    ) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND, 'no compile log')
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }

  // A window of a log past the cap would be wrong at its end, so a log over
  // the cap is refused rather than cut.
  const { buffer, truncated } = await readBounded(stream, MAX_OUTPUT_LOG_BYTES)
  if (truncated) {
    return sendLogTooLarge(res)
  }

  // Lines end at \n, \r\n or a lone \r, as readline splits them. A final
  // terminator ends the last line rather than starting an empty one.
  const all = buffer.toString('utf8').split(/\r\n|\r|\n/)
  if (all[all.length - 1] === '') all.pop()
  const total = all.length

  // With maxLines and no fromLine, the trailing maxLines lines. Otherwise the
  // lines from the first wanted line on, up to maxLines when given. Every line
  // is still counted for totalLines.
  let firstLine
  let lines
  if (maxLines != null && fromLineNo == null) {
    lines = all.slice(-maxLines)
    firstLine = total - lines.length + 1
  } else {
    firstLine = fromLineNo ?? 1
    const end = maxLines == null ? undefined : firstLine - 1 + maxLines
    lines = all.slice(firstLine - 1, end)
  }
  res.json({
    log: lines.join('\n'),
    startLine: lines.length ? firstLine : null,
    endLine: lines.length ? firstLine + lines.length - 1 : null,
    totalLines: total,
    truncated: lines.length < total,
  })
}

function sendLogTooLarge(res) {
  return McpErrors.send(
    res,
    McpErrors.CODES.TOO_LARGE,
    `build log is larger than ${MAX_OUTPUT_LOG_BYTES / (1024 * 1024)} MB`,
    {
      hint: 'The build wrote an unusually large log, usually from a loop of errors or warnings. Fix the first error in get_compile_log or get_compile_diagnostics, then compile again.',
    }
  )
}

// Read a whole output file as text, up to the log cap. Returns null when the
// build did not write it (e.g. no output.blg when the project has no
// bibliography log), `{ tooLarge: true }` when it is over the cap, and
// `{ text }` otherwise.
async function readOutputText(projectId, userId, clsiServerId, buildId, path) {
  let stream
  try {
    stream = await ClsiManager.promises.getOutputFileStream(
      projectId,
      userId,
      clsiServerId,
      buildId,
      path
    )
  } catch (err) {
    if (
      err instanceof Errors.OutputFileFetchFailedError ||
      err instanceof Errors.NotFoundError
    ) {
      return null
    }
    throw err
  }
  const { buffer, truncated } = await readBounded(stream, MAX_OUTPUT_LOG_BYTES)
  if (truncated) return { tooLarge: true }
  return { text: buffer.toString('utf8') }
}

// The project's current root document, used to resolve log paths when the
// caller does not name one. Read-only: unlike ensureRootDocumentIsValid it
// never changes the project.
async function rootPathOf(project) {
  if (!project || project.rootDoc_id == null) return null
  const path = await ProjectEntityHandler.promises.getDocPathFromProjectByDocId(
    project,
    project.rootDoc_id
  )
  return path ? path.replace(/^\/+/, '') : null
}

async function currentRootDocPath(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootDoc_id: 1,
    rootFolder: 1,
  })
  return rootPathOf(project)
}

/**
 * Fingerprint of everything a build depends on right now: the root document,
 * the compiler and image, and every doc (by its revision) and file (by its
 * id). `rootOverride` names the main file a build was asked to compile
 * instead of the project's root.
 */
async function fingerprintOf(projectId, rootOverride, compilerOverride) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    rootDoc_id: 1,
    rootFolder: 1,
    compiler: 1,
    imageName: 1,
  })
  if (!project) return null
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  const files = await ProjectEntityHandler.promises.getAllFiles(projectId)
  return buildFingerprint({
    rootDocPath: rootOverride ?? (await rootPathOf(project)),
    compiler: compilerOverride ?? project.compiler ?? null,
    imageName: project.imageName ?? null,
    entries: [
      ...Object.entries(docs).map(([path, doc]) => ({
        path,
        digest: `doc:${doc.rev ?? ''}`,
      })),
      ...Object.entries(files).map(([path, file]) => ({
        path,
        digest: `file:${file._id ?? ''}`,
      })),
    ],
  })
}

/**
 * How the project has changed since the build was compiled, or null when it
 * has not, or when this process did not record the build. A failure to read
 * the project is logged and treated as unknown, so a page view still works.
 */
async function staleFor(projectId, buildId) {
  const record = findBuild(projectId, buildId)
  if (!record) return null
  try {
    const current = await fingerprintOf(
      projectId,
      record.fromOverride ? record.fingerprint.rootDocPath : null
    )
    return current ? diffFingerprints(record.fingerprint, current) : null
  } catch (err) {
    logger.warn({ err, projectId, buildId }, 'could not check PDF staleness')
    return null
  }
}

/**
 * Parsed view of a build: errors, warnings, bad boxes and rerun advice, read
 * from output.log and output.blg. The LaTeX and BibTeX parsing lives in
 * CompileLogSummary.mjs.
 */
// The diagnostics view of a build, read from its output.log and output.blg,
// with `root` as the main file the paths are judged against. Returns
// `{ tooLarge: true }` when a log is over the cap. Throws when a log cannot be
// read at all.
async function buildDiagnostics(projectId, userId, clsiServerId, buildId, root) {
  const log = await readOutputText(
    projectId,
    userId,
    clsiServerId,
    buildId,
    'output.log'
  )
  const blg = await readOutputText(
    projectId,
    userId,
    clsiServerId,
    buildId,
    'output.blg'
  )
  if (log?.tooLarge || blg?.tooLarge) {
    return { tooLarge: true }
  }
  const diagnostics = summarizeCompileLogs({
    latexLog: log?.text ?? null,
    bibLogs: blg?.text != null ? [blg.text] : [],
    rootDocPath: root,
  })
  return {
    buildId,
    logAvailable: log != null,
    rootDocPath: root || null,
    ...diagnostics,
  }
}

async function getDiagnostics(req, res) {
  const { rootDocPath } = req.query || {}
  const projectId = req.params.projectId
  const build = resolveBuild(projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (rootDocPath && String(rootDocPath).split('/').includes('..')) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'invalid rootDocPath'
    )
  }

  const root = rootDocPath
    ? String(rootDocPath).replace(/^\/+/, '')
    : await currentRootDocPath(projectId)

  const view = await buildDiagnostics(
    projectId,
    req.mcpUserId,
    clsiServerId,
    buildId,
    root
  )
  if (view.tooLarge) {
    return sendLogTooLarge(res)
  }
  res.json(view)
}

async function getPdf(req, res) {
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }

  let stream
  try {
    stream = await ClsiManager.promises.getOutputFileStream(
      req.params.projectId,
      req.mcpUserId,
      clsiServerId,
      buildId,
      'output.pdf'
    )
  } catch (err) {
    if (
      err instanceof Errors.OutputFileFetchFailedError ||
      err instanceof Errors.NotFoundError
    ) {
      return McpErrors.send(res, McpErrors.CODES.NOT_FOUND, 'no pdf for build')
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }

  // Streamed, so a PDF is never held whole in memory. The size is not known
  // before the body arrives, so an over-cap PDF is cut off mid-stream: the
  // client sees an incomplete response rather than a complete-looking one.
  res.setHeader('Content-Type', 'application/pdf')
  return pipeline(stream, limitBinaryStream(), res)
}

function positiveInteger(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : NaN
}

const MIN_EDGE_PX = 512
const PAGE_SPLITS = ['none', 'halves']
const BLOCK_ID_RE = /^B\d+$/

/**
 * The render options a page request asks for, validated. Returns
 * `{ error }` with the message to send, or `{ options }` to pass on. Defect
 * records are always on; labels when the caller asks for them.
 */
function renderOptions(query) {
  const options = {}
  if (query.maxEdgePx != null && query.maxEdgePx !== '') {
    const maxEdgePx = Number(query.maxEdgePx)
    if (!Number.isInteger(maxEdgePx) || maxEdgePx < MIN_EDGE_PX) {
      return {
        error: `maxEdgePx must be a whole number of at least ${MIN_EDGE_PX}`,
      }
    }
    options.maxEdgePx = maxEdgePx
  }
  if (query.grayscale != null && query.grayscale !== '') {
    if (query.grayscale !== 'true' && query.grayscale !== 'false') {
      return { error: 'grayscale must be true or false' }
    }
    options.grayscale = query.grayscale === 'true'
  }
  if (query.split != null && query.split !== '') {
    if (!PAGE_SPLITS.includes(query.split)) {
      return { error: `split must be one of ${PAGE_SPLITS.join(', ')}` }
    }
    options.split = query.split
  }
  if (query.labels === 'true') options.labels = true
  options.defects = true
  return { options }
}

// How each inspector failure reads to the model: the code decides whether it
// retries, the hint which call to make instead.
const PDF_PAGE_FAILURES = {
  [PDF_PAGE_ERRORS.NO_PDF]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'This build wrote no PDF. Read its errors with get_compile_log, fix them, and compile_project again.',
  },
  [PDF_PAGE_ERRORS.PAGE_OUT_OF_RANGE]: {
    code: McpErrors.CODES.VALIDATION,
    hint: 'Pass a page between 1 and details.pageCount.',
  },
  [PDF_PAGE_ERRORS.LINE_NOT_IN_PDF]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'That line is not typeset in this build. It is outside the compiled content: in the preamble, behind a comment or an \iffalse, in a file the root document does not include, or in a file the build excludes; or it was added after this build. Check that the file is included from the root document and that the line is in the body, or pass page instead. sync_pdf_source maps pages to source lines.',
  },
  [PDF_PAGE_ERRORS.SYNCTEX_UNAVAILABLE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'This build has no SyncTeX file, so source lines cannot be found in its PDF. Call compile_project with clean: true to rebuild it, then retry with the new buildId. Until then, pass page to see a page without its source map.',
  },
  [PDF_PAGE_ERRORS.INVALID_QUERY]: {
    code: McpErrors.CODES.VALIDATION,
    hint: 'The search text is not usable. Pass plain text, not a regular expression.',
  },
  [PDF_PAGE_ERRORS.RENDERER_UNAVAILABLE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'This server cannot render pages; do not retry. Use get_compile_pdf to hand the PDF to the user.',
  },
  [PDF_PAGE_ERRORS.RENDER_FAILED]: {
    code: McpErrors.CODES.UPSTREAM,
    hint: 'Compile again with compile_project, then retry with the new buildId; for a very dense page, pass region.',
  },
}

/**
 * One page of a build rendered as an image, with the SyncTeX map from heights
 * on the page to source lines and the bad boxes on it. The rendering is in
 * PdfPageInspector.mjs, shared with the AI assistant.
 */
async function getPdfPage(req, res) {
  const { path, region = 'full' } = req.query || {}
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  const page = positiveInteger(req.query.page)
  const line = positiveInteger(req.query.line)
  const endLine = positiveInteger(req.query.endLine)
  if (Number.isNaN(page) || Number.isNaN(line) || Number.isNaN(endLine)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'page, line and endLine must be whole numbers from 1'
    )
  }
  if (endLine != null && (page != null || line == null || endLine < line)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'endLine requires path and line, and must be greater than or equal to line'
    )
  }
  if (page == null && path && line == null) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'line is required with path'
    )
  }
  if (path != null && typeof path !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'path must be a string')
  }
  if (path && String(path).split('/').includes('..')) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid path')
  }
  if (!REGIONS.includes(region)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      `region must be one of ${REGIONS.join(', ')}`
    )
  }

  const render = renderOptions(req.query)
  if (render.error) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, render.error)
  }

  const projectId = req.params.projectId
  try {
    const inspected = await PdfPageInspector.inspectPdfPage({
      projectId,
      userId: req.mcpUserId,
      buildId,
      clsiServerId,
      ...(page != null
        ? { page }
        : path
          ? { path, line, ...(endLine != null ? { endLine } : {}) }
          : { page: 1 }),
      region,
      ...render.options,
      rootDocPath: await currentRootDocPath(projectId),
    })
    const stale = await staleFor(projectId, buildId)
    res.json({ buildId, ...inspected, ...(stale ? { stale } : {}) })
  } catch (err) {
    if (err instanceof PdfPageError) {
      const failure =
        PDF_PAGE_FAILURES[err.code] ??
        PDF_PAGE_FAILURES[PDF_PAGE_ERRORS.RENDER_FAILED]
      if (failure.code === McpErrors.CODES.UPSTREAM) {
        return McpErrors.sendInternal(res, err, {
          projectId: req.params.projectId,
          hint: failure.hint,
        })
      }
      return McpErrors.send(res, failure.code, err.message, {
        hint: failure.hint,
        ...(err.details ? { details: err.details } : {}),
      })
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }
}

/**
 * Thumbnails of the pages (all of them by default) in one image with per-page
 * measurements, paper size and problem fonts.
 */
async function getPdfOverview(req, res) {
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  const fromPage = positiveInteger(req.query.fromPage)
  const toPage = positiveInteger(req.query.toPage)
  if (Number.isNaN(fromPage) || Number.isNaN(toPage)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'fromPage and toPage must be whole numbers from 1'
    )
  }
  if (fromPage != null && toPage != null && toPage < fromPage) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'toPage must be greater than or equal to fromPage'
    )
  }

  const projectId = req.params.projectId
  try {
    const overview = await PdfPageInspector.overviewPdfPages({
      projectId,
      userId: req.mcpUserId,
      buildId,
      clsiServerId,
      ...(fromPage != null ? { fromPage } : {}),
      ...(toPage != null ? { toPage } : {}),
      rootDocPath: await currentRootDocPath(projectId),
    })
    const stale = await staleFor(projectId, buildId)
    res.json({ buildId, ...overview, ...(stale ? { stale } : {}) })
  } catch (err) {
    if (err instanceof PdfPageError) {
      const failure =
        PDF_PAGE_FAILURES[err.code] ??
        PDF_PAGE_FAILURES[PDF_PAGE_ERRORS.RENDER_FAILED]
      if (failure.code === McpErrors.CODES.UPSTREAM) {
        return McpErrors.sendInternal(res, err, {
          projectId: req.params.projectId,
          hint: failure.hint,
        })
      }
      return McpErrors.send(res, failure.code, err.message, {
        hint: failure.hint,
        ...(err.details ? { details: err.details } : {}),
      })
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }
}

/**
 * Searches the rendered text layer of the PDF and maps each hit to page,
 * height and the source line that typeset it.
 */
async function searchPdf(req, res) {
  const { query } = req.query || {}
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'query is required')
  }
  const fromPage = positiveInteger(req.query.fromPage)
  const toPage = positiveInteger(req.query.toPage)
  if (Number.isNaN(fromPage) || Number.isNaN(toPage)) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'fromPage and toPage must be whole numbers from 1'
    )
  }
  if (fromPage != null && toPage != null && toPage < fromPage) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'toPage must be greater than or equal to fromPage'
    )
  }

  const projectId = req.params.projectId
  try {
    const searchResult = await PdfPageInspector.searchPdfText({
      projectId,
      userId: req.mcpUserId,
      buildId,
      clsiServerId,
      query: query.trim(),
      ...(fromPage != null ? { fromPage } : {}),
      ...(toPage != null ? { toPage } : {}),
    })
    const stale = await staleFor(projectId, buildId)
    res.json({ buildId, ...searchResult, ...(stale ? { stale } : {}) })
  } catch (err) {
    if (err instanceof PdfPageError) {
      const failure =
        PDF_PAGE_FAILURES[err.code] ??
        PDF_PAGE_FAILURES[PDF_PAGE_ERRORS.RENDER_FAILED]
      if (failure.code === McpErrors.CODES.UPSTREAM) {
        return McpErrors.sendInternal(res, err, {
          projectId: req.params.projectId,
          hint: failure.hint,
        })
      }
      return McpErrors.send(res, failure.code, err.message, {
        hint: failure.hint,
        ...(err.details ? { details: err.details } : {}),
      })
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }
}

/**
 * Delete the build's auxiliary files so the next compile starts clean. Served
 * at compile/clean; the compile/clear-cache route is a deprecated alias.
 */
async function clean(req, res) {
  const clsiServerId = (req.query || {}).clsiserverid
  const paramError = validateBuildParams({ clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  await CompileManager.promises.deleteAuxFiles(
    req.params.projectId,
    req.mcpUserId,
    clsiServerId
  )
  res.json({ status: 'ok' })
}

const clearCache = clean

/**
 * The `pages` query of a diff: comma-separated whole page numbers of the newer
 * build, e.g. `pages=3,4`. Returns `{ pages }` (null when absent) or `{ error }`.
 */
function parsePageList(value) {
  if (value == null || value === '') return { pages: null }
  if (typeof value !== 'string') {
    return { error: 'pages must be a comma-separated list of page numbers from 1' }
  }
  const pages = value.split(',').map(part => positiveInteger(part.trim()))
  if (pages.some(page => page == null || Number.isNaN(page))) {
    return { error: 'pages must be a comma-separated list of page numbers from 1' }
  }
  return { pages: [...new Set(pages)] }
}

// How a visual diff failure reads to the model.
const PDF_DIFF_FAILURES = {
  [VISUAL_DIFF_ERRORS.PREVIOUS_BUILD_GONE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'The earlier build is no longer on the compile server. Compile the project again, then diff against the build from that compile.',
  },
  [VISUAL_DIFF_ERRORS.BUILD_GONE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'This build is no longer on the compile server. Compile the project again and diff the new build.',
  },
  [VISUAL_DIFF_ERRORS.BUILD_UNAVAILABLE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'One of the builds has no PDF. Diff two builds that each produced one.',
  },
  [VISUAL_DIFF_ERRORS.TOO_MANY_PAGES]: {
    code: McpErrors.CODES.VALIDATION,
    hint: 'Pass pages, a comma-separated list of page numbers of the newer build (for example pages=3,4,5), to compare at most 40 of them.',
  },
  [VISUAL_DIFF_ERRORS.RENDERER_UNAVAILABLE]: {
    code: McpErrors.CODES.NOT_FOUND,
    hint: 'This server cannot render pages; do not retry.',
  },
}

/**
 * Pixel diff of the pages of two builds of this project: the build given and
 * the build before it (or beforeBuildId when given). PdfVisualDiff.mjs does
 * the comparison, shared with the AI assistant.
 */
async function getPdfDiff(req, res) {
  const { beforeBuildId } = req.query || {}
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (beforeBuildId != null && !BUILD_ID_RE.test(String(beforeBuildId))) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid beforeBuildId')
  }
  const pageList = parsePageList(req.query.pages)
  if (pageList.error) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, pageList.error)
  }

  const projectId = req.params.projectId
  let before = null
  if (beforeBuildId) {
    before = { buildId: beforeBuildId, clsiServerId: null }
  } else {
    before = previousBuild(projectId, buildId)
    if (!before) {
      return McpErrors.send(
        res,
        McpErrors.CODES.NOT_FOUND,
        'there is no earlier build of this project to compare with',
        {
          hint: 'Compile the project again after the change, then diff the two builds.',
        }
      )
    }
  }

  const diff = await PdfVisualDiff.diffBuilds({
    projectId,
    userId: req.mcpUserId,
    beforeBuildId: before.buildId,
    afterBuildId: buildId,
    clsiServerId,
    beforeClsiServerId: before.clsiServerId ?? clsiServerId,
    pages: pageList.pages,
  })
  if (!diff.ok) {
    const failure = PDF_DIFF_FAILURES[diff.reason] ?? {
      code: McpErrors.CODES.UPSTREAM,
      hint: 'Compile again, then retry the comparison.',
    }
    if (failure.code === McpErrors.CODES.UPSTREAM) {
      return McpErrors.sendInternal(res, new Error(diff.message || diff.reason), {
        projectId: req.params.projectId,
        hint: failure.hint,
      })
    }
    return McpErrors.send(res, failure.code, diff.message, { hint: failure.hint })
  }
  res.json(diff)
}

/**
 * The file and lines a block id drawn on a page image names. Fills the label
 * table of the page on a miss (the table lives in the process that rendered
 * the page), then reads it again.
 */
async function getPdfBlock(req, res) {
  const { blockId } = req.query || {}
  const build = resolveBuild(req.params.projectId, req.query)
  if (!build) return sendNoBuild(res)
  const { buildId, clsiServerId } = build
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  const page = positiveInteger(req.query.page)
  if (page == null || Number.isNaN(page)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'page is required, a whole number from 1')
  }
  if (typeof blockId !== 'string' || !BLOCK_ID_RE.test(blockId)) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'blockId must look like B3')
  }

  const projectId = req.params.projectId
  const lookup = {
    projectId,
    userId: req.mcpUserId,
    buildId,
    clsiServerId,
    page,
    blockId,
  }
  try {
    let block = await PdfPageInspector.resolveBlock(lookup)
    if (!block) {
      await PdfPageInspector.inspectPdfPage({
        projectId,
        userId: req.mcpUserId,
        buildId,
        clsiServerId,
        page,
        labels: true,
        withImage: false,
        rootDocPath: await currentRootDocPath(projectId),
      })
      block = await PdfPageInspector.resolveBlock(lookup)
    }
    if (!block) {
      return McpErrors.send(
        res,
        McpErrors.CODES.NOT_FOUND,
        `no block ${blockId} on page ${page} of this build`,
        {
          hint: 'Pass labels true to view_compiled_pdf_page for this page, then use an id it draws.',
        }
      )
    }
    res.json({ buildId, blockId, page, ...block })
  } catch (err) {
    if (err instanceof PdfPageError) {
      const failure =
        PDF_PAGE_FAILURES[err.code] ??
        PDF_PAGE_FAILURES[PDF_PAGE_ERRORS.RENDER_FAILED]
      if (failure.code === McpErrors.CODES.UPSTREAM) {
        return McpErrors.sendInternal(res, err, {
          projectId: req.params.projectId,
          hint: failure.hint,
        })
      }
      return McpErrors.send(res, failure.code, err.message, {
        hint: failure.hint,
        ...(err.details ? { details: err.details } : {}),
      })
    }
    if (isTransientFetchError(err)) {
      return McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    }
    throw err
  }
}

async function wordCount(req, res) {
  const { file, clsiserverid: clsiServerId } = req.query || {}
  const paramError = validateBuildParams({ clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (file != null && typeof file !== 'string') {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'file must be a path')
  }
  const counts = await CompileManager.promises.wordCount(
    req.params.projectId,
    req.mcpUserId,
    file || false,
    clsiServerId
  )
  res.json({ wordCount: counts })
}

function finiteNumber(value) {
  if (value == null || value === '') {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function synctex(req, res) {
  const { file, line, column, page, h, v, buildId, editorId, clsiserverid } =
    req.query || {}
  const paramError = validateBuildParams({
    buildId,
    clsiServerId: clsiserverid,
  })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (
    (file != null && typeof file !== 'string') ||
    (editorId != null && typeof editorId !== 'string')
  ) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'file and editorId must be strings'
    )
  }

  const isPdf = page != null
  const isCode = file != null || line != null
  let direction
  let validatedOptions

  if (isPdf) {
    direction = 'pdf'
    const pageNum = finiteNumber(page)
    const hNum = finiteNumber(h)
    const vNum = finiteNumber(v)
    if (pageNum == null || hNum == null || vNum == null) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        'page, h and v must all be finite numbers'
      )
    }
    validatedOptions = { page: pageNum, h: hNum, v: vNum }
  } else if (isCode) {
    direction = 'code'
    const lineNum = finiteNumber(line)
    if (!file || lineNum == null) {
      return McpErrors.send(
        res,
        McpErrors.CODES.VALIDATION,
        'file and a finite line are required'
      )
    }
    // CLSI requires a column and rejects the request without one. Column 0
    // is SyncTeX's "any column", so a line alone maps to its whole line.
    validatedOptions = { file, line: lineNum, column: 0 }
    if (column != null && column !== '') {
      const columnNum = finiteNumber(column)
      if (columnNum == null) {
        return McpErrors.send(
          res,
          McpErrors.CODES.VALIDATION,
          'column must be a finite number'
        )
      }
      validatedOptions.column = columnNum
    }
  } else {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'provide either page/h/v (pdf) or file/line (code)'
    )
  }

  if (editorId != null) {
    validatedOptions.editorId = editorId
  }
  if (buildId != null) {
    validatedOptions.buildId = buildId
  }

  const result = await CompileManager.promises.syncTeX(
    req.params.projectId,
    req.mcpUserId,
    {
      direction,
      compileFromClsiCache: false,
      validatedOptions,
      clsiServerId: clsiserverid,
    }
  )
  res.json({ synctex: result })
}

export default {
  compile,
  getLog,
  getDiagnostics,
  getPdf,
  getPdfPage,
  getPdfOverview,
  searchPdf,
  getPdfBlock,
  getPdfDiff,
  clean,
  clearCache,
  wordCount,
  synctex,
}
