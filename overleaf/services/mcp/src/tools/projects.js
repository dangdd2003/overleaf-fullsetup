import * as z from 'zod/v4'
import { CODES, OverleafApiError } from '../errors.js'
import { okResult, runTool, tokenFrom, withBlocks } from '../context.js'
import { lines } from '../format.js'
import { envelope, looseObject, projectId, READ_ONLY, WRITES } from '../schemas.js'

const PROJECT_STATUSES = ['active', 'archived', 'trashed']
const SETTING_KEYS = ['name', 'compiler', 'imageName', 'spellCheckLanguage', 'rootDocPath']

/** Compact project shape shared by list, get, create, copy and update. */
const projectSummary = looseObject({
  id: z.string().describe('The Overleaf project id'),
  name: z.string().optional().describe('The project name'),
  lastUpdated: z.string().optional().describe('ISO timestamp of the last change'),
  accessLevel: z
    .string()
    .optional()
    .describe('Your access: owner, readAndWrite, readOnly or review'),
  owner: looseObject({
    id: z.string().optional().describe('The owner user id'),
    name: z.string().optional().describe('The owner display name'),
  })
    .optional()
    .describe('Who owns the project'),
  compiler: z.string().optional().describe('LaTeX engine the project compiles with'),
  archived: z.boolean().optional().describe('Whether you have archived the project'),
  trashed: z.boolean().optional().describe('Whether you have trashed the project'),
})

/** The settings a model can read and change, with their current values. */
const projectSettings = looseObject({
  name: z.string().optional().describe('The project name'),
  compiler: z.string().optional().describe('The LaTeX engine in use'),
  imageName: z
    .string()
    .nullable()
    .optional()
    .describe('TeX Live image in use, or null for the server default'),
  spellCheckLanguage: z
    .string()
    .optional()
    .describe('Spell-check language code, or empty when spell check is off'),
  rootDocPath: z
    .string()
    .nullable()
    .optional()
    .describe('Path of the root document compilation starts from, e.g. /main.tex'),
  rootDocId: z
    .string()
    .nullable()
    .optional()
    .describe('Id of the root document'),
})

/** One requested setting with its value before and after the update. */
const settingChange = looseObject({
  field: z.string().describe('The setting that was requested'),
  before: z.string().nullable().describe('Value before the update'),
  after: z.string().nullable().describe('Value after the update'),
  changed: z.boolean().describe('False when the value already matched the request'),
})

const allowedValues = looseObject({
  compiler: z.array(z.string()).describe('Compiler values update_project accepts'),
  imageName: z
    .array(
      looseObject({
        value: z.string().describe('Pass this as imageName'),
        description: z.string().describe('Human-readable name of the image'),
      })
    )
    .describe('TeX Live images update_project accepts; empty when none are offered'),
  spellCheckLanguage: z
    .array(
      looseObject({
        value: z.string().describe('Pass this as spellCheckLanguage; "" turns spell check off'),
        name: z.string().describe('Human-readable language name'),
      })
    )
    .describe('Spell-check languages update_project accepts'),
})

const listData = looseObject({
  projects: z.array(projectSummary).describe('The matching projects, one page'),
  total: z.number().int().describe('How many projects match before the limit'),
  returned: z.number().int().describe('How many projects this page holds'),
  truncated: z.boolean().describe('True when more projects match than were returned'),
})

const detailData = looseObject({
  project: projectSummary.extend({
    canWrite: z.boolean().describe('Whether you can edit files and settings'),
    canAdmin: z.boolean().describe('Whether you can rename or delete the project'),
  }),
  settings: projectSettings,
  allowedValues,
  files: looseObject({
    documents: z.number().int().describe('Number of text documents'),
    files: z.number().int().describe('Number of binary files such as images'),
    rootDocCandidates: z
      .array(z.string())
      .describe('Paths that can be the root document'),
  }),
})

/** Drop arguments the caller did not supply so web applies its own defaults. */
function definedOnly(args) {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  )
}

function projectPath(id) {
  return `/projects/${encodeURIComponent(id)}`
}

