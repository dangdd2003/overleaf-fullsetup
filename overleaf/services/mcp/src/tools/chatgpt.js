import * as z from 'zod/v4'
import { runTool, tokenFrom } from '../context.js'
import { CODES, OverleafApiError } from '../errors.js'
import { READ_ONLY } from '../schemas.js'

const profileSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/\S/)
    .describe('Opaque, stable id of the connected Overleaf account'),
  name: z.string().optional().describe('Display name of the connected account'),
  email: z.string().optional().describe('Email address of the connected account'),
})

const searchResultSchema = z.object({
  id: z.string().describe('Opaque document id to pass to fetch'),
  title: z.string().describe('Project name and document path'),
  url: z.string().url().describe('Openable Overleaf project URL'),
})

const fetchSchema = z.object({
  id: z.string().describe('Opaque id returned by search'),
  title: z.string(),
  text: z.string().describe('Document text, limited to the first 5000 lines'),
  url: z.string().url(),
  metadata: z.object({
    projectId: z.string(),
    path: z.string(),
    totalLines: z.number().int(),
    truncated: z.boolean(),
  }),
})

function jsonResult(value) {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function encodeDocumentId(projectId, path) {
  return Buffer.from(JSON.stringify({ projectId, path })).toString('base64url')
}

function decodeDocumentId(id) {
  try {
    const value = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'))
    if (
      typeof value.projectId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.projectId) ||
      typeof value.path !== 'string' ||
      !value.path.startsWith('/') ||
      value.path.split('/').some(segment => segment === '.' || segment === '..')
    ) throw new Error('invalid document id')
    return value
  } catch {
    throw new OverleafApiError(
      CODES.NOT_FOUND,
      'document id is invalid; call search to find a document id',
      404
    )
  }
}

function documentUrl(siteUrl, projectId) {
  return `${siteUrl.replace(/\/+$/, '')}/project/${encodeURIComponent(projectId)}`
}

/** Register the ChatGPT account and Company Knowledge compatibility tools. */
export function registerChatGptTools(server, { client, staticToken, siteUrl = '' }) {
  server.registerTool(
    'get_profile',
    {
      title: 'Get connected account profile',
      description:
        'Identify the Overleaf account connected to this app. Returns a stable account id and available display details.',
      annotations: READ_ONLY,
      _meta: { 'openai/profile': true },
      inputSchema: z.object({}),
      outputSchema: profileSchema,
    },
    runTool(async (_args, ctx) =>
      jsonResult(await client.get(tokenFrom(ctx, staticToken), '/profile'))
    )
  )

  server.registerTool(
    'search',
    {
      title: 'Search Overleaf documents',
      description:
        'Search text across up to 25 of your most recently updated active Overleaf projects. Use fetch with a returned id to read a matching document.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        query: z.string().min(1).describe('Text or phrase to find in project documents'),
      }),
      outputSchema: z.object({ results: z.array(searchResultSchema) }),
    },
    runTool(async ({ query }, ctx) => {
      const token = tokenFrom(ctx, staticToken)
      const { projects = [] } = await client.get(token, '/projects', { status: 'active', limit: 25 })
      const results = []
      const seenDocuments = new Set()
      // Bound both fan-out and output. Search runs concurrently in small batches
      // so accounts with many projects do not overwhelm the web service.
      for (let offset = 0; offset < projects.length && results.length < 20; offset += 5) {
        const batch = await Promise.all(
          projects.slice(offset, offset + 5).map(async project => {
            try {
              const data = await client.get(
                token,
                `/projects/${encodeURIComponent(project.id)}/search`,
                { query, maxMatches: 5 }
              )
              return (data.matches || []).map(match => ({ project, match }))
            } catch {
              return []
            }
          })
        )
        for (const { project, match } of batch.flat()) {
          const id = encodeDocumentId(project.id, match.path)
          if (seenDocuments.has(id)) continue
          seenDocuments.add(id)
          results.push({
            id,
            title: `${project.name || 'Overleaf project'} — ${match.path}`,
            url: documentUrl(siteUrl, project.id),
          })
          if (results.length >= 20) break
        }
      }
      return jsonResult({ results })
    })
  )

  server.registerTool(
    'fetch',
    {
      title: 'Fetch Overleaf document',
      description:
        'Read a document found by search. Returns up to the first 5000 lines and indicates if more remain.',
      annotations: READ_ONLY,
      inputSchema: z.object({ id: z.string().min(1).describe('Document id returned by search') }),
      outputSchema: fetchSchema,
    },
    runTool(async ({ id }, ctx) => {
      const { projectId, path } = decodeDocumentId(id)
      const token = tokenFrom(ctx, staticToken)
      const { documents = [] } = await client.post(token, `/projects/${projectId}/docs/read`, {
        paths: [path],
        startLine: 1,
        endLine: 5000,
      })
      const doc = documents[0]
      if (!doc || doc.error) {
        throw new OverleafApiError(
          CODES.NOT_FOUND,
          'document was not found or is not readable',
          404
        )
      }
      let text = doc.content || ''
      const textTruncated = text.length > 100_000
      if (textTruncated) text = text.slice(0, 100_000)
      const value = {
        id,
        title: path,
        text,
        url: documentUrl(siteUrl, projectId),
        metadata: {
          projectId,
          path,
          totalLines: doc.totalLines || 0,
          truncated: textTruncated || (doc.endLine || 0) < (doc.totalLines || 0),
        },
      }
      return jsonResult(value)
    })
  )
}
