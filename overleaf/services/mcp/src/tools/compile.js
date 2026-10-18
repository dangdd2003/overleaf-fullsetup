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

const LOG_LEVELS = ['all', 'errors', 'warnings']
/** Vertical points sampled down a page when sync_pdf_source has no x/y. */
const SYNCTEX_PAGE_SAMPLES = [90, 230, 370, 510, 650, 790]
const PAGE_REGIONS = ['full', 'top', 'middle', 'bottom']
const PAGE_SPLITS = ['none', 'halves']
// Long edge of a page image in pixels. Most vision models downscale above
// about 1568px, so that is the default.
const DEFAULT_PAGE_MAX_EDGE_PX = 1568
const MIN_PAGE_MAX_EDGE_PX = 512

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
 * Fetch the parsed log of a build, renaming each entry's `file` to a
 * `/`-prefixed `path` so compile results use the same key and form as every
 * file tool.
 */
async function fetchDiagnostics(client, token, id, query) {
  const diag = await client.get(token, `/projects/${id}/compile/diagnostics`, query)
  const withPath = entries =>
    Array.isArray(entries)
      ? entries.map(({ file, ...rest }) => ({
          path: file ? `/${String(file).replace(/^\/+/, '')}` : null,
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

function sleepFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The argument list a follow-up log call needs, as the model would type it. */
function logCallArgs(buildId, clsiServerId) {
  const extra = clsiServerId ? `, clsiServerId="${clsiServerId}"` : ''
  return `projectId, buildId="${buildId}"${extra}`
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

function compileSummary({ status, counts, logChecked, attempts }) {
  switch (status) {
    case 'success':
      return logChecked
        ? `Compiled cleanly: a PDF was produced with no errors, ${counts.warnings} warning(s) and ${counts.badBoxes} bad box(es).`
        : 'A PDF was produced, but the compile log could not be read, so errors are unknown.'
    case 'success_with_errors':
      return `Compiled WITH ERRORS: a PDF was produced, but the log reports ${counts.errors} error(s), so the PDF is likely incomplete or wrong.`
    case 'failure':
      return `Compile FAILED: no PDF was produced, and the log reports ${counts.errors} error(s).`
    case 'timedout':
      return 'Compile timed out before it finished, so no complete PDF was produced.'
    default:
      return `Compile did not produce a build: status "${status}" after ${attempts} attempt(s).`
  }
}

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
      `Do not trust the PDF yet: the log reports ${counts.errors} error(s). Fix every entry in data.errors and compile again.`
    )
  }
  if (status === 'failure' && counts.errors === 0) {
    warnings.push(
      'No PDF was produced and the parsed log has no error, so read the raw log with get_compile_log(raw=true).'
    )
  }
  if (!logChecked && logProblem) {
    warnings.push(
      `The compile log could not be read (${logProblem}), so errors are unknown.`
    )
  }
  if (rerunNeeded) {
    warnings.push(
      'LaTeX asked for another pass because labels or citations changed. Compile again so cross-references are settled.'
    )
  }
  if (counts.undefinedReferences > 0 || counts.undefinedCitations > 0) {
    warnings.push(
      `${counts.undefinedReferences} undefined reference(s) and ${counts.undefinedCitations} undefined citation(s) remain.`
    )
  }
  if (validationProblems) {
    warnings.push(
      `Overleaf rejected the project before compiling: ${JSON.stringify(validationProblems)}.`
    )
  }
  if (TRANSIENT_STATUSES.has(clsiStatus)) {
    warnings.push(
      `Still "${clsiStatus}" after ${attempts} attempt(s). Wait a few seconds, then call compile_project again.`
    )
  }
  return warnings
}

function compileNextSteps({
  id,
  status,
  buildId,
  clsiServerId,
  errors,
  counts,
  rerunNeeded,
  logChecked,
  clsiStatus,
}) {
  const steps = []
  if (errors.length > 0) {
    const first = errors[0]
    steps.push(
      first.path
        ? `read_file(projectId="${id}", path="${first.path}") around line ${first.line ?? '?'}, fix it with edit_lines or edit_file, then compile_project(projectId="${id}")`
        : `Fix the error in data.errors[0] (its file is outside the project); then compile_project(projectId="${id}")`
    )
  }
  if (buildId && counts.warnings > 0) {
    steps.push(
      `get_compile_log(${logCallArgs(buildId, clsiServerId)}, level="warnings")`
    )
  }
  if (buildId && !logChecked) {
    steps.push(
      `get_compile_log(${logCallArgs(buildId, clsiServerId)}, raw=true)`
    )
  }
  if (rerunNeeded && status !== 'failure') {
    steps.push(`compile_project(projectId="${id}")`)
  }
  if (status === 'success' && buildId) {
    // A clean log says nothing about how the pages look; checking them is
    // the step a model skips unless it is the obvious next one.
    steps.push(
      `view_compiled_pdf_page(${logCallArgs(buildId, clsiServerId)}, page=<the page you changed>) to check the layout, which the log cannot`
    )
  }
  if (TRANSIENT_STATUSES.has(clsiStatus)) {
    steps.push(`compile_project(projectId="${id}") again after a few seconds`)
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
        'Compile the project and check the result. Always reads the LaTeX and BibTeX logs, so errors are reported even when a PDF was produced. data.status is one of: success (clean PDF), success_with_errors (PDF produced but the log has errors, so it is wrong or incomplete), failure (no PDF), timedout, or a transient or setup status (too-recently-compiled, compile-in-progress, validation-problems, project-too-large, unavailable). Each error has path and 1-based line to pass to read_file and edit_lines, plus a source excerpt. After editing, call this and fix every entry in data.errors before the next compile. Pass rootDocPath to compile a different main file for one run.',
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
          .describe(
            'Clear the auxiliary build files before compiling, when a stale build is suspected (needs write access)'
          ),
        clearCache: z
          .boolean()
          .optional()
          .describe(
            'Deprecated alias of clean; still accepted, but use clean'
          ),
        rootDocPath: z
          .string()
          .optional()
          .describe(
            'Project path of the main .tex file to compile for this run only, e.g. /thesis/main.tex. Defaults to the project root document'
          ),
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
        definedOnly(options),
        sleep
      )

      const clsiStatus = result.status ?? 'unknown'
      const buildId = result.buildId ?? null
      const clsiServerId = result.clsiServerId ?? null
      const rootDocPath = result.rootDocPath ?? null
      const pdf = result.pdf ?? null

      let diagnostics = null
      let logError = null
      if (buildId) {
        try {
          diagnostics = await fetchDiagnostics(client, token, id, {
            buildId,
            clsiserverid: clsiServerId,
            rootDocPath,
          })
        } catch (err) {
          logError = err?.message || 'the log could not be fetched'
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

      const summary = compileSummary({ status, counts, logChecked, attempts })
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
        id,
        status,
        buildId,
        clsiServerId,
        errors,
        counts,
        rerunNeeded,
        logChecked,
        clsiStatus,
      })

      return okResult({
        summary,
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
        'Re-read a build without recompiling (compile_project already returns its errors). By default returns the parsed view: errors (with path, 1-based line and a source excerpt), warnings (undefined references and citations, BibTeX messages) and bad-box counts. Use level to filter. Pass raw=true to read the raw output.log text in windows of maxLines, starting at startLine. Pass the buildId and clsiServerId that compile_project returned.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
        clsiServerId: z
          .string()
          .optional()
          .describe(
            'clsiServerId from compile_project, so the same compile server is read'
          ),
        level: z
          .enum(LOG_LEVELS)
          .optional()
          .describe(
            'Parsed view only: "errors", "warnings" (warnings and bad boxes), or "all" (the default)'
          ),
        raw: z
          .boolean()
          .optional()
          .describe('Return the raw log text instead of the parsed view'),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Raw view only: first line (1-based) to return; defaults to the last maxLines lines'
          ),
        maxLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Raw view only: lines to return; defaults to 1000'),
        rootDocPath: z
          .string()
          .optional()
          .describe(
            'Parsed view only: the main file the build compiled, when it is not the current root document, so error paths resolve correctly'
          ),
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
            maxLines,
          })
          const shown =
            page.startLine != null
              ? `lines ${page.startLine}-${page.endLine} of ${page.totalLines}`
              : `no lines of ${page.totalLines ?? 0}`
          const more = page.endLine != null && page.endLine < page.totalLines
          return okResult({
            summary: `Raw log: ${shown}.`,
            data: {
              buildId,
              raw: true,
              log: page.log,
              startLine: page.startLine ?? null,
              endLine: page.endLine ?? null,
              totalLines: page.totalLines,
              truncated: page.truncated,
            },
            nextSteps: more
              ? [
                  `get_compile_log(${logCallArgs(buildId, clsiServerId)}, raw=true, startLine=${page.endLine + 1})`,
                ]
              : undefined,
          })
        }

        const diag = await fetchDiagnostics(client, token, id, {
          buildId,
          clsiserverid: clsiServerId,
          rootDocPath,
        })
        const { counts } = diag
        const firstFile = diag.errors.find(entry => entry.path)
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
          summary: `Build ${buildId}: ${counts.errors} error(s), ${counts.warnings} warning(s) and ${counts.badBoxes} bad box(es)${level === 'all' ? '' : ` (showing ${level})`}.`,
          data: {
            buildId,
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
          nextSteps: firstFile
            ? [
                `read_file(projectId="${id}", path="${firstFile.path}") near line ${firstFile.line ?? '?'}`,
              ]
            : undefined,
        })
      }
    )
  )

  server.registerTool(
    'get_compile_pdf',
    {
      title: 'Download compiled PDF',
      description:
        'Download the whole PDF produced by a build as a binary resource, using the buildId returned by compile_project. Use it to hand the document to the user or save it; to look at a page yourself, use view_compiled_pdf_page. A build with errors may still have a PDF, but check compile_project status first. A failed build has no PDF; read its errors with get_compile_log instead.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
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
          buildId: z.string().describe('The build the PDF was produced by'),
        })
      ),
    },
    runTool(async ({ projectId: id, buildId, clsiServerId }, ctx) => {
      const { contentType, base64 } = await client.requestBinary(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/compile/pdf`,
        { buildId, clsiserverid: clsiServerId }
      )
      const uri = `overleaf://projects/${id}/builds/${buildId}/output.pdf`
      const sizeBytes = Buffer.byteLength(base64, 'base64')
      return withBlocks(
        okResult({
          summary: `PDF for build ${buildId}: ${sizeBytes} bytes.`,
          data: {
            projectId: id,
            buildId,
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
        'Count the words in a project, or in one document, using the same TeX-aware counter Overleaf shows in the editor. Headings, maths and captions are reported separately from body text, so use it to check a paper against a length limit.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: z
          .string()
          .optional()
          .describe(
            'Count one document instead of the whole project, e.g. /chapters/intro.tex'
          ),
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
          `The word counter reported ${counts.errors} error(s)${counts.messages ? `: ${counts.messages}` : ''}. The count may be low.`
        )
      }
      return okResult({
        summary: `${scope}: ${counts.textWords ?? 0} body words, ${counts.headWords ?? 0} heading words, ${counts.mathDisplay ?? 0} displayed equation(s).`,
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
        'Text-only SyncTeX lookup between the compiled PDF and the LaTeX source, for the latest build; nothing is rendered. Give page to find the source lines that produced that page (add x and y, in PDF points from the top-left corner, for one exact spot; otherwise the page is sampled top to bottom). Or give path and line to find the page and position where that line appears. Use it when the user refers to "page 4" or "the table at the bottom of page 2". To see what the page looks like, use view_compiled_pdf_page instead. Compile with compile_project first.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('PDF page, 1-based; give this OR path and line'),
        x: z
          .number()
          .min(0)
          .optional()
          .describe('Horizontal position on the page in points from the left (A4 is 595 wide)'),
        y: z
          .number()
          .min(0)
          .optional()
          .describe('Vertical position on the page in points from the top (A4 is 842 tall)'),
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
          .describe('buildId from compile_project; defaults to the latest build'),
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
            ? `/${file} line ${line} appears on page ${pages.join(', ')} of the PDF.`
            : `/${file} line ${line} was not found in the PDF; it may produce no output, or the build is stale.`,
          data: { direction: 'source_to_pdf', pdfPositions },
          nextSteps: pdfPositions.length
            ? undefined
            : [`compile_project(projectId="${id}") and try again`],
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
          ? `Page ${page} comes from ${ranges
              .map(r => `${r.path} lines ${r.startLine}-${r.endLine}`)
              .join('; ')}.`
          : `No source found for page ${page}; the page may not exist, or the build is stale.`,
        data: { direction: 'pdf_to_source', sourceLines, ranges },
        nextSteps: ranges.length
          ? [
              `read_file(projectId="${id}", path="${ranges[0].path}", startLine=${ranges[0].startLine}, endLine=${ranges[0].endLine})`,
            ]
          : [`compile_project(projectId="${id}") and try again`],
      })
    })
  )

  server.registerTool(
    'diff_compiled_pdf',
    {
      title: 'Diff two compiled PDFs',
      description: [
        'Compare the pages of a build with the build compiled before it (or with beforeBuildId), pixel by pixel. Use it after a fix to see exactly what changed on each page, and to confirm nothing else moved.',
        'Returns the changed pages with their regions (% of page height), a summary line per page, and one image of the newer build with the changed regions boxed. Pages are paired by position, or by their words when a page was added or removed.',
      ].join('\n'),
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z
          .string()
          .min(1)
          .describe('The newer build, from compile_project'),
        beforeBuildId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The older build. Defaults to the build compiled before buildId'
          ),
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
        ? `${changedPages.length} of ${diff.pageCount?.after ?? '?'} page(s) changed between build ${diff.beforeBuildId} and build ${diff.afterBuildId}: pages ${changedPages.join(', ')}.`
        : `No page changed between build ${diff.beforeBuildId} and build ${diff.afterBuildId}.`
      const warnings = []
      if (diff.truncated) {
        warnings.push('Only the first pages were compared; the rest are not in this diff.')
      }
      const nextSteps = []
      if (changedPages.length) {
        nextSteps.push(
          `view_compiled_pdf_page(projectId="${id}", buildId="${diff.afterBuildId}", page=${changedPages[0]}) to see the change at full size`
        )
      }
      return withBlocks(
        okResult({
          summary,
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
      description: [
        'See one page of a compiled PDF as an image, the way the user sees it. compile_project only parses the log, and LaTeX often reports status "success" while a table runs off the page, TikZ labels or arrows overlap, or a figure floats pages away from its text.',
        'When: after every successful compile_project whose edits change what a page shows (tables, figures, TikZ, equations, page breaks), and before telling the user the result looks right. Pass the buildId and clsiServerId compile_project returned.',
        'Page: pass page for a PDF page number, or path and line to open the page where that source line is typeset. With neither, page 1. Add endLine to path and line to zoom on where that block of lines is typeset (a table, figure or tikzpicture).',
        `Size: the image is at most maxEdgePx pixels on its long side (default ${DEFAULT_PAGE_MAX_EDGE_PX}, at least ${MIN_PAGE_MAX_EDGE_PX}); raise it when small print is unreadable, lower it to save context. split "halves" sends the page as two overlapping images (top and bottom) for small print. grayscale defaults to true for a page and false when zooming on a block with endLine, so figures keep their colour.`,
        'Returns: the image content blocks, data.sourceMap (height on the page, % from the top -> path:line typeset there), data.sourceRanges (line span per file, ready for read_file), data.badBoxes (overfull/underfull boxes on this page) and data.sourceStatus, which says whether the source map is trustworthy.',
        'Fixing: look for content past the margins, overlapping text, labels or arrows, floats far from their text, ?? or [?] for broken refs and citations, missing symbols, and bad breaks. Take the sourceMap entry nearest the problem\'s height, read_file those lines, fix with edit_lines or edit_file, compile_project, then view the page again with the new buildId. Pass region to zoom in when details are too small to judge.',
        'Blocks: pass labels true to draw a numbered id ([B1], [B2], ...) beside each block on the page; then resolve_pdf_block gives the file and lines of an id.',
      ].join('\n'),
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
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
          .describe(
            'PDF page, 1-based. Omit to choose the page with path and line; with neither, page 1'
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Source document, e.g. /chapters/results.tex; with line, shows the page where that line is typeset'
          ),
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
          .describe(
            'With path and line: the last line of the block to zoom on, e.g. the \\end{tabular} or \\end{tikzpicture} line. The image then shows only where lines line to endLine are typeset, magnified.'
          ),
        region: z
          .enum(PAGE_REGIONS)
          .optional()
          .describe(
            'full (default) shows the whole page; top, middle or bottom zooms into that third at double resolution, to read small text, table cells and subscripts or see whether lines and arrows touch'
          ),
        maxEdgePx: z
          .number()
          .int()
          .min(MIN_PAGE_MAX_EDGE_PX)
          .optional()
          .describe(
            `Longest side of the image in pixels, at least ${MIN_PAGE_MAX_EDGE_PX}. Default ${DEFAULT_PAGE_MAX_EDGE_PX}, a size most vision models read well. Raise it for dense small print; a zoomed region is magnified within the same cap`
          ),
        grayscale: z
          .boolean()
          .optional()
          .describe(
            'Render in grayscale. Defaults to true, except when zooming on a block with endLine, where colour is kept for figures and TikZ'
          ),
        split: z
          .enum(PAGE_SPLITS)
          .optional()
          .describe(
            'none (default) sends one image. halves sends the page, or the zoomed part, as two overlapping images, top and bottom, each within maxEdgePx, so body text stays readable'
          ),
        labels: z
          .boolean()
          .optional()
          .describe(
            'Draw block ids [B1], [B2], ... in a margin strip, for resolve_pdf_block and data.blocks'
          ),
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

        const of = shown.pageCount ? ` of ${shown.pageCount}` : ''
        const zoom =
          shown.region && shown.region !== 'full'
            ? ` (${shown.region} third, zoomed)`
            : zoomsOnBlock
              ? ' (zoomed on the block)'
              : ''
        const where = sourceRanges.length
          ? ` Source: ${sourceRanges
              .map(r => `${r.path} lines ${r.startLine}-${r.endLine}`)
              .join('; ')}.`
          : ' SyncTeX found no source on it.'
        const attached =
          images.length > 1 ? `${images.length} images` : 'an image'
        const warnings = []
        if (stale) warnings.push(staleWarning(stale))
        if (sourceStatus && sourceStatus !== 'mapped' && sourceNote) {
          warnings.push(sourceNote)
        }
        if (badBoxes.length) {
          warnings.push(
            `${badBoxes.length} overfull/underfull box(es) on this page; an overfull \\hbox is content wider than the text block, so check it in the image.`
          )
        }
        const nextSteps = sourceRanges.length
          ? [
              `read_file(projectId="${id}", path="${sourceRanges[0].path}", startLine=${sourceRanges[0].startLine}, endLine=${sourceRanges[0].endLine}) to fix what the image shows`,
              `after the fix: compile_project(projectId="${id}"), then view_compiled_pdf_page with the new buildId and page=${shown.page}`,
            ]
          : undefined

        const blocks = slashPaths(shown.blocks ?? [])
        const defects = slashPaths(shown.defects ?? [])
        if (defects.length) {
          warnings.push(
            `${defects.length} layout defect(s) on this page are listed in data.defects. Fix each at its file and line; do not use a banned quick fix named there.`
          )
        }

        return withBlocks(
          okResult({
            summary: `${stale ? staleSummary(stale) : ''}Page ${shown.page}${of}${zoom} of build ${buildId}, attached as ${attached}.${located ? ` ${located.path} line ${located.line} is about ${located.y}% down the page.` : ''}${where}`,
            data: {
              buildId,
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
        'Turn a block id drawn on a page image (B1, B2, ...) into the source file and lines typeset there. Use it after view_compiled_pdf_page with labels true, when a problem is in a numbered block and you need the lines to edit.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
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
          .describe('The block id as drawn, e.g. B3'),
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
      const range = block.endLine && block.endLine !== block.line
        ? `${block.line}-${block.endLine}`
        : `${block.line}`
      return okResult({
        summary: `${blockId} on page ${page} is typeset from ${path} line${range.includes('-') ? 's' : ''} ${range}.`,
        data: {
          blockId,
          page,
          path,
          line: block.line,
          ...(block.endLine ? { endLine: block.endLine } : {}),
        },
        nextSteps: [
          `read_file(projectId="${id}", path="${path}", startLine=${block.line}, endLine=${block.endLine ?? block.line})`,
        ],
      })
    })
  )

  server.registerTool(
    'view_compiled_pdf_overview',
    {
      title: 'View compiled PDF overview',
      description: [
        'See many pages of a compiled PDF at once: up to 12 pages as thumbnails in one image, each labelled with its page number, plus what measuring the pages found. Use it to judge the document as a whole (page count, paper size, where sections start, where floats landed, page breaks, blank or half-empty pages, content sticking into the margins) and to choose which page to open with view_compiled_pdf_page.',
        'Thumbnails are too small to read text or check a table\'s cells; open the page for that. Returns the image, the page count, paper size and fonts that are not embedded or are bitmap, then per page the source file:lines typeset on it and any problem found.',
      ].join('\n'),
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project'),
        fromPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First page, 1-based. Defaults to 1.'),
        toPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'Last page. At most 12 pages per call; defaults to fromPage + 11. A shorter range gives larger thumbnails.'
          ),
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
      const warnings = overviewWarnings(pages)
      if (stale) warnings.unshift(staleWarning(stale))
      const from = shown.fromPage ?? fromPage ?? 1
      const to = shown.toPage ?? from
      const of = shown.pageCount ? ` of ${shown.pageCount}` : ''
      const paper = shown.paper?.name ? `, ${shown.paper.name} paper` : ''
      const nextSteps = pages.some(p => p.blank || p.overflow?.length)
        ? [
            `view_compiled_pdf_page(projectId="${id}", buildId="${buildId}", page=<a page above>) to see the problem at full size`,
          ]
        : undefined
      return withBlocks(
        okResult({
          summary: `${stale ? staleSummary(stale) : ''}Pages ${from}-${to}${of}${paper} of build ${buildId}, attached as ${images.length > 1 ? `${images.length} images` : 'an image'}.`,
          data: {
            buildId,
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
        "Find text in the compiled PDF as the reader sees it, after macros, numbering, \\ref, \\cite and the bibliography are resolved, and get each match's page, height on the page and the source file:line that typeset it. search_text searches the .tex source; this searches the output.",
        'Use it to: find ?? (undefined \\ref) and [?] (undefined \\cite) in the output; find the page of a caption, heading, equation number or bibliography entry; check what generated text came out as; and get the page number for view_compiled_pdf_page.',
        'Matching ignores case, line breaks and hyphenation; ligatures match their letters. Returns the matches with the total count and every page that has one.',
      ].join('\n'),
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        buildId: z.string().min(1).describe('Build id from compile_project'),
        clsiServerId: z
          .string()
          .optional()
          .describe('clsiServerId from compile_project'),
        query: z
          .string()
          .min(1)
          .describe(
            'Text as it appears in the PDF, e.g. "Figure 3", "??", "Smith et al.". Plain text, not a regular expression'
          ),
        fromPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Only search from this page (1-based). Defaults to the whole PDF.'),
        toPage: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Only search up to this page (1-based). Defaults to the whole PDF.'),
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
        ? `${hits} match(es) for "${query}" in build ${buildId}${found.truncated ? `; the first ${matches.length} are located` : ''}, on page(s) ${(found.pages ?? []).join(', ')}.`
        : `No match for "${query}" in build ${buildId}.`
      return okResult({
        summary: `${stale ? staleSummary(stale) : ''}${summary}`,
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
          ? [
              `view_compiled_pdf_page(projectId="${id}", buildId="${buildId}", page=${first.page}) to see the match`,
            ]
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

/** The stale marker a web result carries, with paths as project paths. */
function staleOf(shown) {
  if (!shown.stale) return null
  return {
    reason: shown.stale.reason,
    changed: (shown.stale.changed ?? []).map(slashed),
  }
}

function staleSummary(stale) {
  return `The PDF is OUT OF DATE (${stale.reason}), so this is the old build, not the current source. `
}

function staleWarning(stale) {
  const changed = stale.changed.length
    ? ` Changed since the build: ${stale.changed.join(', ')}.`
    : ''
  return `The PDF is out of date (${stale.reason}).${changed} Compile again before judging the layout or the text.`
}

/** Warnings for the problems measured on each page of an overview. */
function overviewWarnings(pages) {
  const warnings = []
  for (const page of pages) {
    const problems = []
    if (page.blank) problems.push('blank')
    if (page.overflow?.length) problems.push('content past the margin')
    if (page.badBoxes) problems.push(`${page.badBoxes} bad box(es)`)
    const unresolved = (page.unresolved?.refs ?? 0) + (page.unresolved?.cites ?? 0)
    if (unresolved) problems.push('?? or [?] markers')
    if (problems.length) {
      warnings.push(`Page ${page.page}: ${problems.join(', ')}.`)
    }
  }
  return warnings
}