/** One project per line: id, name, date, access, then state and owner when they add information. */
function projectLine(project) {
  const parts = [
    project.id,
    project.name,
    project.lastUpdated?.slice(0, 10),
    project.accessLevel,
  ]
  if (project.archived) parts.push('archived')
  if (project.trashed) parts.push('trashed')
  if (project.accessLevel !== 'owner' && project.owner?.name) {
    parts.push(`owner ${project.owner.name}`)
  }
  return parts.filter(Boolean).join('  ')
}

/**
 * Register the project-level tools.
 *
 * Handlers forward the caller's token and validated arguments to web, which
 * owns authorization and validation. They only shape the result: the compact
 * text a model reads, plus the warnings and nextSteps that matter for the next call.
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
        'List your Overleaf projects, most recently changed first. Each line starts with the projectId other tools need, so use it to turn a project name into an id.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Only projects whose name contains this text, case-insensitive'),
        status: z
          .enum(PROJECT_STATUSES.concat('all'))
          .optional()
          .describe('"active" (default), "archived", "trashed" or "all"'),
        ownership: z
          .enum(['all', 'owned', 'shared'])
          .optional()
          .describe('"all" (default), "owned" by you or "shared" with you'),
        sortBy: z
          .enum(['lastUpdated', 'name'])
          .optional()
          .describe('"lastUpdated" (default) or "name"'),
        order: z
          .enum(['asc', 'desc'])
          .optional()
          .describe('Sort direction; defaults to desc for lastUpdated and asc for name'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum projects to return (default 50)'),
      }),
      outputSchema: envelope(listData),
    },
    runTool(async (args, ctx) => {
      const data = await client.get(
        tokenFrom(ctx, staticToken),
        '/projects',
        definedOnly(args)
      )
      const projects = data.projects || []
      const total = data.total ?? projects.length
      const returned = data.returned ?? projects.length
      const truncated = Boolean(data.truncated)
      return okResult({
        summary: `${returned}/${total} projects`,
        text: lines(projects.map(projectLine)),
        data: { projects, total, returned, truncated },
        warnings: truncated
          ? [`${total - returned} more match; raise limit or narrow the query.`]
          : undefined,
      })
    })
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        "Create a project you own. template picks the starting files; files adds text documents on top, and a /main.tex entry replaces the template's main.tex. Returns the projectId for later calls.",
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('The project name: no / or \\, no leading or trailing spaces'),
        template: z
          .enum(['blank', 'example', 'empty'])
          .optional()
          .describe('Starting files: "blank" (default), "example" or "empty"'),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe('Path within the project, e.g. /refs.bib or chapters/intro.tex'),
              content: z.string().describe('The file contents'),
            })
          )
          .optional()
          .describe('Text documents to create, e.g. [{ path: "/main.tex", content: "..." }]'),
      }),
      outputSchema: envelope(
        looseObject({
          project: projectSummary.describe('The project that was created'),
          rootDocPath: z.string().nullable().describe('The root document path, or null when none is set'),
          filesCreated: z.array(z.string()).describe('Paths written from files'),
        })
      ),
    },
    runTool(async ({ files, ...args }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        '/projects',
        definedOnly({ ...args, initialFiles: files })
      )
      const { project, rootDocPath = null, filesCreated = [] } = data
      return okResult({
        summary: 'Created project.',
        text: lines(
          `project ${project.id}  ${project.name}`,
          rootDocPath ? `root ${rootDocPath}` : null,
          filesCreated.length ? `files written ${filesCreated.length}` : null
        ),
        data: { project, rootDocPath, filesCreated },
        warnings: rootDocPath
          ? undefined
          : ['No root document set; write /main.tex with write_file, then update_project rootDocPath.'],
      })
    })
  )

  server.registerTool(
    'get_project',
    {
      title: 'Get project details',
      description:
        'Read one project: current settings, file counts with root document candidates, and your access level. Use it before changing settings or compiling. Pass include: ["allowedValues"] to also list the values update_project accepts.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectId,
        include: z
          .array(z.enum(['allowedValues']))
          .optional()
          .describe('Extra sections: allowedValues lists valid compiler/imageName/spellCheckLanguage'),
      }),
      outputSchema: envelope(detailData),
    },
    runTool(async ({ projectId: id, include }, ctx) => {
      const data = await client.get(tokenFrom(ctx, staticToken), projectPath(id))
      const { project, settings, allowedValues: allowed, files } = data
      const warnings = []
      if (!project.canWrite) {
        warnings.push('Read-only access; edits and settings changes will be refused.')
      }
      if (!settings.rootDocPath) {
        warnings.push('No root document set; compiles may pick the wrong file.')
      }
      if (allowed.imageName.length === 0) {
        warnings.push('No selectable TeX Live images; imageName cannot be changed.')
      }
      const withAllowed = include?.includes('allowedValues')
      const nextSteps = []
      if (!settings.rootDocPath && project.canWrite && files.rootDocCandidates[0]) {
        nextSteps.push(
          `update_project(rootDocPath="${files.rootDocCandidates[0]}")`
        )
      }
      const spellCodes = withAllowed
        ? allowed.spellCheckLanguage.map(language => language.value).filter(Boolean)
        : []
      return okResult({
        summary: `Project ${settings.name}`,
        text: lines(
          `name ${settings.name} | compiler ${settings.compiler} | image ${settings.imageName || 'default'} | spell ${settings.spellCheckLanguage || 'off'} | root ${settings.rootDocPath || 'none'}`,
          `access ${project.accessLevel}${project.canWrite ? '' : ' read-only'}`,
          `docs ${files.documents}, files ${files.files}`,
          !settings.rootDocPath && files.rootDocCandidates.length
            ? `root candidates: ${files.rootDocCandidates.join(', ')}`
            : null,
          withAllowed && allowed.compiler.length ? `compilers: ${allowed.compiler.join(', ')}` : null,
          withAllowed && allowed.imageName.length
            ? `images: ${allowed.imageName.map(image => image.value).join(', ')}`
            : null,
          withAllowed && spellCodes.length ? `spell: ${spellCodes.join(', ')}` : null
        ),
        data,
        warnings: warnings.length ? warnings : undefined,
        nextSteps: nextSteps.length ? nextSteps : undefined,
      })
    })
  )

  server.registerTool(
    'update_project',
    {
      title: 'Update project settings',
      description:
        'Change project settings: name (owner only), compiler, imageName, spellCheckLanguage and rootDocPath. Supply only the settings to change. Valid values come from get_project include allowedValues; an invalid value changes nothing.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z
        .object({
          projectId,
          name: z
            .string()
            .min(1)
            .optional()
            .describe('New project name; only the project owner can rename'),
          compiler: z
            .enum(['pdflatex', 'latex', 'xelatex', 'lualatex'])
            .optional()
            .describe('LaTeX engine used to compile the project'),
          imageName: z
            .string()
            .optional()
            .describe('TeX Live image name from get_project allowedValues.imageName'),
          spellCheckLanguage: z
            .string()
            .optional()
            .describe('Language code from get_project allowedValues.spellCheckLanguage; "" turns spell check off'),
          rootDocPath: z
            .string()
            .optional()
            .describe('Path of the root document, e.g. /main.tex; must be a LaTeX file in the project'),
        })
        .refine(args => SETTING_KEYS.some(key => args[key] !== undefined), {
          message: `supply at least one of ${SETTING_KEYS.join(', ')}`,
        }),
      outputSchema: envelope(
        looseObject({
          changes: z.array(settingChange).describe('Each requested setting, before and after'),
          settings: projectSettings.describe('All settings after the update'),
        })
      ),
    },
    runTool(async ({ projectId: id, ...settings }, ctx) => {
      const data = await client.patch(
        tokenFrom(ctx, staticToken),
        `${projectPath(id)}/settings`,
        definedOnly(settings)
      )
      const changed = (data.changes || []).filter(change => change.changed)
      return okResult({
        summary: changed.length
          ? `Updated ${changed.length} setting(s).`
          : 'No change; the requested values already matched.',
        text: lines(
          changed.map(
            change => `${change.field}: ${change.before ?? 'unset'} -> ${change.after ?? 'unset'}`
          )
        ),
        data,
      })
    })
  )

  server.registerTool(
    'set_project_status',
    {
      title: 'Archive, trash or restore a project',
      description:
        "Move a project between your active list, archive and trash, for your own view only. status 'active' restores it. No files are deleted and each step is reversible.",
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        status: z
          .enum(PROJECT_STATUSES)
          .describe('"active", "archived" or "trashed"'),
      }),
      outputSchema: envelope(
        looseObject({
          projectId: z.string().describe('The project id'),
          previousStatus: z.enum(PROJECT_STATUSES).describe('Status before this call'),
          status: z.enum(PROJECT_STATUSES).describe('Status now'),
        })
      ),
    },
    runTool(async ({ projectId: id, status }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        `${projectPath(id)}/status`,
        { status }
      )
      const summary =
        data.previousStatus === data.status
          ? `Already ${data.status}; nothing changed.`
          : `Moved from ${data.previousStatus} to ${data.status}.`
      return okResult({
        summary,
        text: '',
        data,
        nextSteps:
          data.status === 'trashed'
            ? ['set_project_status with status "active" to restore it']
            : undefined,
      })
    })
  )

  server.registerTool(
    'copy_project',
    {
      title: 'Copy project',
      description:
        "Duplicate a project into a new one you own, with all its files. name defaults to '<name> (Copy)'. Large copies can time out; check list_projects before retrying so you do not create a second copy.",
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        projectId,
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Name for the copy; defaults to "<name> (Copy)"'),
      }),
      outputSchema: envelope(
        looseObject({
          project: projectSummary.describe('The new project'),
          sourceProjectId: z.string().describe('The project that was copied'),
        })
      ),
    },
    runTool(async ({ projectId: id, ...rest }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        `${projectPath(id)}/copy`,
        definedOnly(rest)
      )
      return okResult({
        summary: 'Copied project.',
        text: `project ${data.project.id}  ${data.project.name}`,
        data,
      })
    })
  )

  server.registerTool(
    'delete_project',
    {
      title: 'Permanently delete project',
      description:
        'Permanently delete a project and its files for everyone who shares it. Owner only, and not undoable. Requires confirm: true. To hide a project reversibly, use set_project_status "trashed".',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({
        projectId,
        confirm: z
          .literal(true)
          .describe('Must be true to confirm the permanent deletion'),
      }),
      outputSchema: envelope(
        looseObject({
          projectId: z.string().describe('The deleted project id'),
          deleted: z.boolean().describe('True when the project was deleted'),
        })
      ),
    },
    runTool(async ({ projectId: id, confirm }, ctx) => {
      if (confirm !== true) {
        throw new OverleafApiError(
          CODES.VALIDATION_ERROR,
          'deleting a project requires confirm: true',
          400,
          { hint: 'Ask the user to confirm the permanent deletion, then pass confirm: true.' }
        )
      }
      const data = await client.request(
        tokenFrom(ctx, staticToken),
        'DELETE',
        projectPath(id)
      )
      return okResult({
        summary: 'Project permanently deleted.',
        text: '',
        data,
      })
    })
  )

  server.registerTool(
    'export_project_zip',
    {
      title: 'Export projects as ZIP',
      description:
        "Download projects as a ZIP, like the UI download button. One id gives that project's zip; several ids give one bundle zip holding a zip per project. Use it to back up or hand off whole projects.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        projectIds: z
          .array(projectId)
          .min(1)
          .describe('Project ids to export; several ids make one bundle zip'),
      }),
      outputSchema: envelope(
        looseObject({
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
        })
      ),
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
      const mimeType = contentType || 'application/zip'
      const summary = bundled
        ? `Exported ${projectIds.length} projects as "${name}" (${sizeKb} KB).`
        : `Exported "${name}" (${sizeKb} KB).`
      return withBlocks(
        okResult({
          summary,
          text: '',
          data: {
            projectIds,
            count: projectIds.length,
            bundled,
            filename: name,
            uri,
            mimeType,
            sizeBytes,
          },
        }),
        [{ type: 'resource', resource: { uri, mimeType, blob: base64 } }]
      )
    })
  )
}
