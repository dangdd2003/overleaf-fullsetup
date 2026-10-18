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
        'List the recent versions of a project, newest first: each entry is a group of changes with fromVersion/toVersion, time, authors and every path it touched. Pass path to keep only entries that touched one file. Use it to find what changed recently, then get_history_diff to see the text, or restore_file to undo. Page back with before set to data.nextBefore.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        path: docPath
          .optional()
          .describe('Only entries that touched this path, e.g. /main.tex'),
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
          .describe('Older page: pass data.nextBefore from the previous call'),
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
      const latest = entries[0]
      return okResult({
        summary: entries.length
          ? `${entries.length} history entr${entries.length === 1 ? 'y' : 'ies'}${
              data.path ? ` touching ${data.path}` : ''
            }; latest is version ${latest.toVersion} at ${latest.endedAt}.`
          : `No history entries${data.path ? ` touching ${data.path}` : ''} in this page.`,
        data: { entries, nextBefore: data.nextBefore ?? null, path: data.path ?? null },
        nextSteps: [
          ...(latest
            ? [
                `get_history_diff(projectId="${id}", path="${latest.changes?.[0]?.path ?? '/main.tex'}", fromVersion=${latest.fromVersion}, toVersion=${latest.toVersion}) to see what changed`,
              ]
            : []),
          ...(data.nextBefore != null
            ? [`list_history(projectId="${id}", before=${data.nextBefore}) for older entries`]
            : []),
        ],
      })
    })
  )

  server.registerTool(
    'get_history_diff',
    {
      title: 'Diff a document between versions',
      description:
        'Show what changed in one text document between two history versions: each insertion or deletion with the 1-based line it sits on in the newer version. Versions come from list_history; to see a single entry, pass its fromVersion and toVersion.',
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
      const summary = data.binary
        ? `${data.path} is a binary file, so there is no text diff between versions ${fromVersion} and ${toVersion}.`
        : `${data.path}: ${changes.length} change(s) between versions ${fromVersion} and ${toVersion} (+${data.insertedChars} / -${data.deletedChars} characters).`
      return okResult({
        summary,
        data,
        warnings: data.truncated
          ? ['Only part of the changes is listed; diff a narrower version range for the rest.']
          : undefined,
        nextSteps: changes.length
          ? [
              `restore_file(projectId="${id}", path="${data.path}", version=${fromVersion}) to undo these changes`,
            ]
          : undefined,
      })
    })
  )

  server.registerTool(
    'restore_file',
    {
      title: 'Restore a file from history',
      description:
        "Put one file back to its content at a history version: undo edits, or bring back a deleted file at its old path. The restore is itself recorded in history, so it can be undone too. To undo a list_history entry, restore to that entry's fromVersion.",
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        path: docPath.describe('File to restore, e.g. /main.tex'),
        version: version.describe('Version whose content to restore, from list_history'),
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
        summary: `Restored ${data.path} to its content at version ${v}.`,
        data,
        nextSteps: [
          `read_file(projectId="${id}", path="${data.path}") to check the restored content`,
          `compile_project(projectId="${id}") to rebuild`,
        ],
      })
    })
  )
}
