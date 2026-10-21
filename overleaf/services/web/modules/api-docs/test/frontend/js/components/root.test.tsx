import { expect } from 'chai'
import sinon from 'sinon'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import ApiDocsPageRoot from '../../../../frontend/js/components/root'
import ApiDocsSidebar, {
  splitSharedPrefix,
} from '../../../../frontend/js/components/api-docs/sidebar'
import {
  listEndpoints,
  resolveSchema,
} from '../../../../frontend/js/components/api-docs/spec-utils'
import { SchemaTable } from '../../../../frontend/js/components/api-docs/schema-table'
import { buildSamples } from '../../../../frontend/js/components/api-docs/samples'
import type {
  Endpoint,
  OpenApiSpec,
  SchemaObject,
} from '../../../../frontend/js/components/api-docs/types'
import { SplitTestProvider } from '@/shared/context/split-test-context'
import { UserSettingsProvider } from '@/shared/context/user-settings-context'

function renderRoot() {
  return render(
    <SplitTestProvider>
      <UserSettingsProvider>
        <ApiDocsPageRoot />
      </UserSettingsProvider>
    </SplitTestProvider>
  )
}

const SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Overleaf API Reference',
    version: 'v0',
    description: 'Use the API with a token.\n\nSee `docs` for limits.',
  },
  'x-tagGroups': [
    { name: 'Authentication', tags: ['OAuth2'] },
    { name: 'MCP REST API', tags: ['MCP Files', 'Uploads'] },
  ],
  tags: [
    { name: 'MCP Files', description: 'Read and write project files.' },
    { name: 'OAuth2', description: 'Issues access tokens.' },
    { name: 'Uploads', description: 'Upload binary content.' },
  ],
  components: {
    securitySchemes: {
      mcpBearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Send a personal access token.',
      },
      sessionAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'overleaf_session2',
        description: 'Browser session. Send X-CSRF-Token for non-GET requests.',
      },
    },
    schemas: {
      Entry: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path.',
            example: 'main.tex',
          },
          meta: {
            type: 'object',
            properties: { size: { type: 'integer', example: 42 } },
          },
          kind: { type: 'string', enum: ['file', 'folder'], nullable: true },
        },
      },
    },
  },
  paths: {
    '/api/v0/mcp/projects/{projectId}/doc': {
      get: {
        operationId: 'mcpReadDoc',
        tags: ['MCP Files'],
        summary: 'Read a document',
        description: 'Returns the document text.\n\nLimited to `1 MB`.',
        security: [{ mcpBearerAuth: [] }],
        parameters: [
          {
            name: 'projectId',
            in: 'path',
            required: true,
            example: 'proj-1',
            schema: { type: 'string' },
          },
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
          '404': { description: 'Not found' },
        },
      },
    },
    '/oauth/register': {
      post: {
        operationId: 'oauthRegister',
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
    '/api/v0/projects/{projectId}/upload': {
      post: {
        operationId: 'uploadFile',
        tags: ['Uploads'],
        summary: 'Upload a file',
        security: [{ sessionAuth: [] }],
        parameters: [
          {
            name: 'projectId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                  name: { type: 'string', example: 'figure.png' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Uploaded' } },
      },
    },
    '/api/v0/mcp/projects/{projectId}/export.pdf': {
      get: {
        operationId: 'exportPdf',
        tags: ['MCP Files'],
        summary: 'Export a PDF',
        deprecated: true,
        security: [{ mcpBearerAuth: [] }],
        parameters: [
          {
            name: 'projectId',
            in: 'path',
            required: true,
            example: 'proj-1',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'The compiled PDF',
            content: {
              'application/pdf': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
        },
      },
    },
  },
}

function endpoint(id: string) {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`no endpoint with id ${id}`)
  }
  return element
}

describe('ApiDocsPageRoot', function () {
  beforeEach(function () {
    fetchMock.get('/api/v0/openapi.json', SPEC)
    fetchMock.get('/system/messages', [])
    window.metaAttributesCache.set('ol-userSettings', {})
    window.metaAttributesCache.set('ol-navbar', { items: [] })
    window.metaAttributesCache.set('ol-footer', {
      leftItems: [],
      rightItems: [],
    })
  })

  afterEach(function () {
    fetchMock.removeRoutes()
    fetchMock.clearHistory()
    sinon.restore()
  })

  async function renderPage() {
    const result = renderRoot()
    await waitFor(() =>
      screen.getByRole('heading', { level: 1, name: /Overleaf API Reference/ })
    )
    return result
  }

  it('shows the title and base URL once the spec has loaded', async function () {
    await renderPage()
    expect(screen.getAllByText(window.location.origin).length).to.be.above(0)
  })

  it('renders the x-tagGroups sections, tags and endpoints in the sidebar', async function () {
    await renderPage()
    const nav = screen.getByRole('navigation', { name: 'API reference' })
    expect(within(nav).getByText('MCP REST API')).to.exist
    expect(within(nav).getByText('Authentication', { selector: 'p' })).to.exist
    expect(
      within(nav).getByRole('link', { name: 'MCP Files' }).getAttribute('href')
    ).to.equal('#tag-mcp-files')
    const endpointLink = within(nav).getByRole('link', {
      name: /^GET \/api\/v0\/mcp\/projects\/\{projectId\}\/doc: Read a document$/,
    })
    expect(endpointLink.getAttribute('href')).to.equal('#mcpReadDoc')
    expect(endpointLink.getAttribute('title')).to.equal('Read a document')
  })

  it('renders each tag as a level-2 heading with its description', async function () {
    await renderPage()
    expect(screen.getByRole('heading', { level: 2, name: 'MCP Files' })).to
      .exist
    expect(screen.getByRole('heading', { level: 2, name: 'OAuth2' })).to.exist
    expect(screen.getByText('Issues access tokens.')).to.exist
  })

  it('renders endpoints with anchors, auth and deprecation markers', async function () {
    await renderPage()
    const read = endpoint('mcpReadDoc')
    expect(
      within(read).getByRole('heading', { level: 3, name: 'Read a document' })
    ).to.exist
    expect(within(read).getByText('Bearer token')).to.exist
    expect(within(read).getByText('Returns the document text.')).to.exist

    const register = endpoint('oauthRegister')
    expect(within(register).getByText('Public')).to.exist

    expect(within(endpoint('exportPdf')).getByText('Deprecated')).to.exist
  })

  it('lists parameters, nested response fields and resolves $ref schemas', async function () {
    await renderPage()
    const read = endpoint('mcpReadDoc')
    expect(within(read).getByText('Document path.')).to.exist
    expect(within(read).getByText('File path.')).to.exist
    // one level of nested fields under an object property
    expect(within(read).getByText('size')).to.exist
    expect(
      within(read).getAllByText('Example:', { exact: false }).length
    ).to.be.above(0)
    expect(within(read).getByText('"file" | "folder" | null')).to.exist
  })

  it('marks required request fields and shows the request schema', async function () {
    await renderPage()
    const register = endpoint('oauthRegister')
    expect(within(register).getAllByText('required').length).to.be.above(0)
    expect(within(register).getByText('client_name')).to.exist
  })

  it('filters endpoints by summary and path, and clears the filter', async function () {
    await renderPage()
    const search = screen.getByRole('searchbox', {
      name: 'Filter endpoints by path, summary, method or tag',
    })

    fireEvent.change(search, { target: { value: 'register' } })
    expect(document.getElementById('oauthRegister')).to.exist
    expect(document.getElementById('mcpReadDoc')).to.not.exist
    expect(screen.getByText('1 of 4 endpoints')).to.exist

    fireEvent.change(search, { target: { value: 'post /api/v0' } })
    expect(document.getElementById('uploadFile')).to.exist
    expect(document.getElementById('oauthRegister')).to.not.exist

    fireEvent.change(search, { target: { value: 'nothing-matches-this' } })
    expect(screen.getByText(/No endpoints match/)).to.exist
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(document.getElementById('mcpReadDoc')).to.exist
    expect((search as HTMLInputElement).value).to.equal('')
  })

  it('filters by tag name', async function () {
    await renderPage()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'uploads' } })
    expect(document.getElementById('uploadFile')).to.exist
    expect(document.getElementById('exportPdf')).to.not.exist
  })

  it('describes each authentication scheme with a header example', async function () {
    await renderPage()
    const auth = document.getElementById('authentication')
    expect(auth).to.exist
    const bearer = document.getElementById('auth-mcpbearerauth')
    expect(bearer).to.exist
    expect(within(bearer!).getByText('Send a personal access token.')).to.exist
    expect(bearer!.textContent).to.include('Authorization: Bearer <token>')

    const session = document.getElementById('auth-sessionauth')
    expect(session!.textContent).to.include(
      'Cookie: overleaf_session2=<session-cookie>'
    )
    expect(session!.textContent).to.include('X-CSRF-Token: <csrf-token>')
  })

  it('renders backtick spans as inline code and keeps paragraphs', async function () {
    await renderPage()
    const intro = document.querySelector('.api-docs-intro')!
    expect(intro.querySelector('code')).to.exist
    expect(intro.querySelectorAll('p')).to.have.length(2)
    expect(within(endpoint('mcpReadDoc')).getByText('1 MB').tagName).to.equal(
      'CODE'
    )
  })

  it('shows curl samples with auth, query and JSON body', async function () {
    await renderPage()
    const read = endpoint('mcpReadDoc')
    const curl = within(read).getByRole('tabpanel').textContent || ''
    expect(curl).to.include(
      '"$OVERLEAF_URL/api/v0/mcp/projects/proj-1/doc?path=main.tex"'
    )
    expect(curl).to.include('-H "Authorization: Bearer $OVERLEAF_TOKEN"')

    const register = endpoint('oauthRegister')
    const body = within(register).getByRole('tabpanel').textContent || ''
    expect(body).to.include('-X POST')
    expect(body).to.include('"client_name": "<client_name>"')
    expect(body).to.not.include('Authorization')
  })

  it('switches code sample tabs to JavaScript and Python', async function () {
    await renderPage()
    const read = endpoint('mcpReadDoc')

    fireEvent.click(within(read).getByRole('tab', { name: 'JavaScript' }))
    expect(
      within(read)
        .getByRole('tab', { name: 'JavaScript' })
        .getAttribute('aria-selected')
    ).to.equal('true')
    expect(within(read).getByRole('tabpanel').textContent).to.include(
      'fetch(url, {'
    )

    fireEvent.click(within(read).getByRole('tab', { name: 'Python' }))
    const python = within(read).getByRole('tabpanel').textContent || ''
    expect(python).to.include('requests.get(')
    expect(python).to.include('"Authorization": "Bearer <token>"')
    expect(python).to.include('"path": "main.tex"')
  })

  it('uses multipart flags for file uploads and cookie auth for session endpoints', async function () {
    await renderPage()
    const upload = endpoint('uploadFile')
    const curl = within(upload).getByRole('tabpanel').textContent || ''
    expect(curl).to.include('-F "file=@path/to/file"')
    expect(curl).to.include('-F "name=figure.png"')
    expect(curl).to.include('Cookie: overleaf_session2=$OVERLEAF_SESSION')
    expect(curl).to.include('-H "X-CSRF-Token: $OVERLEAF_CSRF_TOKEN"')

    fireEvent.click(within(upload).getByRole('tab', { name: 'Python' }))
    const python = within(upload).getByRole('tabpanel').textContent || ''
    expect(python).to.include(`"file": open("path/to/file", 'rb')`)
  })

  it('writes binary responses to a file in the samples', async function () {
    await renderPage()
    const pdf = endpoint('exportPdf')
    expect(within(pdf).getByRole('tabpanel').textContent).to.include(
      '-o download.pdf'
    )
    expect(within(pdf).getByText('Binary file download.')).to.exist
  })

  it('copies a code sample to the clipboard', async function () {
    const writeText = sinon.stub().resolves()
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    try {
      await renderPage()
      const read = endpoint('mcpReadDoc')
      // The label comes from translations, which are empty in tests, so
      // find the button by its class instead of its accessible name
      const copy = read.querySelector('.copy-button') as HTMLElement
      fireEvent.click(copy)
      expect(writeText).to.have.been.calledOnce
      expect(writeText.firstCall.args[0]).to.include(
        '"$OVERLEAF_URL/api/v0/mcp'
      )
    } finally {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard')
    }
  })

  it('shows an error when the spec cannot be loaded', async function () {
    fetchMock.removeRoutes()
    fetchMock.get('/api/v0/openapi.json', 500)
    fetchMock.get('/system/messages', [])
    renderRoot()
    await waitFor(() =>
      screen.getByText(/The API reference could not be loaded/)
    )
  })

  it('returns empty prefix and suffixes for empty paths in splitSharedPrefix without looping infinitely', function () {
    const result = splitSharedPrefix([])
    expect(result).to.deep.equal({ prefix: '', suffixes: [] })
  })

  it('calls onNavigate only when clicking an anchor in the mobile drawer navigation', function () {
    const onNavigate = sinon.spy()
    const sections = [
      {
        groupName: null,
        tags: [
          {
            name: 'Test Tag',
            anchor: 'tag-test',
            endpoints: [
              {
                id: 'get-test',
                path: '/test',
                method: 'get' as const,
                operation: { summary: 'Get test' },
              },
            ],
          },
        ],
      },
    ]
    render(
      <ApiDocsSidebar
        sections={sections}
        query=""
        onQueryChange={() => {}}
        matchCount={1}
        totalCount={1}
        hasAuth={false}
        onNavigate={onNavigate}
      />
    )
    const list = document.querySelector('.api-docs-nav-list.api-docs-nav')!
    fireEvent.click(list)
    expect(onNavigate).to.not.have.been.called

    const anchor = within(list as HTMLElement).getByRole('link', {
      name: 'Test Tag',
    })
    fireEvent.click(anchor)
    expect(onNavigate).to.have.been.calledOnce
  })

  it('safely handles spec without paths in listEndpoints', function () {
    const testSpec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: 'v1' },
    } as unknown as OpenApiSpec
    expect(listEndpoints(testSpec)).to.deep.equal([])
  })

  it('preserves outer schema description and local properties when resolving allOf', function () {
    const testSpec: OpenApiSpec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: 'v1' },
      paths: {},
      components: {
        schemas: {
          BaseEntity: {
            type: 'object',
            description: 'Base entity description',
            properties: {
              id: { type: 'string', description: 'Entity identifier' },
            },
            required: ['id'],
          },
        },
      },
    }
    const outerSchema: SchemaObject = {
      description: 'Custom outer description',
      allOf: [{ $ref: '#/components/schemas/BaseEntity' }],
      properties: {
        name: { type: 'string', description: 'Entity name' },
      },
      required: ['name'],
    }
    const resolved = resolveSchema(testSpec, outerSchema)
    expect(resolved.description).to.equal('Custom outer description')
    expect(resolved.properties).to.have.all.keys('id', 'name')
    expect(resolved.required).to.deep.equal(['id', 'name'])
  })

  it('falls back to merged allOf description when outer schema has no description', function () {
    const testSpec: OpenApiSpec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: 'v1' },
      paths: {},
      components: {
        schemas: {
          BaseEntity: {
            type: 'object',
            description: 'Base entity description',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    }
    const outerSchema: SchemaObject = {
      allOf: [{ $ref: '#/components/schemas/BaseEntity' }],
      properties: {
        extra: { type: 'string' },
      },
    }
    const resolved = resolveSchema(testSpec, outerSchema)
    expect(resolved.description).to.equal('Base entity description')
    expect(resolved.properties).to.have.all.keys('id', 'extra')
  })

  it('displays field rows for array response schemas in SchemaTable', function () {
    const testSpec: OpenApiSpec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: 'v1' },
      paths: {},
      components: {
        schemas: {
          Project: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Project ID' },
              name: { type: 'string', description: 'Project name' },
            },
            required: ['id'],
          },
        },
      },
    }
    const arraySchema: SchemaObject = {
      type: 'array',
      items: { $ref: '#/components/schemas/Project' },
    }
    render(<SchemaTable spec={testSpec} schema={arraySchema} />)
    expect(screen.getByText('id')).to.exist
    expect(screen.getByText('name')).to.exist
    expect(screen.getByText('Project ID')).to.exist
    expect(screen.getByText('Project name')).to.exist
    expect(screen.getByText('required')).to.exist
  })

  it('handles JSON request body with undefined value in samples', function () {
    const testSpec: OpenApiSpec = {
      openapi: '3.0.3',
      info: { title: 'Test', version: 'v1' },
      paths: {},
    }
    const endpointItem: Endpoint = {
      id: 'testOp',
      path: '/test',
      method: 'post',
      operation: {
        requestBody: {
          content: {
            'application/json': {},
          },
        },
        responses: {},
      },
    }
    const samples = buildSamples(testSpec, endpointItem, 'http://localhost')
    expect(samples.curl).to.include("-d '{}'")
  })
})
