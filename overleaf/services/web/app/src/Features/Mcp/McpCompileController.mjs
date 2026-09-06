import readline from 'node:readline'
import CompileManager from '../Compile/CompileManager.mjs'
import ClsiManager from '../Compile/ClsiManager.mjs'
import Errors from '../Errors/Errors.js'
import McpErrors from './McpErrors.mjs'

async function compile(req, res) {
  const { compiler, draft, stopOnFirstError } = req.body || {}
  const options = { draft: !!draft, stopOnFirstError: !!stopOnFirstError }
  if (compiler) {
    options.compiler = compiler
  }
  const result = await CompileManager.promises.compile(
    req.params.projectId,
    req.mcpUserId,
    options
  )
  const outputFiles = result.outputFiles || []
  const pdfFile = outputFiles.find(f => f.path === 'output.pdf')
  res.json({
    status: result.status,
    pdf: pdfFile ? { build: pdfFile.build, path: pdfFile.path } : null,
    outputFiles: outputFiles.map(f => ({ path: f.path, build: f.build })),
  })
}

const DEFAULT_LOG_MAX_LINES = 1000
const MAX_LOG_MAX_LINES = 10000

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
  let maxLines = parseInt((req.query || {}).maxLines, 10)
  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    maxLines = DEFAULT_LOG_MAX_LINES
  }
  maxLines = Math.min(maxLines, MAX_LOG_MAX_LINES)

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

  // Bounded read: keep only the last `maxLines` lines in a ring buffer so a
  // multi-MB log never gets fully buffered into memory.
  const ring = new Array(maxLines)
  let count = 0
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      ring[count % maxLines] = line
      count++
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  const kept = Math.min(count, maxLines)
  const start = count > maxLines ? count % maxLines : 0
  const lines = []
  for (let i = 0; i < kept; i++) {
    lines.push(ring[(start + i) % maxLines])
  }
  res.json({ log: lines.join('\n'), truncated: count > maxLines })
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
  stream.pipe(res)
}

async function clearCache(req, res) {
  await CompileManager.promises.deleteAuxFiles(
    req.params.projectId,
    req.mcpUserId,
    (req.query || {}).clsiserverid
  )
  res.json({ status: 'ok' })
}

async function wordCount(req, res) {
  const { file, clsiserverid: clsiServerId } = req.query || {}
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

export default { compile, getLog, getPdf, clearCache, wordCount, synctex }
