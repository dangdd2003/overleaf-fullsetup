import * as z from 'zod/v4'
import { okResult, runTool, tokenFrom } from '../context.js'
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
        "List the signed-in user's project tags, sorted by name. Tags are personal labels for organising the project dashboard: only you see them, a project can carry many, and they never affect access, compiling or files. Each tag has its id, name, colour and projectCount. Set includeProjects: true to also get projectIds for each tag (use it to answer 'which projects are tagged X'). Call this before any other tag tool to get the tagId they need.",
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
      const first = tags.find(tag => tag.projectCount > 0) ?? tags[0]
      return okResult({
        summary: tags.length
          ? `${count(tags.length, tags.length === 1 ? 'tag' : 'tags')}: ${tags
              .slice(0, 10)
              .map(tag => `${tag.name} (${tag.projectCount})`)
              .join(', ')}${tags.length > 10 ? ', ...' : ''}.`
          : 'You have no tags yet.',
        data: { tags, total: data.total ?? tags.length },
        nextSteps: tags.length
          ? [
              ...(!includeProjects && first
                ? [`list_tags(includeProjects=true) to see which projects each tag holds`]
                : []),
              `add_projects_to_tag(tagId="${first.id}", projectIds=[...]) to tag projects`,
            ]
          : [`create_tag(name="...") to make the first tag`],
      })
    })
  )

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a personal tag for organising projects. Safe to repeat: if you already have a tag with this exact name, that tag is returned unchanged with created: false instead of an error. A new tag starts empty; follow with add_projects_to_tag to fill it. colour is optional (#RRGGBB).',
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
          : `Tag "${tag.name}" already exists (id ${tag.id}, ${count(tag.projectCount, 'project(s)')}); nothing was changed.`,
        data,
        warnings:
          !created && color && color !== tag.color
            ? [`The existing tag keeps its colour ${tag.color ?? '(none)'}; use update_tag to change it.`]
            : undefined,
        nextSteps: [
          `add_projects_to_tag(tagId="${tag.id}", projectIds=[...]) to tag projects`,
        ],
      })
    })
  )

  server.registerTool(
    'update_tag',
    {
      title: 'Update tag',
      description:
        'Rename a tag and/or change its colour. Supply only the fields to change; the rest are kept. The tagged projects are unchanged. Fails with a conflict if another of your tags already has the new name. Returns the tag plus its before values.',
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
        data,
      })
    })
  )

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description:
        'Delete one of your tags. Only the label is removed: the projects that carried it keep all their files, settings and collaborators, and simply lose the tag. The tag cannot be restored, but create_tag and add_projects_to_tag can rebuild it. To untag some projects while keeping the tag, use remove_projects_from_tag instead.',
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
        summary: `Deleted tag "${data.name}"; ${count(data.projectsUntagged, 'project(s)')} lost the tag and no project was changed.`,
        data,
      })
    })
  )

  server.registerTool(
    'add_projects_to_tag',
    {
      title: 'Add projects to tag',
      description:
        'Put a tag on one or more projects in one call. Works for any project you can open, including ones shared with you. Safe to repeat: projects that already carry the tag are listed in alreadyTagged and left alone. If any project id is unknown or not accessible, nothing is tagged and error.details.unknown lists the bad ids. To tag a project with several tags, call this once per tag.',
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
        data,
        nextSteps: [
          `list_tags(includeProjects=true) to review every tag and its projects`,
        ],
      })
    })
  )

  server.registerTool(
    'remove_projects_from_tag',
    {
      title: 'Remove projects from tag',
      description:
        'Take a tag off one or more projects in one call, keeping the tag itself. The projects are not changed. Safe to repeat: projects that did not carry the tag are listed in notTagged. Get the tagId and the tagged projectIds from list_tags with includeProjects: true. To delete the tag entirely, use delete_tag.',
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
        data,
      })
    })
  )
}
