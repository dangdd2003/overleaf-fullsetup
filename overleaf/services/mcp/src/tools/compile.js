import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { okResult, runTool, tokenFrom, withBlocks } from '../context.js'
import {
  binaryFields,
  envelope,
  looseObject,
  projectId,
  READ_ONLY,
} from '../schemas.js'
import { normalisePath } from '../parsers/paths.js'
import { clip, compactJson, lines, numberRuns, ref } from '../format.js'

const LOG_LEVELS = ['all', 'errors', 'warnings']
/** Vertical points sampled down a page when sync_pdf_source has no x/y. */
const SYNCTEX_PAGE_SAMPLES = [90, 230, 370, 510, 650, 790]
const PAGE_REGIONS = ['full', 'top', 'middle', 'bottom']
const PAGE_SPLITS = ['none', 'halves']
// Long edge of a page image in pixels. Vision models read this size well and
// it keeps the image cheap in context.
const DEFAULT_PAGE_MAX_EDGE_PX = 1024
const MIN_PAGE_MAX_EDGE_PX = 512
// Raw log lines returned when the caller does not ask for a window.
const DEFAULT_LOG_LINES = 200
// Text rendering limits, so a large log or document stays readable and small.
const MAX_ERROR_GROUPS = 30
const EXCERPT_ERRORS = 3
const EXCERPT_LINES = 2
const EXCERPT_LINE_WIDTH = 160
const MAX_BAD_BOX_LINES = 20
const MAX_SOURCE_ROWS = 12
const DEFECT_EVIDENCE_WIDTH = 140
const BAD_BOX_WIDTH = 100
const UNDEFINED_KEY = /`([^']+)'|"([^"]+)"/
const TEX_SYSTEM = '(TeX system file)'

// Statuses that mean "try again shortly", not "the project is broken".
const TRANSIENT_STATUSES = new Set([
  'too-recently-compiled',
  'compile-in-progress',
])
const MAX_COMPILE_ATTEMPTS = 3
const RETRY_BASE_MS = 1500
// web answers a compile only once the build has finished, and its own compile
// timeout is 180 s. The client waits a little longer than that, so a slow build
// is not reported as failed while web is still running it.
const COMPILE_TIMEOUT_MS = 200000

const EMPTY_COUNTS = Object.freeze({
  errors: 0,
  warnings: 0,
  badBoxes: 0,
  undefinedReferences: 0,
  undefinedCitations: 0,
})

const countsSchema = looseObject({
  errors: z.number().int().describe('LaTeX and BibTeX errors in the log'),
  warnings: z.number().int().describe('LaTeX and BibTeX warnings in the log'),
  badBoxes: z
    .number()
    .int()
    .describe('Overfull and underfull box messages (layout, not errors)'),
  undefinedReferences: z
    .number()
    .int()
    .describe('\\ref targets with no \\label'),
  undefinedCitations: z
    .number()
    .int()
    .describe('\\cite keys with no .bib entry'),
}).describe('Totals across the whole log')

const logEntry = looseObject({
  source: z.string().describe('latex, bibtex or biber'),
  kind: z
    .string()
    .optional()
    .describe('Warning category, e.g. undefined-reference'),
  path: z
    .string()
    .nullable()
    .describe('Project path to pass to read_file/edit_lines, or null for a TeX system file'),
  line: z
    .number()
    .int()
    .nullable()
    .describe('1-based line in path, or null when unknown'),
  message: z.string().describe('What LaTeX or BibTeX reported'),
  context: z
    .string()
    .optional()
    .describe('Source excerpt around the error, from the log'),
})

const logWarning = looseObject({
  source: z.string(),
  kind: z.string().optional(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  message: z.string(),
})

const badBox = looseObject({
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  message: z.string(),
  occurrences: z
    .number()
    .int()
    .optional()
    .describe('Pages the same box is reported on'),
})

/** A project path as every tool returns it: "/"-prefixed. */
function slashed(path) {
  return path ? `/${String(path).replace(/^\/+/, '')}` : path
}

/**
 * A path argument as web expects it: no leading "/". The path is normalised
 * first, so a '..' that would climb out of the project is refused here.
 */
function bare(path) {
  return normalisePath(path).slice(1)
}

function definedOnly(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined)
  )
}

/**
 * Rename each diagnostics entry's `file` to a `/`-prefixed `path`, so compile
 * results use the same key and form as every file tool.
 */
function normaliseDiagnostics(diag) {
  const withPath = entries =>
    Array.isArray(entries)
      ? entries.map(({ file, ...rest }) => ({
          path: file ? slashed(file) : null,
          ...rest,
        }))
      : entries
  return {
    ...diag,
    errors: withPath(diag?.errors) ?? [],
    warnings: withPath(diag?.warnings),
    badBoxes: withPath(diag?.badBoxes),
  }
}

/**
 * Fetch the parsed log of a build, with its entries normalised.
 */
async function fetchDiagnostics(client, token, id, query) {
  const diag = await client.get(token, `/projects/${id}/compile/diagnostics`, query)
  return normaliseDiagnostics(diag)
}

function sleepFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The buildId to append to a next step. The latest build is the default, so
 * it is only written out when the caller chose a build.
 */
function pinned(buildId) {
  return buildId ? ` buildId=${buildId}` : ''
}

/** A location as "path:line" (or "path:line-end"), with a placeholder for TeX system files. */
function where(path, line, endLine) {
  return ref(path ?? TEX_SYSTEM, line, endLine)
}

/**
 * Errors grouped by message: one "E" line per message with every place it
 * occurs, then the source excerpt of the first few groups.
 */
function renderErrorGroups(errors) {
  const groups = new Map()
  for (const entry of errors) {
    if (!groups.has(entry.message)) {
      groups.set(entry.message, { message: entry.message, context: entry.context, entries: [] })
    }
    groups.get(entry.message).entries.push(entry)
  }
  const list = [...groups.values()]
  const out = []
  list.slice(0, MAX_ERROR_GROUPS).forEach((group, index) => {
    const byPath = new Map()
    for (const entry of group.entries) {
      const key = entry.path ?? TEX_SYSTEM
      if (!byPath.has(key)) byPath.set(key, [])
      if (entry.line != null) byPath.get(key).push(entry.line)
    }
    const places = [...byPath].map(([path, nums]) =>
      ref(path, [...new Set(nums)].sort((a, b) => a - b).join(',') || undefined)
    )
    out.push(`E ${group.message} — ${places.join('; ')}`)
    if (index < EXCERPT_ERRORS && group.context) {
      for (const line of String(group.context).split('\n').slice(0, EXCERPT_LINES)) {
        out.push(`    ${clip(line, EXCERPT_LINE_WIDTH)}`)
      }
    }
  })
  if (list.length > MAX_ERROR_GROUPS) {
    out.push(`… ${list.length - MAX_ERROR_GROUPS} more error groups`)
  }
  return out
}

/** The key an undefined reference or citation names, between ` and ' or quotes. */
function undefinedKey(message) {
  const match = UNDEFINED_KEY.exec(String(message))
  return match ? (match[1] ?? match[2]) : null
}

/**
 * Log warnings in text form: undefined references and citations as their
 * keys on one line each, every other kind counted with its first message.
 */
