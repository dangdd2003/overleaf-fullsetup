import { CODES, OverleafApiError, toToolError } from './errors.js'
import { compactJson, lines } from './format.js'

/**
 * Pull the caller's Overleaf token out of the per-request MCP context.
 *
 * On the HTTP transport the token arrives as `ctx.http.authInfo`, put there by
 * the bearer middleware. On stdio there is no HTTP request, so the single-user
 * token from MCP_TOKEN is used instead.
 *
 * @param {object} ctx the tool-handler context
 * @param {string} [fallbackToken] the stdio token, if configured
 * @returns {string}
 */
export function tokenFrom(ctx, fallbackToken) {
  const token = ctx?.http?.authInfo?.token || fallbackToken
  if (!token) {
    throw new OverleafApiError(
      CODES.UNAUTHORIZED,
      'no Overleaf token is associated with this session',
      401
    )
  }
  return token
}

/**
 * Wrap a tool handler so every throw becomes a structured MCP tool error
 * carrying the upstream code, rather than an unhandled rejection.
 *
 * @param {(args: object, ctx: object) => Promise<object>} fn
 */
export function runTool(fn) {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx)
    } catch (err) {
      return toToolError(err)
    }
  }
}

/**
 * The shared success result every tool returns.
 *
 * `structuredContent` holds the full envelope for programmatic clients:
 *
 *   {
 *     ok: true,
 *     summary: 'One sentence saying what happened, with the key numbers.',
 *     data: { ...tool-specific payload... },
 *     warnings?: ['Things the model should notice but that did not fail'],
 *     nextSteps?: ['Concrete follow-up calls']
 *   }
 *
 * The text block, which is what a model reads, is compact text instead:
 *
 *   <summary>
 *   <text: the tool's compact rendering of data, when it gives one;
 *    otherwise single-line JSON of data with empty fields dropped>
 *   ! <each warning>
 *   → <each next step>
 *
 * Failures use `{ ok: false, error: { code, message, hint, retryable } }`
 * from errors.js, with `isError: true` on the MCP result.
 *
 * @param {{ summary: string, data?: object, text?: string, warnings?: string[], nextSteps?: string[] }} parts
 */
export function okResult({ summary, data = {}, text, warnings, nextSteps }) {
  const value = { ok: true, summary, data }
  if (warnings?.length) value.warnings = warnings
  if (nextSteps?.length) value.nextSteps = nextSteps
  return {
    content: [
      {
        type: 'text',
        text: lines(
          summary,
          text === undefined ? compactJson(data) : text,
          (warnings ?? []).map(warning => `! ${warning}`),
          (nextSteps ?? []).map(step => `→ ${step}`)
        ),
      },
    ],
    structuredContent: value,
  }
}

/**
 * Map items through an async function with at most `limit` calls in flight,
 * returning the results in input order. A project can hold far more documents
 * than it is sensible to request at once, so fan-out goes through this.
 *
 * The first failure stops the remaining items from starting and rejects.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        next = items.length
        throw err
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker)
  await Promise.all(workers)
  return results
}

/**
 * Attach extra content blocks (e.g. a binary `resource`) to an envelope.
 *
 * @param {ReturnType<typeof okResult>} result
 * @param {object[]} blocks
 */
export function withBlocks(result, blocks) {
  return { ...result, content: [...result.content, ...blocks] }
}
