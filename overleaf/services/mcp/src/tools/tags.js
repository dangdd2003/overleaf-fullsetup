import * as z from 'zod/v4'
import { okResult, runTool, tokenFrom } from '../context.js'
import { lines } from '../format.js'
import { envelope, looseObject, READ_ONLY, WRITES } from '../schemas.js'

const tagId = z
  .string()
  .min(1)
  .describe('The tag id, from list_tags or create_tag')

const tagName = z
  .string()
  .min(1)
  .describe('Tag name, unique among your tags (case-sensitive)')

const tagColor = z
  .string()
  .regex(/^#[a-fA-F0-9]{6}$/)
  .describe('Tag colour as a #RRGGBB hex code, e.g. #3366CC')

const projectIds = z
  .array(z.string().min(1))
  .min(1)
  .describe('Project ids from list_projects')

/** Compact tag shape shared by every tag tool. */
const tagSummary = looseObject({
  id: z.string().describe('The tag id'),
  name: z.string().describe('The tag name'),
  color: z
    .string()
    .nullable()
    .describe('Hex colour of the tag, or null when none was chosen'),
  projectCount: z.number().int().describe('How many projects carry this tag'),
  projectIds: z
    .array(z.string())
    .optional()
    .describe('Ids of the tagged projects; only present with includeProjects'),
})

function tagPath(id, suffix = '') {
  return `/tags/${encodeURIComponent(id)}${suffix}`
}

function count(n, noun) {
  return `${n} ${noun}`
}

/** One tag per line: id, name, colour, project count, then the project ids when asked for. */
function tagLine(tag, includeProjects) {
  const head = [
    tag.id,
    tag.name,
    tag.color,
    count(tag.projectCount, tag.projectCount === 1 ? 'project' : 'projects'),
  ]
    .filter(Boolean)
    .join('  ')
  const ids = includeProjects && tag.projectIds?.length ? `: ${tag.projectIds.join(', ')}` : ''
  return `${head}${ids}`
}

/**
 * Register the tag tools: list, create, update, delete, and tagging projects.
 *
 * Tags are the folders of the Overleaf project dashboard. They belong to the
 * signed-in user alone: collaborators never see them, so changing a tag never
 * changes a project or what anyone else can do with it.
 *
 * @param {object} server an McpServer
 * @param {{ client: object, staticToken: string }} deps
 */
export function registerTagTools(server, { client, staticToken }) {
  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        "List your personal project tags (dashboard labels), sorted by name. Tags never affect access, compiling or files. Set includeProjects to also get each tag's projectIds.",
      annotations: READ_ONLY,
      inputSchema: z.object({
        includeProjects: z
          .boolean()
          .optional()
          .describe('Also return projectIds for each tag (default false)'),
      }),
      outputSchema: envelope(
        looseObject({
          tags: z.array(tagSummary).describe('Your tags, sorted by name'),
          total: z.number().int().describe('How many tags you have'),
        })
      ),
    },
    runTool(async ({ includeProjects }, ctx) => {
      const data = await client.get(tokenFrom(ctx, staticToken), '/tags', {
        includeProjects: includeProjects ? true : undefined,
      })
      const tags = data.tags ?? []
      return okResult({
        summary: tags.length ? `${tags.length} tag(s).` : 'No tags.',
        text: lines(tags.map(tag => tagLine(tag, Boolean(includeProjects)))),
        data: { tags, total: data.total ?? tags.length },
      })
    })
  )

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a personal tag. Repeating with an existing name returns that tag with created: false, not an error. A new tag starts empty; fill it with add_projects_to_tag.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        name: tagName,
        color: tagColor.optional(),
      }),
      outputSchema: envelope(
        looseObject({
          tag: tagSummary.describe('The new or already-existing tag'),
          created: z
            .boolean()
            .describe('False when a tag with this name already existed'),
        })
      ),
    },
    runTool(async ({ name, color }, ctx) => {
      const data = await client.post(tokenFrom(ctx, staticToken), '/tags', {
        name,
        ...(color !== undefined ? { color } : {}),
      })
      const { tag, created } = data
      return okResult({
        summary: created
          ? `Created tag "${tag.name}" (id ${tag.id}).`
          : `Tag "${tag.name}" already exists (id ${tag.id}, ${count(tag.projectCount, 'project(s)')}); nothing changed.`,
        text: '',
        data,
        warnings:
          !created && color && color !== tag.color
            ? [`The existing tag keeps its colour ${tag.color ?? '(none)'}; use update_tag to change it.`]
            : undefined,
      })
    })
  )

  server.registerTool(
    'update_tag',
    {
      title: 'Update tag',
      description:
        'Rename a tag and/or change its colour; supply only the fields to change. Tagged projects are unchanged. Conflicts if another of your tags already has the new name.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z
        .object({
          tagId,
          name: tagName.optional().describe('New tag name, unique among your tags'),
          color: tagColor.optional(),
        })
        .refine(args => args.name !== undefined || args.color !== undefined, {
          message: 'supply name, color or both',
        }),
      outputSchema: envelope(
        looseObject({
          tag: tagSummary.describe('The tag after the update'),
          before: looseObject({
            name: z.string().describe('Name before the update'),
            color: z.string().nullable().describe('Colour before the update'),
          }),
        })
      ),
    },
    runTool(async ({ tagId: id, name, color }, ctx) => {
      const data = await client.patch(
        tokenFrom(ctx, staticToken),
        tagPath(id),
        {
          ...(name !== undefined ? { name } : {}),
          ...(color !== undefined ? { color } : {}),
        }
      )
      const { tag, before } = data
      const changes = [
        before.name !== tag.name ? `renamed "${before.name}" to "${tag.name}"` : null,
        before.color !== tag.color ? `colour ${before.color ?? '(none)'} to ${tag.color}` : null,
      ].filter(Boolean)
      return okResult({
        summary: changes.length
          ? `Updated tag ${tag.id}: ${changes.join(', ')}.`
          : `Tag "${tag.name}" already had these values; nothing changed.`,
        text: '',
        data,
      })
    })
  )

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description:
        'Delete one of your tags. Projects keep all their files and settings and lose only the tag; the tag cannot be restored. To untag some projects, use remove_projects_from_tag.',
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
      inputSchema: z.object({ tagId }),
      outputSchema: envelope(
        looseObject({
          tagId: z.string().describe('The deleted tag id'),
          name: z.string().describe('The name the tag had'),
          deleted: z.boolean().describe('True when the tag was deleted'),
          projectsUntagged: z
            .number()
            .int()
            .describe('How many projects carried the tag'),
        })
      ),
    },
    runTool(async ({ tagId: id }, ctx) => {
      const data = await client.request(
        tokenFrom(ctx, staticToken),
        'DELETE',
        tagPath(id)
      )
      return okResult({
        summary: `Deleted tag "${data.name}"; ${count(data.projectsUntagged, 'project(s)')} lost it and no project was changed.`,
        text: '',
        data,
      })
    })
  )

  server.registerTool(
    'add_projects_to_tag',
    {
      title: 'Add projects to tag',
      description:
        'Put a tag on one or more projects you can open, including shared ones. Already-tagged projects are left alone. If any id is unknown or inaccessible, nothing is tagged and error.details.unknown lists the bad ids. Call once per tag to tag with several.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({ tagId, projectIds }),
      outputSchema: envelope(
        looseObject({
          tag: tagSummary.describe('The tag after the change'),
          added: z.array(z.string()).describe('Project ids newly tagged'),
          alreadyTagged: z
            .array(z.string())
            .describe('Project ids that already had the tag'),
        })
      ),
    },
    runTool(async ({ tagId: id, projectIds: ids }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        tagPath(id, '/projects'),
        { projectIds: ids }
      )
      const { tag, added, alreadyTagged } = data
      return okResult({
        summary: `Tagged ${count(added.length, 'project(s)')} with "${tag.name}"${
          alreadyTagged.length ? `; ${alreadyTagged.length} already had it` : ''
        }. The tag now holds ${count(tag.projectCount, 'project(s)')}.`,
        text: '',
        data,
      })
    })
  )

  server.registerTool(
    'remove_projects_from_tag',
    {
      title: 'Remove projects from tag',
      description:
        'Take a tag off one or more projects, keeping the tag itself; the projects are not changed. Projects that lacked the tag are listed in notTagged. To delete the tag, use delete_tag.',
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({ tagId, projectIds }),
      outputSchema: envelope(
        looseObject({
          tag: tagSummary.describe('The tag after the change'),
          removed: z.array(z.string()).describe('Project ids the tag was taken off'),
          notTagged: z
            .array(z.string())
            .describe('Project ids that did not carry the tag'),
        })
      ),
    },
    runTool(async ({ tagId: id, projectIds: ids }, ctx) => {
      const data = await client.post(
        tokenFrom(ctx, staticToken),
        tagPath(id, '/projects/remove'),
        { projectIds: ids }
      )
      const { tag, removed, notTagged } = data
      return okResult({
        summary: `Removed "${tag.name}" from ${count(removed.length, 'project(s)')}${
          notTagged.length ? `; ${notTagged.length} did not carry it` : ''
        }. The tag now holds ${count(tag.projectCount, 'project(s)')}.`,
        text: '',
        data,
      })
    })
  )
}
