import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { runTool, textResult, tokenFrom } from '../context.js'

const projectId = z.string().min(1).describe('The Overleaf project id')

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
      description: 'List user projects',
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
      description: 'Create a new project',
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
      description: 'Get project details',
      inputSchema: z.object({ projectId }),
    },
    runTool(async ({ projectId: id }, ctx) =>
      textResult(await client.get(tokenFrom(ctx, staticToken), `/projects/${id}`))
    )
  )

  server.registerTool(
    'update_project',
    {
      description: 'Update project settings',
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
      description: 'Export project as ZIP archive',
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
              'Multiple Overleaf project ids to bundle and export together as a multi-project ZIP'
            ),
        })
        .refine(
          args =>
            Boolean(args.projectId) !==
            Boolean(args.projectIds && args.projectIds.length > 0),
          {
            message:
              'supply either projectId for a single project or projectIds for multiple projects',
          }
        ),
    },
    runTool(async ({ projectId: id, projectIds: ids }, ctx) => {
      if (Boolean(id) === Boolean(ids && ids.length > 0)) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'supply either projectId for a single project or projectIds for multiple projects',
          400
        )
      }
      const token = tokenFrom(ctx, staticToken)
      if (id) {
        const { contentType, base64 } = await client.requestBinary(
          token,
          `/projects/${id}/zip`
        )
        const sizeKb =
          Math.round((Buffer.byteLength(base64, 'base64') / 1024) * 10) / 10
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `overleaf://projects/${id}/project.zip`,
                mimeType: contentType || 'application/zip',
                blob: base64,
              },
            },
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                projectId: id,
                sizeBytes: Buffer.byteLength(base64, 'base64'),
                message: `Exported project "${id}" as ZIP archive (${sizeKb} KB).`,
              }),
            },
          ],
        }
      }

      const { contentType, base64 } = await client.requestBinary(
        token,
        '/projects-zip',
        {
          method: 'POST',
          body: { projectIds: ids },
        }
      )
      const sizeKb =
        Math.round((Buffer.byteLength(base64, 'base64') / 1024) * 10) / 10
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `overleaf://projects/bundle-${ids.length}-projects.zip`,
              mimeType: contentType || 'application/zip',
              blob: base64,
            },
          },
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              projectIds: ids,
              count: ids.length,
              sizeBytes: Buffer.byteLength(base64, 'base64'),
              message: `Exported ${ids.length} projects as bundled ZIP archive (${sizeKb} KB).`,
            }),
          },
        ],
      }
    })
  )
}
