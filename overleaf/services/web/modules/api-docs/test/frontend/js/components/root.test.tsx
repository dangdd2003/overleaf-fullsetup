import { expect } from 'chai'
import { render, screen, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import ApiDocsPageRoot from '../../../../frontend/js/components/root'

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Overleaf API Reference', version: 'v0' },
  tags: [
    { name: 'MCP Files', description: 'Read and write project files.' },
    { name: 'OAuth2', description: 'Issues access tokens.' },
  ],
  components: {
    securitySchemes: { mcpBearerAuth: { description: 'Bearer token.' } },
    schemas: {
      Entry: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path.' } },
      },
    },
  },
  paths: {
    '/api/v0/mcp/projects/{projectId}/doc': {
      get: {
        tags: ['MCP Files'],
        summary: 'Read a document',
        security: [{ mcpBearerAuth: [] }],
        parameters: [
          {
            name: 'path',
            in: 'query',
            required: true,
            description: 'Document path.',
            example: 'main.tex',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Document text',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Entry' },
              },
            },
          },
        },
      },
    },
    '/oauth/register': {
      post: {
        tags: ['OAuth2'],
        summary: 'Register an OAuth client',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['client_name'],
                properties: { client_name: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { description: 'Registered client' } },
      },
    },
  },
}

describe('ApiDocsPageRoot', function () {
  beforeEach(function () {
    fetchMock.get('/api/v0/openapi.json', SPEC)
  })

  afterEach(function () {
    fetchMock.removeRoutes()
    fetchMock.clearHistory()
  })

  it('renders endpoints grouped under their tag', async function () {
    render(<ApiDocsPageRoot />)
    await waitFor(() => screen.getByText('Overleaf API Reference'))
    expect(screen.getByRole('heading', { name: 'MCP Files' })).to.exist
    expect(screen.getByRole('heading', { name: 'OAuth2' })).to.exist
    expect(screen.getByText('/api/v0/mcp/projects/{projectId}/doc')).to.exist
    expect(screen.getByText('Register an OAuth client')).to.exist
  })

  it('lists parameters and resolves response schemas', async function () {
    render(<ApiDocsPageRoot />)
    await waitFor(() => screen.getByText('Read a document'))
    expect(screen.getByText('Document path.')).to.exist
    expect(screen.getByText('File path.')).to.exist
  })

  it('builds a curl example that matches the endpoint auth and body', async function () {
    const { container } = render(<ApiDocsPageRoot />)
    await waitFor(() => screen.getByText('Read a document'))
    const [get, post] = Array.from(container.querySelectorAll('pre code')).map(
      code => code.textContent || ''
    )
    expect(get).to.include('?path=main.tex')
    expect(get).to.include('Authorization: Bearer $OVERLEAF_TOKEN')
    expect(post).to.include('-X POST')
    expect(post).to.include(`-d '{"client_name":"<client_name>"}'`)
    expect(post).to.not.include('Authorization')
  })
})
