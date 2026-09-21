import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'
import {
  looseObject,
  okStatus,
  projectId,
  READ_ONLY,
  WRITES,
} from '../schemas.js'

/**
 * Only the id is required: metadata web may omit for a particular project must
 * not turn the whole tool call into an output-validation failure.
 */
const projectSummary = looseObject({
  id: z.string().describe('The Overleaf project id'),
  name: z.string().optional().describe('The project name'),
  lastUpdated: z
    .string()
    .optional()
    .describe('ISO timestamp of the last change'),
  compiler: z.string().optional().describe('LaTeX engine the project compiles with'),
  archived: z
    .boolean()
    .optional()
    .describe('Whether the caller has archived the project'),
  trashed: z
    .boolean()
    .optional()
    .describe('Whether the caller has trashed the project'),
})

const projectDetail = projectSummary.extend({
  rootDocId: z
    .string()
    .nullable()
    .optional()
    .describe('Id of the root document compilation starts from'),
  spellCheckLanguage: z
    .string()
    .nullable()
    .optional()
    .describe('Spell-check language code, or empty when disabled'),
})

/** Matches the ceiling web enforces on /projects-zip, so we reject before the round trip. */
const MAX_PROJECTS_PER_EXPORT = 50

/**
 * Register the project-level tools.
 *
 * Every handler is a pass-through: it forwards the caller's token and the
 * validated arguments to web, which owns all authorization.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerProjectTools(server, { client, staticToken }) {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        "List the Overleaf projects the signed-in user can open, newest activity first. Returns each project's id, name, compiler and archived/trashed state. Call this first to resolve a project name the user mentioned into the projectId every other tool needs.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Filter by project name substring'),
        status: z
          .enum(['active', 'archived', 'trashed', 'all'])
          .optional()
          .describe(
            'Filter by status: "active" (default, excludes trash/archived), "trashed" (only trash), "archived", or "all"'
          ),
      }),
      outputSchema: looseObject({
        projects: z.array(projectSummary).describe('The matching projects'),
      }),
    },
    runTool(async ({ query, status }, ctx) =>
      textResult(
        await client.get(tokenFrom(ctx, staticToken), '/projects', { query, status })
      )
    )
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a new empty Overleaf project owned by the signed-in user, optionally seeding it with documents. Returns the new project, whose id is the projectId to use for subsequent edits and compiles.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        name: z.string().min(1).describe('The project name'),
        initialFiles: z
          .array(
            z.object({
              path: z.string().min(1).describe('Path within the project, e.g. main.tex'),
              content: z.string().describe('The initial file contents'),
            })
          )
          .optional()
          .describe('Documents to create with the project'),
      }),
      outputSchema: looseObject({
        project: projectSummary.describe('The project that was created'),
      }),
    },
    runTool(async ({ name, initialFiles }, ctx) =>
      textResult(
        await client.post(tokenFrom(ctx, staticToken), '/projects', {
          name,
          ...(initialFiles ? { initialFiles } : {}),
        })
      )
    )
  )

  server.registerTool(
    'get_project',
    {
      title: 'Get project details',
      description:
        'Read one project\'s settings: name, compiler, root document id, spell-check language and archived/trashed state. Use it to discover which engine a project compiles with or which file is its root document before compiling.',
      annotations: READ_ONLY,
      inputSchema: z.object({ projectId }),
      outputSchema: looseObject({
        project: projectDetail.describe('The requested project'),
      }),
    },
    runTool(async ({ projectId: id }, ctx) =>
      textResult(await client.get(tokenFrom(ctx, staticToken), `/projects/${id}`))
    )
  )

  server.registerTool(
    'update_project',
    {
      title: 'Update project settings',
      description:
        'Change a project\'s compiler, root document or spell-check language. Supply only the settings to change; the rest are left alone. Returns an acknowledgement, not the updated project.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z
        .object({
          projectId,
          compiler: z
            .enum(['pdflatex', 'latex', 'xelatex', 'lualatex'])
            .optional()
            .describe('The LaTeX engine used to compile the project'),
          rootDocId: z
            .string()
            .optional()
            .describe('Document id to use as the root document'),
          spellCheckLanguage: z
            .string()
            .optional()
            .describe('Spell-check language code, e.g. en or fr; empty string disables it'),
        })
        .refine(
          args =>
            args.compiler !== undefined ||
            args.rootDocId !== undefined ||
            args.spellCheckLanguage !== undefined,
          { message: 'supply at least one of compiler, rootDocId or spellCheckLanguage' }
        ),
      outputSchema: looseObject({ status: okStatus }),
    },
    runTool(async ({ projectId: id, ...settings }, ctx) => {
      const body = Object.fromEntries(
        Object.entries(settings).filter(([, value]) => value !== undefined)
      )
      return textResult(
        await client.patch(tokenFrom(ctx, staticToken), `/projects/${id}/settings`, body)
      )
    })
  )

  server.registerTool(
    'export_project_zip',
    {
      title: 'Export projects as ZIP',
      description:
        'Download projects as a single ZIP archive, the same archive the download button in the Overleaf UI produces. One project id returns that project\'s own zip, named after the project. Several project ids return one bundle zip holding a zip per project, named after the moment it was exported. Either way exactly one binary ZIP resource comes back, plus its metadata. Use it to back up or hand off whole projects rather than reading files one at a time.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectIds: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_PROJECTS_PER_EXPORT)
          .describe(
            'Overleaf project ids to export. One id exports that project on its own; several ids export one bundle zip containing a zip per project.'
          ),
      }),
      outputSchema: looseObject({
        status: okStatus,
        projectIds: z
          .array(z.string())
          .describe('The project ids the archive holds'),
        count: z.number().int().describe('How many projects the archive holds'),
        bundled: z
          .boolean()
          .describe('True when the archive is a bundle of per-project zips'),
        filename: z.string().describe('Name to save the archive under'),
        uri: z
          .string()
          .describe('overleaf:// uri identifying the returned archive'),
        mimeType: z.string().describe('Media type of the archive'),
        sizeBytes: z
          .number()
          .int()
          .describe('Decoded size of the archive in bytes'),
        message: z.string().describe('Human-readable summary of the export'),
      }),
    },
    runTool(async ({ projectIds: ids }, ctx) => {
      const projectIds = [
        ...new Set((Array.isArray(ids) ? ids : []).filter(Boolean)),
      ]

      if (projectIds.length === 0) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'supply at least one project id in projectIds',
          400
        )
      }
      if (projectIds.length > MAX_PROJECTS_PER_EXPORT) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          `cannot export more than ${MAX_PROJECTS_PER_EXPORT} projects at once`,
          400
        )
      }
      const token = tokenFrom(ctx, staticToken)
      const bundled = projectIds.length > 1

      // web already builds both archives for its own download buttons, so this
      // is one request either way: never a zip per project stitched together
      // here. POST keeps a 50-id bundle out of the query string.
      const { contentType, filename, base64 } = bundled
        ? await client.requestBinary(token, '/projects-zip', {
            method: 'POST',
            body: { projectIds },
          })
        : await client.requestBinary(token, `/projects/${projectIds[0]}/zip`)

      const sizeBytes = Buffer.byteLength(base64, 'base64')
      const sizeKb = Math.round((sizeBytes / 1024) * 10) / 10
      const name =
        filename ||
        (bundled ? 'Overleaf Projects.zip' : `${projectIds[0]}.zip`)
      const uri = bundled
        ? `overleaf://exports/${encodeURIComponent(name)}`
        : `overleaf://projects/${projectIds[0]}/project.zip`
      const summary = {
        status: 'ok',
        projectIds,
        count: projectIds.length,
        bundled,
        filename: name,
        uri,
        mimeType: contentType || 'application/zip',
        sizeBytes,
        message: bundled
          ? `Exported ${projectIds.length} projects as "${name}" (${sizeKb} KB), one zip per project inside the bundle.`
          : `Exported project "${projectIds[0]}" as "${name}" (${sizeKb} KB).`,
      }
      return {
        content: [
          {
            type: 'resource',
            resource: { uri, mimeType: summary.mimeType, blob: base64 },
          },
          { type: 'text', text: JSON.stringify(summary) },
        ],
        structuredContent: summary,
      }
    })
  )
}
