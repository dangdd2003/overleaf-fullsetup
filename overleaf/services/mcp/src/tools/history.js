import * as z from 'zod/v4'
import { okResult, runTool, tokenFrom } from '../context.js'
import { envelope, looseObject, projectId, READ_ONLY, WRITES } from '../schemas.js'
import { requireFilePath } from '../parsers/paths.js'

const docPath = z
  .string()
  .min(1)
  .describe('Project path, e.g. /main.tex; the leading / is optional')

const version = z
  .number()
  .int()
  .min(0)
  .describe('History version number, from list_history')

const historyEntry = looseObject({
  fromVersion: z.number().int().describe('Version before this group of changes'),
  toVersion: z.number().int().describe('Version after this group of changes'),
  startedAt: z.string().describe('ISO time of the first change'),
  endedAt: z.string().describe('ISO time of the last change'),
  authors: z.array(z.string()).describe('Who made the changes'),
  origin: z
    .string()
    .nullable()
    .describe('How the change was made, e.g. file-restore, or null for editing'),
  labels: z.array(z.string()).describe('Version labels saved at this point'),
  changes: z
    .array(
      looseObject({
        path: z.string().describe('Path that changed'),
        change: z
          .string()
          .describe('edited, added, deleted, or "renamed to <path>"'),
      })
    )
    .describe('Every path this group touched'),
})

const diffChange = looseObject({
  type: z.enum(['insert', 'delete']).describe('Whether text was added or removed'),
  line: z
    .number()
    .int()
    .describe('1-based line in the newer version where the change sits'),
  text: z.string().describe('The inserted or deleted text'),
  author: z.string().nullable().describe('Who made the change, when known'),
})

/** `2026-01-01T00:01:00.000Z` -> `2026-01-01 00:01`. */
function shortTime(iso) {
  return String(iso ?? '')
    .replace('T', ' ')
    .slice(0, 16)
}

/** One history group on one line: versions, time, authors, origin, labels, paths. */
function renderEntry(entry) {
  const changes = (entry.changes ?? [])
    .map(change =>
      change.change === 'edited' ? change.path : `${change.path} ${change.change}`
    )
    .join('; ')
  return [
    `v${entry.fromVersion}→v${entry.toVersion}`,
    shortTime(entry.endedAt),
    (entry.authors ?? []).join(', '),
    entry.origin && `[${entry.origin}]`,
    entry.labels?.length && `[labels: ${entry.labels.join(', ')}]`,
    changes,
  ]
    .filter(Boolean)
    .join('  ')
}

/**
 * Unified-diff style text: `+<line> text` for insertions and `-<line> text`
 * for deletions. An author is printed as `(name)` on its own line when it
 * differs from the previous change.
 */
function renderDiff(changes) {
  const out = []
  let author = null
  for (const change of changes) {
    const who = change.author ?? null
    if (who !== author) {
      author = who
      if (who) out.push(`(${who})`)
    }
    const insert = change.type === 'insert'
    String(change.text ?? '')
      .split('\n')
      .forEach((text, i) => {
        const line = insert ? change.line + i : change.line
        const sign = insert ? '+' : '-'
        out.push(text === '' ? `${sign}${line}` : `${sign}${line} ${text}`)
      })
  }
  return out.join('\n')
}

/**
 * Register the version-history tools: list, diff and restore.
 *
 * Together they give the model an undo path for its own edits, which none of
 * the file tools offer on their own.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerHistoryTools(server, { client, staticToken }) {
  server.registerTool(
    'list_history',
    {
      title: 'List project history',
      description:
        'List recent project versions, newest first, each a group of changes with its paths. Page back with before.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: docPath
          .optional()
          .describe('Only entries touching this path, e.g. /main.tex'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Entries to fetch (default 20)'),
        before: z
          .number()
          .int()
          .optional()
          .describe('Older page: nextBefore from the previous call'),
      }),
      outputSchema: envelope(
        looseObject({
          entries: z.array(historyEntry).describe('History entries, newest first'),
          nextBefore: z
            .number()
            .nullable()
            .describe('Pass as before for the next older page; null at the start of history'),
          path: z.string().nullable().describe('The path filter that was applied'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, limit, before }, ctx) => {
      const data = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/history`,
        { path: path === undefined ? undefined : requireFilePath(path), limit, before }
      )
      const entries = data.entries ?? []
      const older = data.nextBefore != null
      return okResult({
        summary: `${entries.length} entries${older ? `, older: before=${data.nextBefore}` : ''}`,
        text: entries.map(renderEntry).join('\n'),
        data: { entries, nextBefore: data.nextBefore ?? null, path: data.path ?? null },
        nextSteps: older ? [`list_history before=${data.nextBefore}`] : undefined,
      })
    })
  )

  server.registerTool(
    'get_history_diff',
    {
      title: 'Diff a document between versions',
      description:
        'Show the text insertions and deletions in one document between two history versions. Versions come from list_history.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: docPath.describe('Text document to diff, e.g. /main.tex'),
        fromVersion: version.describe('Older version, from list_history'),
        toVersion: version.describe('Newer version, from list_history'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('The document that was compared'),
          fromVersion: z.number().int(),
          toVersion: z.number().int(),
          binary: z.boolean().describe('True for a binary file, which has no text diff'),
          changes: z.array(diffChange).describe('Insertions and deletions in document order'),
          truncated: z.boolean().describe('True when Overleaf returned only part of the changes'),
          insertedChars: z.number().int().describe('Characters inserted in total'),
          deletedChars: z.number().int().describe('Characters deleted in total'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, fromVersion, toVersion }, ctx) => {
      const data = await client.get(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/history/diff`,
        { path: requireFilePath(path), fromVersion, toVersion }
      )
      const changes = data.changes ?? []
      const range = `${data.path} v${fromVersion}→v${toVersion}`
      return okResult({
        summary: data.binary
          ? `${range}: binary file, no text diff`
          : `${range}: ${changes.length} changes +${data.insertedChars ?? 0}/-${data.deletedChars ?? 0} chars`,
        text: renderDiff(changes),
        data,
        warnings: data.truncated
          ? ['Only part of the changes is listed; diff a narrower version range for the rest.']
          : undefined,
      })
    })
  )

  server.registerTool(
    'restore_file',
    {
      title: 'Restore a file from history',
      description:
        'Put one file back to its content at a history version, undoing edits or bringing back a deleted file. The restore is itself recorded in history.',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        path: docPath.describe('File to restore, e.g. /main.tex'),
        version: version.describe('Version to restore, from list_history'),
      }),
      outputSchema: envelope(
        looseObject({
          path: z.string().describe('The restored path'),
          version: z.number().int().describe('The version restored from'),
          type: z.string().describe('doc for a text document, file for a binary file'),
          id: z.string().describe('Id of the restored entity'),
        })
      ),
    },
    runTool(async ({ projectId: id, path, version: v }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        `/projects/${id}/history/restore`,
        { path: requireFilePath(path), version: v }
      )
      return okResult({
        summary: `Restored ${data.path} to v${v}`,
        text: '',
        data,
      })
    })
  )
}
