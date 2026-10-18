import readline from 'node:readline'
import { pipeline } from 'node:stream/promises'
import logger from '@overleaf/logger'
import CompileManager from '../../../../app/src/Features/Compile/CompileManager.mjs'
import ClsiManager from '../../../../app/src/Features/Compile/ClsiManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'
import McpErrors from './McpErrors.mjs'
import { summarizeCompileLogs } from './CompileLogSummary.mjs'
import { limitBinaryStream } from './McpBinaryLimit.mjs'
import { buildFingerprint, diffFingerprints } from '../../../../app/src/Features/PdfInspection/BuildFingerprint.mjs'
import {
  findBuild,
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

async function compile(req, res) {
  const { compiler, draft, stopOnFirstError, rootDocPath } = req.body || {}
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
  const projectId = req.params.projectId
  const options = {
    draft: !!draft,
    stopOnFirstError: !!stopOnFirstError,
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
  }
  // Taken before the build, so an edit made while LaTeX runs counts as a change.
  let fingerprint = null
  try {
    fingerprint = await fingerprintOf(projectId, options.rootResourcePath)
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
    // CLSI builds with the project's compiler; the request option is not
    // applied. Report the real one so the caller can tell.
    const project = await ProjectGetter.promises.getProject(projectId, {
      compiler: 1,
    })
    body.compiler = project?.compiler ?? null
    body.compilerRequested = compiler
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
  const { buildId, clsiserverid: clsiServerId, fromLine } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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

  // With maxLines and no fromLine, a ring buffer keeps only the trailing
  // lines. Otherwise the lines from the first wanted line on are kept, up to
  // maxLines when given. Every line is still counted for totalLines.
  const ring = maxLines != null && fromLineNo == null ? new Array(maxLines) : null
  const firstWanted = fromLineNo ?? 1
  const windowLines = []
  let total = 0
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      total++
      if (ring) {
        ring[(total - 1) % maxLines] = line
      } else if (
        total >= firstWanted &&
        (maxLines == null || windowLines.length < maxLines)
      ) {
        windowLines.push(line)
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  let lines
  let firstLine
  if (ring) {
    const kept = Math.min(total, maxLines)
    firstLine = total - kept + 1
    lines = []
    for (let n = firstLine; n <= total; n++) {
      lines.push(ring[(n - 1) % maxLines])
    }
  } else {
    lines = windowLines
    firstLine = firstWanted
  }
  res.json({
    log: lines.join('\n'),
    startLine: lines.length ? firstLine : null,
    endLine: lines.length ? firstLine + lines.length - 1 : null,
    totalLines: total,
    truncated: lines.length < total,
  })
}

// Read a whole output file as text, or null when the build did not write it
// (e.g. no output.blg when the project has no bibliography).
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
  const chunks = []
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
  } finally {
    stream.destroy()
  }
  return Buffer.concat(chunks).toString('utf8')
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
async function fingerprintOf(projectId, rootOverride) {
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
    compiler: project.compiler ?? null,
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
async function getDiagnostics(req, res) {
  const { buildId, clsiserverid: clsiServerId, rootDocPath } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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

  const projectId = req.params.projectId
  const userId = req.mcpUserId
  const root = rootDocPath
    ? String(rootDocPath).replace(/^\/+/, '')
    : await currentRootDocPath(projectId)

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
  const diagnostics = summarizeCompileLogs({
    latexLog: log,
    bibLogs: blg != null ? [blg] : [],
    rootDocPath: root,
  })
  res.json({
    buildId,
    logAvailable: log != null,
    rootDocPath: root || null,
    ...diagnostics,
  })
}

async function getPdf(req, res) {
  const { buildId, clsiserverid: clsiServerId } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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

  res.setHeader('Content-Type', 'application/pdf')
  const cleanup = () => stream.destroy()
  res.on('close', cleanup)
  stream.on('error', () => {
    if (!res.headersSent) {
      McpErrors.send(res, McpErrors.CODES.UPSTREAM)
    } else {
      res.destroy()
    }
  })
  // Past the cap the body is cut off; the MCP service reports it as too large.
  pipeline(stream, limitBinaryStream(), res).catch(() => {})
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
  const {
    buildId,
    clsiserverid: clsiServerId,
    path,
    region = 'full',
  } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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
        return McpErrors.sendInternal(res, err, { projectId: req.params.projectId })
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
  const { buildId, clsiserverid: clsiServerId } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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
        return McpErrors.sendInternal(res, err, { projectId: req.params.projectId })
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
  const { buildId, clsiserverid: clsiServerId, query } = req.query || {}
  if (!buildId) {
    return McpErrors.send(
      res,
      McpErrors.CODES.VALIDATION,
      'buildId is required'
    )
  }
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
        return McpErrors.sendInternal(res, err, { projectId: req.params.projectId })
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
  const {
    buildId,
    beforeBuildId,
    clsiserverid: clsiServerId,
  } = req.query || {}
  if (!buildId) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'buildId is required')
  }
  const paramError = validateBuildParams({ buildId, clsiServerId })
  if (paramError) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, paramError)
  }
  if (beforeBuildId != null && !BUILD_ID_RE.test(String(beforeBuildId))) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'invalid beforeBuildId')
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
  const { buildId, clsiserverid: clsiServerId, blockId } = req.query || {}
  if (!buildId) {
    return McpErrors.send(res, McpErrors.CODES.VALIDATION, 'buildId is required')
  }
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
        return McpErrors.sendInternal(res, err, { projectId: req.params.projectId })
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
    validatedOptions = { file, line: lineNum }
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
