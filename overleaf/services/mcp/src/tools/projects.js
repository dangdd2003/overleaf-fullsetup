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

const exportedProjectItem = looseObject({
  projectId: z.string().describe('The exported project id'),
  uri: z.string().describe('overleaf:// uri identifying the project zip resource'),
  mimeType: z.string().describe('Media type of the zip archive'),
  sizeBytes: z.number().int().describe('Decoded size of the zip archive in bytes'),
})

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
      title: 'Export project as ZIP',
      description:
        'Download a project, or several projects, as ZIP archives. Returns each project as a binary ZIP resource plus metadata. Use it to back up or hand off project files rather than reading files one at a time. If 1 project is requested, 1 project is returned; if multiple projects are requested, each project is returned.',
      annotations: READ_ONLY,
      inputSchema: z
        .object({
          projectId: z
            .string()
            .optional()
            .describe('Single Overleaf project id to export as ZIP'),
          projectIds: z
            .array(z.string().min(1))
            .optional()
            .describe(
              'Array of Overleaf project ids to export as ZIP'
            ),
        })
        .refine(
          args =>
            Boolean(args.projectId) ||
            Boolean(args.projectIds && args.projectIds.length > 0),
          {
            message:
              'supply either projectId for a single project or projectIds for multiple projects',
          }
        ),
      outputSchema: looseObject({
        status: okStatus,
        projectId: z
          .string()
          .optional()
          .describe('The exported project, for a single-project export'),
        uri: z
          .string()
          .optional()
          .describe('overleaf:// uri identifying the returned resource'),
        mimeType: z
          .string()
          .optional()
          .describe('Media type of the returned resource'),
        sizeBytes: z
          .number()
          .int()
          .optional()
          .describe('Decoded size of the resource in bytes'),
        projects: z
          .array(exportedProjectItem)
          .optional()
          .describe('The list of exported project zip archives'),
        count: z
          .number()
          .int()
          .optional()
          .describe('How many projects were exported'),
        message: z.string().describe('Human-readable summary of the export'),
      }),
    },
    runTool(async ({ projectId: id, projectIds: ids }, ctx) => {
      const rawIds = [
        ...(id ? [id] : []),
        ...(Array.isArray(ids) ? ids : []),
      ].filter(Boolean)
      const projectIds = [...new Set(rawIds)]

      if (projectIds.length === 0) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'supply either projectId for a single project or projectIds for multiple projects',
          400
        )
      }
      const token = tokenFrom(ctx, staticToken)

      const fetchProjectZip = async pid => {
        const { contentType, base64 } = await client.requestBinary(
          token,
          `/projects/${pid}/zip`
        )
        const sizeBytes = Buffer.byteLength(base64, 'base64')
        const uri = `overleaf://projects/${pid}/project.zip`
        const mimeType = contentType || 'application/zip'
        return {
          projectId: pid,
          uri,
          mimeType,
          sizeBytes,
          base64,
        }
      }

      if (projectIds.length === 1) {
        const singleId = projectIds[0]
        const project = await fetchProjectZip(singleId)
        const sizeKb = Math.round((project.sizeBytes / 1024) * 10) / 10
        const summary = {
          status: 'ok',
          projectId: project.projectId,
          uri: project.uri,
          mimeType: project.mimeType,
          sizeBytes: project.sizeBytes,
          count: 1,
          projects: [
            {
              projectId: project.projectId,
              uri: project.uri,
              mimeType: project.mimeType,
              sizeBytes: project.sizeBytes,
            },
          ],
          message: `Exported project "${project.projectId}" as ZIP archive (${sizeKb} KB).`,
        }
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: project.uri,
                mimeType: project.mimeType,
                blob: project.base64,
              },
            },
            { type: 'text', text: JSON.stringify(summary) },
          ],
          structuredContent: summary,
        }
      }

      const results = await Promise.all(projectIds.map(fetchProjectZip))
      const totalBytes = results.reduce((acc, p) => acc + p.sizeBytes, 0)
      const totalKb = Math.round((totalBytes / 1024) * 10) / 10
      const projectList = results.map(p => ({
        projectId: p.projectId,
        uri: p.uri,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
      }))
      const summary = {
        status: 'ok',
        count: results.length,
        projects: projectList,
        message: `Exported ${results.length} projects as ZIP archives (total ${totalKb} KB).`,
      }
      return {
        content: [
          ...results.map(p => ({
            type: 'resource',
            resource: {
              uri: p.uri,
              mimeType: p.mimeType,
              blob: p.base64,
            },
          })),
          { type: 'text', text: JSON.stringify(summary) },
        ],
        structuredContent: summary,
      }
    })
  )
}