function renderLogWarnings(warnings) {
  const undefinedKinds = [
    ['undefined-reference', 'undefined refs'],
    ['undefined-citation', 'undefined cites'],
  ]
  const out = []
  for (const [kind, label] of undefinedKinds) {
    // key -> the places it is used, so each one can be fixed where it is
    const keys = new Map()
    let unnamed = 0
    for (const entry of warnings) {
      if (entry.kind !== kind) continue
      const key = undefinedKey(entry.message)
      if (key === null) {
        unnamed++
        continue
      }
      if (!keys.has(key)) keys.set(key, [])
      if (entry.path) keys.get(key).push(where(entry.path, entry.line))
    }
    if (keys.size) {
      const named = [...keys].map(([key, places]) =>
        places.length ? `${key} (${[...new Set(places)].join(', ')})` : key
      )
      out.push(`${label}: ${named.join(', ')}${unnamed ? ` (+${unnamed} unnamed)` : ''}`)
    } else if (unnamed) {
      out.push(`${label} ×${unnamed}`)
    }
  }
  const others = new Map()
  for (const entry of warnings) {
    if (undefinedKinds.some(([kind]) => kind === entry.kind)) continue
    const kind = entry.kind ?? 'other'
    if (!others.has(kind)) others.set(kind, { count: 0, message: entry.message })
    others.get(kind).count++
  }
  for (const [kind, { count, message }] of others) {
    out.push(`W ${kind} ×${count}: ${clip(message, 120)}`)
  }
  return out
}

/** Bad boxes as "B <path>:<line> <message>", capped at max lines. */
function renderBadBoxes(boxes, { max = MAX_BAD_BOX_LINES, width = Infinity } = {}) {
  const out = boxes.slice(0, max).map(box => {
    const times = box.occurrences > 1 ? ` ×${box.occurrences}` : ''
    return `B ${where(box.path, box.line)} ${clip(box.message, width)}${times}`
  })
  if (boxes.length > max) out.push(`… ${boxes.length - max} more bad boxes`)
  return out
}

/** Defects as one line each, with the fixes the rules ban for them. */
function renderDefects(defects) {
  return defects.flatMap(defect => {
    const at = defect.path ? ref(defect.path, defect.line) : null
    const head = [
      defect.id,
      defect.category,
      defect.severity,
      at,
      clip(defect.evidence ?? '', DEFECT_EVIDENCE_WIDTH),
    ]
      .filter(Boolean)
      .join(' ')
    return defect.bannedFixes?.length
      ? [head, `    banned: ${defect.bannedFixes.join(', ')}`]
      : [head]
  })
}

/**
 * Source map rows as "<y>% <path>:<line>", with consecutive rows in the same
 * file collapsed into one "<y1>-<y2>% <path>:<l1>-<l2>" row.
 */
function renderSourceMap(sourceMap) {
  const runs = []
  for (const row of sourceMap) {
    const last = runs.at(-1)
    if (last && last.path === row.path) {
      last.yEnd = row.y
      last.lineMin = Math.min(last.lineMin, row.line)
      last.lineMax = Math.max(last.lineMax, row.line)
    } else {
      runs.push({ path: row.path, yStart: row.y, yEnd: row.y, lineMin: row.line, lineMax: row.line })
    }
  }
  const out = runs.slice(0, MAX_SOURCE_ROWS).map(run => {
    const height = run.yStart === run.yEnd ? `${run.yStart}%` : `${run.yStart}-${run.yEnd}%`
    return `${height} ${ref(run.path, run.lineMin, run.lineMax)}`
  })
  if (runs.length > MAX_SOURCE_ROWS) out.push(`… ${runs.length - MAX_SOURCE_ROWS} more`)
  return out
}

/** Blocks drawn on a page as "<id> <path>:<line>[-endLine]". */
function renderBlocks(blocks) {
  return blocks.map(block => `${block.id} ${where(block.path, block.line, block.endLine)}`)
}

const NO_BUILD_REASONS = {
  'validation-problems': 'Overleaf rejected the project',
  timedout: 'compile timed out',
}

/** The first line of a compile result: status, counts and build, or the reason there is none. */
function compileHeadline({ status, counts, buildId, attempts, clsiStatus }) {
  if (!buildId) {
    const reason = TRANSIENT_STATUSES.has(clsiStatus)
      ? `still busy after ${attempts} attempt(s)`
      : NO_BUILD_REASONS[clsiStatus] ?? `status "${clsiStatus}"`
    return `${status}: no build, ${reason}`
  }
  const head = `${status}: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.badBoxes} bad boxes  build ${buildId}`
  return attempts > 1 ? `${head}  (attempts ${attempts})` : head
}

/**
 * Advice lines, minus the ones the rendered errors, warnings and counts
 * already say.
 */
function adviceLines(advice, { errorCount, rerunNeeded, counts }) {
  return advice
    .filter(text => {
      if (/^Fix the errors from the top/.test(text)) return errorCount === 0
      if (/^LaTeX asked for another pass/.test(text)) return !rerunNeeded
      if (/^Undefined references/.test(text)) return counts.undefinedReferences === 0
      if (/^Undefined citations/.test(text)) return counts.undefinedCitations === 0
      return true
    })
    .map(text => `advice: ${text}`)
}

/**
 * The status a caller acts on.
 *
 * CLSI reports "success" whenever a PDF was written, even when LaTeX logged
 * errors on the way (it runs in non-stop mode). The parsed log is the only
 * place those errors appear, so a PDF with errors is reported as its own
 * status rather than as success. A build that reports failure but still wrote
 * a PDF (for example, a stop on the first error after pages were shipped out)
 * is also success_with_errors: the PDF exists and is wrong or incomplete.
 *
 * @param {string|undefined} clsiStatus the status the compile server reported
 * @param {number} errorCount errors counted in the parsed log
 * @param {boolean} [pdfProduced] whether output.pdf was written
 * @returns {string}
 */
export function compileStatus(clsiStatus, errorCount, pdfProduced = false) {
  if (clsiStatus === 'success') {
    return errorCount > 0 ? 'success_with_errors' : 'success'
  }
  if (clsiStatus === 'failure' || clsiStatus === 'stopped-on-first-error') {
    return pdfProduced ? 'success_with_errors' : 'failure'
  }
  return clsiStatus || 'unknown'
}

/**
 * Warnings for the status a caller acts on. The undefined references and
 * citations are listed in the text, so they are not repeated here.
 */
function compileWarnings({
  status,
  counts,
  logChecked,
  rerunNeeded,
  clsiStatus,
  validationProblems,
  attempts,
  logProblem,
}) {
  const warnings = []
  if (status === 'success_with_errors') {
    warnings.push(
      `Do not trust the PDF: the log has ${counts.errors} error(s). Fix them and compile again.`
    )
  }
  if (status === 'failure' && counts.errors === 0) {
    warnings.push(
      'No PDF and no parsed error: read the raw log with get_compile_log raw=true.'
    )
  }
  if (!logChecked && logProblem) {
    warnings.push(`Compile log unreadable (${logProblem}); errors unknown.`)
  }
  if (rerunNeeded) {
    warnings.push('LaTeX asked for another pass; compile again to settle references.')
  }
  if (validationProblems) {
    warnings.push('Overleaf rejected the project before compiling (see validation).')
  }
  if (TRANSIENT_STATUSES.has(clsiStatus)) {
    warnings.push(
      `Still "${clsiStatus}" after ${attempts} attempt(s). Wait a few seconds, then compile again.`
    )
  }
  return warnings
}

/** Next steps that are not already obvious from the text. */
function compileNextSteps({ status, buildId, rerunNeeded, logChecked, clsiStatus }) {
  const steps = []
  if (buildId && !logChecked) {
    steps.push('get_compile_log raw=true')
  }
  if (rerunNeeded && status !== 'failure') {
    steps.push('compile_project again to settle references')
  }
  if (status === 'success' && buildId) {
    // A clean log says nothing about how the pages look; checking them is
    // the step a model skips unless it is the obvious next one.
    steps.push('view_compiled_pdf_page page=<n> to check layout of changed pages')
  }
  if (TRANSIENT_STATUSES.has(clsiStatus)) {
    steps.push('compile_project again after a few seconds')
  }
  return steps
}

/**
 * Post a compile, retrying the statuses that clear by themselves: a compile
 * started within the last second, or one still running for this project.
 */
async function compileWithRetry(client, token, id, body, sleep) {
  let attempts = 0
  for (;;) {
    attempts++
    const result = await client.post(token, `/projects/${id}/compile`, body, {
      timeoutMs: COMPILE_TIMEOUT_MS,
    })
    if (
      !TRANSIENT_STATUSES.has(result.status) ||
      attempts >= MAX_COMPILE_ATTEMPTS
    ) {
      return { result, attempts }
    }
    await sleep(RETRY_BASE_MS * attempts)
  }
}

/**
 * Register the compile, log, PDF and word-count tools.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string, sleep?: (ms: number) => Promise<void> }} deps
 */
export function registerCompileTools(server, deps) {
  const { client, staticToken, sleep = sleepFor } = deps
  server.registerTool(
    'compile_project',
    {
      title: 'Compile project',
      description:
        'Compile the project and read its LaTeX and BibTeX logs, so errors are reported even when a PDF was produced. data.status is success, success_with_errors (PDF with log errors, so not trustworthy), failure, timedout, or a transient or setup status. Pass rootDocPath to compile another main file for one run.',
      // Read-only in the sense the annotation is about: compiling never
      // changes the project's content. The only thing it writes is Overleaf's
      // own build output, and clearCache discards exactly that. Labelling it a
      // write made clients that gate on readOnlyHint stop for a confirmation
      // on every compile, which is the step an edit-compile-fix loop repeats
      // most.
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        draft: z
          .boolean()
          .optional()
          .describe('Compile in draft mode (skips images)'),
        stopOnFirstError: z
          .boolean()
          .optional()
          .describe('Abort at the first LaTeX error instead of continuing'),
        clean: z
          .boolean()
          .optional()
          .describe('Clear auxiliary build files first when a build looks stale'),
        clearCache: z
          .boolean()
          .optional()
          .describe('Deprecated alias of clean'),
        rootDocPath: z
          .string()
          .optional()
          .describe('Main .tex to compile for this run, e.g. /thesis/main.tex'),
      }),
      outputSchema: envelope(
        looseObject({
          status: z
            .string()
            .describe(
              'success, success_with_errors, failure, timedout, or a transient or setup status'
            ),
          clsiStatus: z
            .string()
            .describe(
              'Status the compile server reported, before error checking'
            ),
          pdfProduced: z.boolean().describe('True when output.pdf was written'),
          buildId: z
            .string()
            .nullable()
            .describe('Build id for get_compile_log and get_compile_pdf'),
          clsiServerId: z
            .string()
            .nullable()
            .describe(
              'Pass to the log and PDF tools to read this build from the same compile server'
            ),
          rootDocPath: z
            .string()
            .nullable()
            .describe('The main file that was compiled'),
          attempts: z.number().int().describe('Compile requests sent'),
          logChecked: z
            .boolean()
            .describe(
              'False when the log could not be read, so errors are unknown'
            ),
          compiler: z
            .string()
            .optional()
            .describe('Compiler the project is set to'),
          pdf: looseObject({
            path: z.string(),
            build: z.string().optional(),
          })
            .nullable()
            .describe('The PDF, or null when none was written'),
          counts: countsSchema,
          errors: z
            .array(logEntry)
            .describe('Errors, in log order; fix the first one first'),
          errorsTruncated: z
            .boolean()
            .optional()
            .describe('True when more errors exist than are listed here'),
          warnings: z
            .array(logWarning)
            .describe(
              'Warnings, in log order; get_compile_log gives the raw log'
            ),
          badBoxes: z
            .array(badBox)
            .describe('A sample of overfull and underfull boxes'),
          rerunNeeded: z
            .boolean()
            .describe('True when LaTeX asked for another compile'),
          advice: z
            .array(z.string())
            .describe('What to do next, in plain words'),
          validationProblems: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Why Overleaf refused to compile, when status is validation-problems'
            ),
        })
      ),
    },
    runTool(async ({ projectId: id, clean, clearCache, ...options }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      if (clean === true || clearCache === true) {
        await client.post(token, `/projects/${id}/compile/clean`, {})
      }
      const { result, attempts } = await compileWithRetry(
        client,
        token,
        id,
        { ...definedOnly(options), diagnostics: true },
        sleep
      )

      const clsiStatus = result.status ?? 'unknown'
      const buildId = result.buildId ?? null
      const clsiServerId = result.clsiServerId ?? null
      const rootDocPath = result.rootDocPath ?? null
      const pdf = result.pdf ?? null

      // web returns the parsed log with the compile; the separate read is only
      // a fallback for when it did not.
      let diagnostics = result.diagnostics
        ? normaliseDiagnostics(result.diagnostics)
        : null
      let logError = null
      if (!diagnostics && buildId) {
        try {
          diagnostics = await fetchDiagnostics(client, token, id, {
            buildId,
            clsiserverid: clsiServerId,
            rootDocPath,
          })
        } catch (err) {
          logError =
            result.diagnosticsError || err?.message || 'the log could not be fetched'
        }
      }
      // A build with no output.log has no errors on record, but that is not
      // the same as checked and clean.
      const logChecked =
        diagnostics != null && diagnostics.logAvailable !== false
      const logProblem =
        logError ??
        (diagnostics && !logChecked ? 'the build wrote no output.log' : null)
      const counts = diagnostics?.counts ?? EMPTY_COUNTS
      const pdfProduced = result.pdfProduced ?? pdf != null
      const status = compileStatus(clsiStatus, counts.errors, pdfProduced)
      const errors = diagnostics?.errors ?? []
      const warnings = diagnostics?.warnings ?? []
      const rerunNeeded = diagnostics?.rerunNeeded ?? false

      const summary = compileHeadline({ status, counts, buildId, attempts, clsiStatus })
      const toolWarnings = compileWarnings({
        status,
        counts,
        logChecked,
        rerunNeeded,
        clsiStatus,
        validationProblems: result.validationProblems,
        attempts,
        logProblem,
      })
      const nextSteps = compileNextSteps({
        status,
        buildId,
        rerunNeeded,
        logChecked,
        clsiStatus,
      })
      const text = lines(
        renderErrorGroups(errors),
        renderLogWarnings(warnings),
        result.validationProblems &&
          `validation: ${compactJson(result.validationProblems)}`,
        adviceLines(diagnostics?.advice ?? [], {
          errorCount: errors.length,
          rerunNeeded,
          counts,
        })
      )

      return okResult({
        summary,
        text,
        data: {
          status,
          clsiStatus,
          pdfProduced,
          buildId,
          clsiServerId,
          rootDocPath,
          attempts,
          logChecked,
          ...(result.compiler ? { compiler: result.compiler } : {}),
          pdf,
          counts,
          errors,
          ...(diagnostics?.errorsTruncated ? { errorsTruncated: true } : {}),
          warnings,
          badBoxes: diagnostics?.badBoxes ?? [],
          rerunNeeded,
          advice: diagnostics?.advice ?? [],
          ...(result.validationProblems
            ? { validationProblems: result.validationProblems }
            : {}),
        },
        warnings: toolWarnings,
        nextSteps,
      })
    })
  )

  server.registerTool(
    'get_compile_log',
    {
      title: 'Get compile log',
      description:
        'Re-read a build without recompiling: by default the parsed errors, warnings and bad boxes; with raw=true the output.log text, in windows of maxLines lines.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe(
            'clsiServerId from compile_project, so the same compile server is read'
          ),
        level: z
          .enum(LOG_LEVELS)
          .optional()
          .describe('Parsed view: errors, warnings (with bad boxes) or all (default)'),
        raw: z
          .boolean()
          .optional()
          .describe('Return the raw log text instead of the parsed view'),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Raw view: first line, 1-based; defaults to the last maxLines lines'),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Raw view: lines to return; defaults to ${DEFAULT_LOG_LINES}`),
        grep: z
          .string()
          .min(1)
          .optional()
          .describe('Raw view: keep only lines containing this text, ignoring case'),
        rootDocPath: z
          .string()
          .optional()
          .describe('Parsed view: main file the build compiled, if not the root document'),
      }),
      outputSchema: envelope(
        looseObject({
          buildId: z.string(),
          raw: z.boolean(),
          level: z.enum(LOG_LEVELS).optional(),
          logAvailable: z.boolean().optional(),
          log: z.string().optional().describe('Raw view: the requested lines'),
          startLine: z.number().int().nullable().optional(),
          endLine: z.number().int().nullable().optional(),
          totalLines: z.number().int().optional(),
          truncated: z.boolean().optional(),
          counts: countsSchema.optional(),
          fatal: z.boolean().optional(),
          rerunNeeded: z.boolean().optional(),
          advice: z.array(z.string()).optional(),
          errors: z.array(logEntry).optional(),
          warnings: z.array(logWarning).optional(),
          badBoxes: z.array(badBox).optional(),
        })
      ),
    },
    runTool(
      async (
        {
          projectId: id,
          buildId,
          clsiServerId,
          level = 'all',
          raw,
          startLine,
          maxLines,
          grep,
          rootDocPath,
        },
        ctx
      ) => {
        const token = tokenFrom(ctx, staticToken)
        if (raw) {
          const page = await client.get(token, `/projects/${id}/compile/log`, {
            buildId,
            clsiserverid: clsiServerId,
            fromLine: startLine,
            maxLines: maxLines ?? DEFAULT_LOG_LINES,
          })
          const log = page.log ?? ''
          const total = page.totalLines ?? 0
          const more = page.endLine != null && page.endLine < total
          const first = page.startLine ?? 1
          const shown =
            page.startLine != null
              ? `log lines ${page.startLine}-${page.endLine}/${total}`
              : `no log lines (total ${total})`
          let text = log
          let matched = ''
          if (grep) {
            const needle = grep.toLowerCase()
            const hits = []
            log.split('\n').forEach((line, index) => {
              if (line.toLowerCase().includes(needle)) {
                hits.push(`${first + index}: ${line}`)
              }
            })
            text = hits.join('\n')
            matched = `, ${hits.length} match(es)`
          }
          return okResult({
            summary: `${shown}${matched}`,
            text,
            data: {
              buildId: page.buildId ?? buildId,
              raw: true,
              log: page.log,
              startLine: page.startLine ?? null,
              endLine: page.endLine ?? null,
              totalLines: page.totalLines,
              truncated: page.truncated,
            },
            nextSteps: more
              ? [`get_compile_log${pinned(buildId)} raw=true startLine=${page.endLine + 1}`]
              : undefined,
          })
        }

        const diag = await fetchDiagnostics(client, token, id, {
          buildId,
          clsiserverid: clsiServerId,
          rootDocPath,
        })
        const { counts } = diag
        const include = {
          errors: level === 'all' || level === 'errors',
          warnings: level === 'all' || level === 'warnings',
          badBoxes: level === 'all' || level === 'warnings',
        }
        const warnings = []
        if (!diag.logAvailable) {
          warnings.push(
            'This build has no output.log, so the compile may not have run.'
          )
        }
        if (diag.logTruncated) {
          warnings.push(
            'The log is larger than 8 MB; entries after that point were not read.'
          )
        }
        if (diag.errorsTruncated) {
          warnings.push(
            'More errors exist than are listed; the first 200 are shown.'
          )
        }
        if (diag.warningsTruncated) {
          warnings.push(
            'More warnings exist than are listed; the first 300 are shown.'
          )
        }
        return okResult({
          summary: `${counts.errors} errors, ${counts.warnings} warnings, ${counts.badBoxes} bad boxes${level === 'all' ? '' : ` (showing ${level})`}`,
          text: lines(
            include.errors ? renderErrorGroups(diag.errors) : null,
            include.warnings ? renderLogWarnings(diag.warnings ?? []) : null,
            include.badBoxes
              ? renderBadBoxes(diag.badBoxes ?? [], { width: Infinity })
              : null
          ),
          data: {
            buildId: diag.buildId ?? buildId,
            raw: false,
            level,
            logAvailable: diag.logAvailable,
            counts,
            fatal: diag.fatal,
            rerunNeeded: diag.rerunNeeded,
            advice: diag.advice,
            ...(include.errors ? { errors: diag.errors } : {}),
            ...(include.warnings ? { warnings: diag.warnings } : {}),
            ...(include.badBoxes ? { badBoxes: diag.badBoxes } : {}),
          },
          warnings,
        })
      }
    )
  )

  server.registerTool(
    'get_compile_pdf',
    {
      title: 'Download compiled PDF',
      description:
        'Download the whole PDF of a build as a binary resource, to hand over or save. To look at pages, use view_compiled_pdf_page; a failed build has no PDF.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe(
            'clsiServerId from compile_project, so the same compile server is read'
          ),
      }),
      outputSchema: envelope(
        looseObject({
          ...binaryFields,
          projectId: z.string().describe('The project the PDF was built from'),
          buildId: z
            .string()
            .nullable()
            .describe('The build the PDF was produced by, or null when the latest was used'),
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, clsiServerId }, ctx) => {
      const { contentType, base64 } = await client.requestBinary(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf`,
        { buildId, clsiserverid: clsiServerId }
      )
      const uri = `overleaf://projects/${id}/builds/${buildId ?? 'latest'}/output.pdf`
      const sizeBytes = Buffer.byteLength(base64, 'base64')
      return withBlocks(
        okResult({
          summary: `PDF: ${sizeBytes} bytes`,
          text: '',
          data: {
            projectId: id,
            buildId: buildId ?? null,
            uri,
            mimeType: contentType,
            sizeBytes,
          },
        }),
        [
          {
            type: 'resource',
            resource: {
              uri,
              mimeType: contentType,
              blob: base64,
            },
          },
        ]
      )
    })
  )

  server.registerTool(
    'get_word_count',
    {
      title: 'Get word count',
      description:
        'Count words in the project or one document, with the TeX-aware counter Overleaf uses in the editor. Headings, maths and captions are counted separately from body text.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z
          .string()
          .optional()
          .describe('Count one document instead, e.g. /chapters/intro.tex'),
      }),
      outputSchema: envelope(
        looseObject({
          scope: z.string().describe('The file counted, or "project"'),
          textWords: z.number().optional().describe('Words in body text'),
          headWords: z.number().optional().describe('Words in headings'),
          outside: z
            .number()
            .optional()
            .describe('Words outside the document body'),
          headers: z.number().optional().describe('Number of headers'),
          elements: z
            .number()
            .optional()
            .describe('Number of floats and other elements'),
          mathInline: z
            .number()
            .optional()
            .describe('Inline maths expressions'),
          mathDisplay: z
            .number()
            .optional()
            .describe('Displayed maths expressions'),
          errors: z
            .number()
            .optional()
            .describe('Errors the counter encountered'),
          encode: z.string().optional().describe('Character encoding assumed'),
          messages: z
            .string()
            .optional()
            .describe('Warnings emitted by the counter'),
        })
      ),
    },
    runTool(async ({ projectId: id, path }, ctx) => {
      const file = path ? normalisePath(path) : undefined
      const { wordCount } = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/wordcount`,
        { file }
      )
      const counts = wordCount ?? {}
      const scope = file || 'project'
      const warnings = []
      if (counts.errors > 0) {
        warnings.push(
          `Word counter: ${counts.errors} error(s)${counts.messages ? `: ${counts.messages}` : ''}; the count may be low.`
        )
      }
      const parts = [
        ['body', counts.textWords],
        ['headings', counts.headWords],
        ['outside', counts.outside],
        ['captions/floats', counts.elements],
        ['inline math', counts.mathInline],
        ['display math', counts.mathDisplay],
      ]
      return okResult({
        summary: `${scope}: ${counts.textWords ?? 0} words`,
        text: parts
          .filter(([, value]) => value)
          .map(([label, value]) => `${label} ${value}`)
          .join(', '),
        data: { scope, ...counts },
        warnings,
      })
    })
  )
  server.registerTool(
    'sync_pdf_source',
    {
      title: 'Map PDF pages to source lines',
      description:
        'Text-only SyncTeX lookup on the latest build, nothing rendered. Give page (and optionally x and y) to get the source lines that produced it, or path and line to get the pages where that line appears. To see the page, use view_compiled_pdf_page.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('PDF page, 1-based; give this or path and line'),
        x: z
          .number()
          .min(0)
          .optional()
          .describe('Points from the left edge (A4 is 595 wide)'),
        y: z
          .number()
          .min(0)
          .optional()
          .describe('Points from the top edge (A4 is 842 tall)'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Source document, e.g. /chapters/intro.tex; give with line'),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based line in path'),
        buildId: z
          .string()
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project, so the same compile server is read'),
      }),
      outputSchema: envelope(
        looseObject({
          direction: z
            .enum(['pdf_to_source', 'source_to_pdf'])
            .describe('Which way the lookup went'),
          sourceLines: z
            .array(
              looseObject({
                path: z.string().describe('Project path of the source document'),
                line: z.number().int().describe('1-based source line'),
              })
            )
            .optional()
            .describe('pdf_to_source: source lines found, in reading order'),
          ranges: z
            .array(
              looseObject({
                path: z.string(),
                startLine: z.number().int(),
                endLine: z.number().int(),
              })
            )
            .optional()
            .describe('pdf_to_source: line span per document, ready for read_file'),
          pdfPositions: z
            .array(
              looseObject({
                page: z.number().int().describe('1-based PDF page'),
                x: z.number().describe('Points from the left edge'),
                y: z.number().describe('Points from the top edge'),
              })
            )
            .optional()
            .describe('source_to_pdf: where the line appears in the PDF'),
        })
      ),
    },
    runTool(async ({ projectId: id, page, x, y, path, line, buildId, clsiServerId }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const common = { buildId, clsiserverid: clsiServerId }
      const toPdf = page == null
      if (toPdf && (path == null || line == null)) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'give page (PDF to source) or both path and line (source to PDF)',
          400
        )
      }

      if (toPdf) {
        const file = bare(path)
        const { synctex } = await client.get(token, `/projects/${id}/synctex`, {
          ...common,
          file,
          line,
          column: 0,
        })
        const pdfPositions = (synctex?.pdf ?? []).map(p => ({
          page: p.page,
          x: p.h,
          y: p.v,
        }))
        const pages = [...new Set(pdfPositions.map(p => p.page))]
        return okResult({
          summary: pdfPositions.length
            ? `/${file} line ${line} is on page ${pages.join(', ')}`
            : `/${file} line ${line} is not in the PDF; it may produce no output, or the build is stale.`,
          text: pdfPositions
            .map(p => `page ${p.page} x${Math.round(p.x)} y${Math.round(p.y)}`)
            .join('\n'),
          data: { direction: 'source_to_pdf', pdfPositions },
          nextSteps: pdfPositions.length ? undefined : ['compile_project again, then retry'],
        })
      }

      // One spot when x/y are given; otherwise sample down the page so the
      // result covers everything typeset on it.
      const spots =
        x != null || y != null
          ? [{ h: x ?? 300, v: y ?? 400 }]
          : SYNCTEX_PAGE_SAMPLES.map(v => ({ h: 300, v }))
      const results = await Promise.all(
        spots.map(({ h, v }) =>
          client
            .get(token, `/projects/${id}/synctex`, { ...common, page, h, v })
            .then(r => r?.synctex?.code ?? [])
            .catch(err => {
              if (spots.length === 1) throw err
              return []
            })
        )
      )
      const seen = new Set()
      const sourceLines = []
      for (const entry of results.flat()) {
        if (!entry?.file || !Number.isInteger(entry.line) || entry.line < 1) continue
        const sourcePath = `/${String(entry.file).replace(/^(\.\/|\/)+/, '')}`
        const key = `${sourcePath}:${entry.line}`
        if (seen.has(key)) continue
        seen.add(key)
        sourceLines.push({ path: sourcePath, line: entry.line })
      }
      const spans = new Map()
      for (const { path: p, line: l } of sourceLines) {
        const span = spans.get(p)
        if (!span) spans.set(p, { path: p, startLine: l, endLine: l })
        else {
          span.startLine = Math.min(span.startLine, l)
          span.endLine = Math.max(span.endLine, l)
        }
      }
      const ranges = [...spans.values()]
      return okResult({
        summary: ranges.length
          ? `Page ${page}: ${ranges.length} source span(s)`
          : `No source found for page ${page}; the page may not exist, or the build is stale.`,
        text: ranges
          .map(r => ref(r.path, r.startLine, r.endLine))
          .join('\n'),
        data: { direction: 'pdf_to_source', sourceLines, ranges },
        nextSteps: ranges.length
          ? [
              `read_file path=${ranges[0].path} startLine=${ranges[0].startLine} endLine=${ranges[0].endLine}`,
            ]
          : ['compile_project again, then retry'],
      })
    })
  )

  server.registerTool(
    'diff_compiled_pdf',
    {
      title: 'Diff two compiled PDFs',
      description:
        'Compare a build pixel by pixel with the build before it, to see what a fix changed and confirm nothing else moved. Returns the changed pages, their regions, and one image of the newer build with the changes boxed.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Newer build id from compile_project; defaults to the latest build'),
        beforeBuildId: z
          .string()
          .min(1)
          .optional()
          .describe('Older build id; defaults to the build compiled before buildId'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project for the newer build'),
      }),
      outputSchema: envelope(
        looseObject({
          beforeBuildId: z.string(),
          afterBuildId: z.string(),
          changed: z.boolean().describe('True when any page differs'),
          pairing: z.string().optional().describe('index or text'),
          dpi: z.number().optional(),
          pageCount: looseObject({
            before: z.number().int(),
            after: z.number().int(),
          }).optional(),
          pages: z
            .array(looseObject({ page: z.number().int() }))
            .describe('The pages that changed, with their regions and summary'),
          unchangedPages: z.array(z.number().int()),
          summary: z.array(z.string()),
          truncated: z.boolean().optional(),
          image: imageSchema.nullable().optional(),
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, beforeBuildId, clsiServerId }, ctx) => {
      const diff = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf-diff`,
        { buildId, beforeBuildId, clsiserverid: clsiServerId }
      )
      const pages = slashPaths(diff.pages ?? [])
      const images = imagesOf(diff)
      const changedPages = pages.map(p => p.page)
      const summary = changedPages.length
        ? `${changedPages.length} of ${diff.pageCount?.after ?? '?'} page(s) changed`
        : 'No page changed'
      const summaryLines = diff.summary ?? []
      const text = lines(
        summaryLines.length || !changedPages.length
          ? summaryLines
          : `changed: ${numberRuns(changedPages)}`,
        diff.unchangedPages?.length
          ? `unchanged: ${numberRuns(diff.unchangedPages)}`
          : null
      )
      const warnings = []
      if (diff.truncated) {
        warnings.push('Only the first pages were compared; the rest are not in this diff.')
      }
      const nextSteps = []
      if (changedPages.length) {
        nextSteps.push(
          `view_compiled_pdf_page page=${changedPages[0]}${pinned(buildId)} to see the change at full size`
        )
      }
      return withBlocks(
        okResult({
          summary,
          text,
          data: {
            beforeBuildId: diff.beforeBuildId,
            afterBuildId: diff.afterBuildId,
            changed: diff.changed === true,
            ...(diff.pairing ? { pairing: diff.pairing } : {}),
            ...(diff.dpi ? { dpi: diff.dpi } : {}),
            ...(diff.pageCount ? { pageCount: diff.pageCount } : {}),
            pages,
            unchangedPages: diff.unchangedPages ?? [],
            summary: diff.summary ?? [],
            ...(diff.truncated ? { truncated: true } : {}),
            image: images[0] ? imageMeta(images[0]) : null,
          },
          warnings,
          nextSteps,
        }),
        imageBlocks(images)
      )
    })
  )

  server.registerTool(
    'view_compiled_pdf_page',
    {
      title: 'View compiled PDF page',
      description:
        'See one page of a compiled PDF as an image, the way the user sees it; the log cannot show overlaps, overflowing tables or floats far from their text. Use it after a compile that changed what a page shows, before saying the result looks right. Select by page, or by path and line (add endLine for a block such as a table or figure, shown magnified); region zooms into a third of the page, maxEdgePx sets the image size, split halves sends top and bottom images, and labels draws block ids for resolve_pdf_block.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe(
            'clsiServerId from compile_project, so the same compile server is read'
          ),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('PDF page, 1-based; defaults to 1 unless path and line are given'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Source document, e.g. /chapters/results.tex; with line, shows where it is typeset'),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based line in path, as read_file numbers it'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('With path and line: last line of the block, e.g. the \\end{tabular} line'),
        region: z
          .enum(PAGE_REGIONS)
          .optional()
          .describe('full (default), or top, middle, bottom: zoom into that third'),
        maxEdgePx: z
          .number()
          .int()
          .min(MIN_PAGE_MAX_EDGE_PX)
          .optional()
          .describe(
            `Longest image side in pixels, at least ${MIN_PAGE_MAX_EDGE_PX}; default ${DEFAULT_PAGE_MAX_EDGE_PX}`
          ),
        grayscale: z
          .boolean()
          .optional()
          .describe('Grayscale; defaults to true, or false when endLine zooms on a block'),
        split: z
          .enum(PAGE_SPLITS)
          .optional()
          .describe('none (default), or halves: top and bottom images for small print'),
        labels: z
          .boolean()
          .optional()
          .describe('Draw block ids [B1], [B2], ... in a margin strip'),
      }),
      outputSchema: envelope(
        looseObject({
          buildId: z.string().describe('The build the page was rendered from'),
          page: z.number().int().describe('The PDF page shown, 1-based'),
          pageCount: z
            .number()
            .int()
            .nullable()
            .describe('Pages in the PDF'),
          pageSize: looseObject({
            width: z.number(),
            height: z.number(),
          })
            .nullable()
            .describe('Page size in PDF points'),
          region: z.enum(PAGE_REGIONS).describe('The part of the page shown'),
          span: looseObject({
            top: z.number(),
            bottom: z.number(),
          }).describe('The rendered part of the page, % of its height from the top'),
          located: looseObject({
            path: z.string(),
            line: z.number().int(),
            y: z.number().describe('% of the page height from the top'),
          })
            .nullable()
            .describe('With path and line: where that line is typeset'),
          sourceMap: z
            .array(
              looseObject({
                y: z.number().describe('Height on the page, % from the top'),
                path: z.string(),
                line: z.number().int(),
              })
            )
            .describe('Source line typeset at each height, top to bottom'),
          sourceRanges: z
            .array(
              looseObject({
                path: z.string(),
                startLine: z.number().int(),
                endLine: z.number().int(),
              })
            )
            .describe('Line span per document on this page, ready for read_file'),
          badBoxes: z
            .array(badBox)
            .describe('Overfull and underfull boxes reported on this page'),
          sourceStatus: z
            .string()
            .optional()
            .describe(
              'mapped, no_synctex, probe_missed, line_not_in_build or page_without_source: how far the sourceMap can be trusted'
            ),
          sourceNote: z
            .string()
            .optional()
            .describe('Plain-words reason when sourceStatus is not mapped'),
          stale: staleSchema,
          image: looseObject({
            mimeType: z.string(),
            width: z.number().int().optional(),
            height: z.number().int().optional(),
            dpi: z.number().optional(),
            sizeBytes: z.number().int(),
          }).describe('The first image content block that comes with this result'),
          images: z
            .array(imageSchema)
            .describe('Every image content block that comes with this result, in order'),
          blocks: z
            .array(blockSchema)
            .optional()
            .describe('Block ids drawn on the image, with their source, when labels is set'),
          defects: z
            .array(defectSchema)
            .optional()
            .describe('Structured problems on this page, when defect records are on'),
        })
      ),
    },
    runTool(
      async (
        {
          projectId: id,
          buildId,
          clsiServerId,
          page,
          path,
          line,
          endLine,
          region,
          maxEdgePx,
          grayscale,
          split,
          labels,
        },
        ctx
      ) => {
        if (page == null && path != null && line == null) {
          throw new OverleafApiError(
            CODES.VALIDATION_ERROR,
            'give line with path, or give page',
            400
          )
        }
        if (endLine != null && (page != null || path == null)) {
          throw new OverleafApiError(
            CODES.VALIDATION_ERROR,
            'endLine needs path and line, and no page',
            400
          )
        }
        const zoomsOnBlock = endLine != null
        const shown = await client.get(
          tokenFrom(ctx, staticToken),
          `/projects/${id}/compile/pdf-page`,
          {
            buildId,
            clsiserverid: clsiServerId,
            page,
            path: page == null && path != null ? bare(path) : undefined,
            line: page == null ? line : undefined,
            endLine: page == null && endLine != null ? endLine : undefined,
            region,
            maxEdgePx: maxEdgePx ?? DEFAULT_PAGE_MAX_EDGE_PX,
            grayscale: String(grayscale ?? !zoomsOnBlock),
            split: split ?? 'none',
            labels: labels ? 'true' : undefined,
          }
        )

        const sourceMap = slashPaths(shown.sourceMap ?? [])
        const sourceRanges = slashPaths(shown.sourceRanges ?? [])
        const badBoxes = slashPaths(shown.badBoxes ?? [])
        const located = shown.located
          ? { ...shown.located, path: slashed(shown.located.path) }
          : null
        const images = imagesOf(shown)
        const stale = staleOf(shown)
        const sourceStatus = shown.sourceStatus ?? null
        const sourceNote = shown.sourceNote ?? null

        const of = shown.pageCount ? `/${shown.pageCount}` : ''
        const zoom =
          shown.region && shown.region !== 'full'
            ? ` (${shown.region} third, zoomed)`
            : zoomsOnBlock
              ? ' (zoomed on the block)'
              : ''
        const attached = attachedText(images)
        const warnings = []
        if (stale) warnings.push(staleWarning(stale))
        const nextSteps = sourceRanges.length
          ? [
              `read_file path=${sourceRanges[0].path} startLine=${sourceRanges[0].startLine} endLine=${sourceRanges[0].endLine} to fix what the image shows`,
              `compile_project, then view_compiled_pdf_page page=${shown.page} with the new build`,
            ]
          : undefined

        const blocks = slashPaths(shown.blocks ?? [])
        const defects = slashPaths(shown.defects ?? [])
        const text = lines(
          located && `located ${ref(located.path, located.line)} at ${located.y}%`,
          sourceMap.length > 0
            ? ['source:', renderSourceMap(sourceMap)]
            : sourceRanges.length > 0 &&
              ['source:', sourceRanges.map(r => ref(r.path, r.startLine, r.endLine))],
          renderBadBoxes(badBoxes, { width: BAD_BOX_WIDTH }),
          sourceStatus &&
            sourceStatus !== 'mapped' &&
            `sourceStatus: ${sourceStatus}${sourceNote ? `. ${sourceNote}` : ''}`,
          blocks.length > 0 && renderBlocks(blocks),
          defects.length > 0 && renderDefects(defects)
        )

        return withBlocks(
          okResult({
            summary: `${stale ? staleSummary(stale) : ''}Page ${shown.page}${of}${zoom} ${attached}`,
            text,
            data: {
              buildId: shown.buildId ?? buildId,
              page: shown.page,
              pageCount: shown.pageCount ?? null,
              pageSize: shown.pageSize ?? null,
              region: shown.region ?? 'full',
              span: shown.span ?? { top: 0, bottom: 100 },
              located,
              sourceMap,
              sourceRanges,
              badBoxes,
              sourceStatus: sourceStatus ?? 'mapped',
              ...(sourceNote ? { sourceNote } : {}),
              ...(stale ? { stale } : {}),
              image: imageMeta(images[0] ?? {}),
              images: images.map(imageMeta),
              ...(blocks.length ? { blocks } : {}),
              ...(defects.length ? { defects } : {}),
            },
            warnings,
            nextSteps,
          }),
          imageBlocks(images)
        )
      }
    )
  )

  server.registerTool(
    'resolve_pdf_block',
    {
      title: 'Find a PDF block',
      description:
        'Turn a block id drawn on a page image (B1, B2, ...) by view_compiled_pdf_page with labels into its source file and lines.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project'),
        page: z
          .number()
          .int()
          .min(1)
          .describe('The PDF page the block id was drawn on'),
        blockId: z
          .string()
          .regex(/^B\d+$/)
          .describe('Block id as drawn, e.g. B3'),
      }),
      outputSchema: envelope(
        looseObject({
          blockId: z.string(),
          page: z.number().int(),
          path: z.string(),
          line: z.number().int(),
          endLine: z.number().int().optional(),
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, clsiServerId, page, blockId }, ctx) => {
      const block = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf-block`,
        { buildId, clsiserverid: clsiServerId, page, blockId }
      )
      const path = slashed(block.path)
      return okResult({
        summary: `typeset at ${ref(path, block.line, block.endLine)}`,
        text: '',
        data: {
          blockId,
          page,
          path,
          line: block.line,
          ...(block.endLine ? { endLine: block.endLine } : {}),
        },
        nextSteps: [
          `read_file path=${path} startLine=${block.line} endLine=${block.endLine ?? block.line}`,
        ],
      })
    })
  )

  server.registerTool(
    'view_compiled_pdf_overview',
    {
      title: 'View compiled PDF overview',
      description:
        'See up to 12 pages of a compiled PDF as thumbnails in one image, with the paper, fonts, and each page\'s source files and problems. Thumbnails are too small to read text; open a page with view_compiled_pdf_page.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project'),
        fromPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First page, 1-based; defaults to 1'),
        toPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Last page; at most 12 per call, defaults to fromPage + 11'),
      }),
      outputSchema: envelope(
        looseObject({
          buildId: z.string(),
          fromPage: z.number().int(),
          toPage: z.number().int(),
          pageCount: z.number().int().nullable(),
          paper: looseObject({
            width: z.number(),
            height: z.number(),
            name: z.string().optional(),
            orientation: z.string().optional(),
          }).nullable(),
          mixedSizes: z.boolean().optional(),
          fonts: looseObject({
            total: z.number().optional(),
            notEmbedded: z.array(z.unknown()).optional(),
            type3: z.array(z.unknown()).optional(),
          }).optional(),
          pages: z
            .array(looseObject({ page: z.number().int() }))
            .describe('Per page: source, blank, endsAt, gaps, overflow, badBoxes, unresolved'),
          image: imageSchema.nullable().optional(),
          images: z.array(imageSchema).optional(),
          sourceStatus: z.string().optional(),
          stale: staleSchema,
          defects: z.array(defectSchema).optional(),
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, clsiServerId, fromPage, toPage }, ctx) => {
      const shown = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf-overview`,
        { buildId, clsiserverid: clsiServerId, fromPage, toPage }
      )
      const pages = slashPaths(shown.pages ?? [])
      const images = imagesOf(shown)
      const stale = staleOf(shown)
      const defects = slashPaths(shown.defects ?? [])
      const warnings = []
      if (stale) warnings.push(staleWarning(stale))
      const from = shown.fromPage ?? fromPage ?? 1
      const to = shown.toPage ?? from
      const of = shown.pageCount ? `/${shown.pageCount}` : ''
      const attached = attachedText(images)
      const paper = shown.paper
        ? `paper ${shown.paper.name ?? `${shown.paper.width}x${shown.paper.height}`}${shown.paper.orientation ? ` ${shown.paper.orientation}` : ''}`
        : null
      const fontNames = list => list.map(font => (typeof font === 'string' ? font : font?.name ?? compactJson(font)))
      const fonts = shown.fonts ?? {}
      const text = lines(
        paper,
        shown.mixedSizes === true && 'mixed page sizes',
        fonts.notEmbedded?.length > 0 && `fonts not embedded: ${fontNames(fonts.notEmbedded).join(', ')}`,
        fonts.type3?.length > 0 && `fonts type 3: ${fontNames(fonts.type3).join(', ')}`,
        shown.sourceStatus &&
          shown.sourceStatus !== 'mapped' &&
          `sourceStatus: ${shown.sourceStatus}`,
        pages.map(renderOverviewPage),
        defects.length > 0 && renderDefects(defects)
      )
      const nextSteps = pages.some(p => p.blank || p.overflow?.length)
        ? [`view_compiled_pdf_page page=<a page above>${pinned(buildId)} to see the problem at full size`]
        : undefined
      return withBlocks(
        okResult({
          summary: `${stale ? staleSummary(stale) : ''}Pages ${from}-${to}${of} ${attached}`,
          text,
          data: {
            buildId: shown.buildId ?? buildId,
            fromPage: from,
            toPage: to,
            pageCount: shown.pageCount ?? null,
            paper: shown.paper ?? null,
            ...(shown.mixedSizes !== undefined ? { mixedSizes: shown.mixedSizes } : {}),
            ...(shown.fonts ? { fonts: shown.fonts } : {}),
            ...(shown.columns !== undefined ? { columns: shown.columns } : {}),
            pages,
            sourceStatus: shown.sourceStatus ?? 'mapped',
            ...(stale ? { stale } : {}),
            ...(defects.length ? { defects } : {}),
            image: images[0] ? imageMeta(images[0]) : null,
            images: images.map(imageMeta),
          },
          warnings,
          nextSteps,
        }),
        imageBlocks(images)
      )
    })
  )

  server.registerTool(
    'search_compiled_pdf',
    {
      title: 'Search compiled PDF text',
      description: [
        'Find text in the compiled PDF as the reader sees it, after macros, \\ref, \\cite and numbering are resolved, with each match\'s page, height and source file:line. Use it to find ?? and [?] markers, or the page of a caption or equation; search_text searches the .tex source instead.',
        'Matching ignores case, line breaks and hyphenation.',
      ].join('\n'),
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe('Build id from compile_project; defaults to the latest build'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project'),
        query: z
          .string()
          .min(1)
          .describe('Text as it appears in the PDF, e.g. "Figure 3" or "??"; not a regex'),
        fromPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Search from this page, 1-based; defaults to the start'),
        toPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Search up to this page, 1-based; defaults to the end'),
      }),
      outputSchema: envelope(
        looseObject({
          query: z.string(),
          fromPage: z.number().int(),
          toPage: z.number().int(),
          pageCount: z.number().int().nullable(),
          matchCount: z.number().int(),
          pages: z.array(z.number().int()),
          matches: z.array(
            looseObject({
              page: z.number().int(),
              y: z.number().nullable().describe('Height on the page, % from the top'),
              text: z.string(),
              context: z.string().optional(),
              path: z.string().nullable(),
              line: z.number().int().nullable(),
            })
          ),
          truncated: z.boolean(),
          sourceStatus: z.string().optional(),
          stale: staleSchema,
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, clsiServerId, query, fromPage, toPage }, ctx) => {
      const found = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf-search`,
        { buildId, clsiserverid: clsiServerId, query, fromPage, toPage }
      )
      const matches = slashPaths(found.matches ?? [])
      const stale = staleOf(found)
      const first = matches[0]
      const hits = found.matchCount ?? matches.length
      const summary = hits
        ? `${hits} matches on pages ${numberRuns(found.pages ?? [])}${found.truncated ? `; first ${matches.length} located` : ''}`
        : 'No matches'
      const text = matches
        .map(match => {
          const at = [
            `p${match.page}`,
            match.y != null ? `${Math.round(match.y)}%` : null,
            match.path ? ref(match.path, match.line) : null,
          ]
            .filter(Boolean)
            .join(' ')
          const context = match.context ? ` | ${clip(match.context, 100)}` : ''
          return `${at}  ${match.text}${context}`
        })
        .join('\n')
      return okResult({
        summary: `${stale ? staleSummary(stale) : ''}${summary}`,
        text,
        data: {
          query,
          fromPage: found.fromPage ?? fromPage ?? 1,
          toPage: found.toPage ?? toPage ?? found.pageCount ?? null,
          pageCount: found.pageCount ?? null,
          matchCount: hits,
          pages: found.pages ?? [],
          matches,
          truncated: found.truncated ?? false,
          sourceStatus: found.sourceStatus ?? 'mapped',
          ...(stale ? { stale } : {}),
        },
        warnings: stale ? [staleWarning(stale)] : undefined,
        nextSteps: first
          ? [`view_compiled_pdf_page page=${first.page}${pinned(buildId)} to see the match`]
          : undefined,
      })
    })
  )
}

const imageSchema = looseObject({
  part: z.string().optional().describe('full, or top and bottom when split is halves'),
  mimeType: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  dpi: z.number().optional(),
  sizeBytes: z.number().int(),
})

const blockSchema = looseObject({
  id: z.string(),
  page: z.number().int(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  endLine: z.number().int().nullable().optional(),
  text: z.string().optional(),
})

const defectSchema = looseObject({
  id: z.string(),
  category: z.string(),
  // Font defects are about the document, not a page; overview defects have no block.
  page: z.number().int().nullable().optional(),
  blockId: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  severity: z.string(),
  evidence: z.string(),
  bannedFixes: z.array(z.string()).optional(),
})

const staleSchema = looseObject({
  reason: z.string().describe('docs_changed, compiler_changed or root_changed'),
  changed: z.array(z.string()).describe('Project paths that changed since the build'),
})
  .nullable()
  .optional()
  .describe('Set when the project changed after this build, so the PDF is out of date')

/** Every `path` in a web result, as a "/"-prefixed project path. */
function slashPaths(value) {
  if (Array.isArray(value)) return value.map(slashPaths)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === 'path' && typeof v === 'string' ? slashed(v) : slashPaths(v),
      ])
    )
  }
  return value
}

/** The image blocks of a web result: `images` when present, else the single `image`. */
function imagesOf(shown) {
  if (Array.isArray(shown.images) && shown.images.length) {
    return shown.images.map(img => ({
      part: 'full',
      ...img,
      mimeType: img.mimeType ?? img.mediaType,
    }))
  }
  if (shown.image?.data) {
    return [
      {
        part: 'full',
        ...shown.image,
        mimeType: shown.image.mimeType ?? shown.image.mediaType,
      },
    ]
  }
  return []
}

function imageMeta(image) {
  return {
    ...(image.part && image.part !== 'full' ? { part: image.part } : {}),
    mimeType: image.mimeType,
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    dpi: image.dpi,
    sizeBytes:
      image.bytes ??
      image.sizeBytes ??
      Buffer.byteLength(String(image.data ?? ''), 'base64'),
  }
}

function imageBlocks(images) {
  return images.map(image => ({
    type: 'image',
    data: image.data,
    mimeType: image.mimeType,
  }))
}

/** How a result describes its attached images: "attached" or "attached as N images". */
function attachedText(images) {
  return images.length > 1 ? `attached as ${images.length} images` : 'attached'
}

/** The stale marker a web result carries, with paths as project paths. */
function staleOf(shown) {
  if (!shown.stale) return null
  return {
    reason: shown.stale.reason,
    changed: (shown.stale.changed ?? []).map(slashed),
  }
}

function staleSummary(stale) {
  return `OUT OF DATE (${stale.reason}): the old build, not the current source; `
}

function staleWarning(stale) {
  const changed = stale.changed.length
    ? ` Changed since the build: ${stale.changed.join(', ')}.`
    : ''
  return `The PDF is out of date (${stale.reason}).${changed} Compile again before judging the layout or the text.`
}

/** Page fields an overview line already renders; any other field is shown as JSON. */
const OVERVIEW_PAGE_FIELDS = new Set([
  'page',
  'source',
  'blank',
  'endsAt',
  'gaps',
  'overflow',
  'badBoxes',
  'worstBadBox',
  'unresolved',
  'sourceStatus',
  'sourceNote',
])

/**
 * One overview line per page: "p<n>  <source ranges>  <problems>". Problems
 * are the things a reader acts on: blank, margin overflow, bad boxes, broken
 * refs and cites, how far down the page the body ends, and gaps.
 */
function renderOverviewPage(page) {
  const source = (page.source ?? []).map(s => ref(s.path, s.startLine, s.endLine))
  const problems = []
  if (page.blank) problems.push('blank')
  if (page.overflow?.length) {
    const sides = [...new Set(page.overflow.map(o => o.side).filter(Boolean))]
    problems.push(sides.length ? `overflow ${sides.join('/')}` : 'overflow')
  }
  if (page.badBoxes) problems.push(`badBoxes ${page.badBoxes}`)
  if (page.unresolved?.refs) problems.push(`?? ${page.unresolved.refs}`)
  if (page.unresolved?.cites) problems.push(`[?] ${page.unresolved.cites}`)
  if (typeof page.endsAt === 'number') problems.push(`ends at ${page.endsAt}%`)
  for (const gap of page.gaps ?? []) {
    problems.push(`gap ${gap.top}-${gap.bottom}%`)
  }
  if (page.worstBadBox) {
    const worst = page.worstBadBox
    problems.push(
      `worst ${where(slashed(worst.path), worst.line)} ${clip(worst.message ?? '', BAD_BOX_WIDTH)}`
    )
  }
  if (page.sourceStatus && page.sourceStatus !== 'mapped') {
    problems.push(`sourceStatus ${page.sourceStatus}`)
  }
  const extra = Object.fromEntries(
    Object.entries(page).filter(([key]) => !OVERVIEW_PAGE_FIELDS.has(key))
  )
  if (compactJson(extra)) problems.push(compactJson(extra))
  return [`p${page.page}`, source.length ? source.join(' ') : 'no source', problems.join(', ')]
    .filter(Boolean)
    .join('  ')
}
