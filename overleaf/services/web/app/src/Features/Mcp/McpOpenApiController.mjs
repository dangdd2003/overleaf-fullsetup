const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Overleaf MCP Web API',
    version: '1.0.0',
    description:
      'REST API powering the Overleaf Model Context Protocol (MCP) microservice and Custom GPT Actions.',
  },
  servers: [{ url: '/api/v0/mcp' }],
  components: {
    securitySchemes: {
      OAuth2: {
        type: 'oauth2',
        description: 'OAuth 2.1 Authorization Code with PKCE',
        flows: {
          authorizationCode: {
            authorizationUrl: '/oauth/authorize',
            tokenUrl: '/oauth/token',
            scopes: {
              mcp: 'Full access to Overleaf projects and authoring tools',
            },
          },
        },
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT or PAT',
      },
    },
  },
  security: [{ OAuth2: ['mcp'] }, { BearerAuth: [] }],
  paths: {
    '/projects': {
      get: {
        summary: 'List projects',
        operationId: 'listProjects',
        responses: { '200': { description: 'Project list' } },
      },
      post: {
        summary: 'Create project',
        operationId: 'createProject',
        responses: { '200': { description: 'Created project' } },
      },
    },
    '/projects/{projectId}': {
      get: {
        summary: 'Get project metadata',
        operationId: 'getProject',
        responses: { '200': { description: 'Project details' } },
      },
    },
    '/projects/{projectId}/files': {
      get: {
        summary: 'List project files',
        operationId: 'listFiles',
        responses: { '200': { description: 'Files tree' } },
      },
    },
    '/projects/{projectId}/search': {
      get: {
        summary: 'Search project files for text or patterns',
        operationId: 'searchFiles',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'query', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'path', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'fileTypes', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'caseSensitive', in: 'query', required: false, schema: { type: 'boolean', default: false } },
          { name: 'maxMatches', in: 'query', required: false, schema: { type: 'integer', default: 30 } },
        ],
        responses: { '200': { description: 'Matching lines and snippets' } },
      },
    },
    '/projects/{projectId}/compile': {
      post: {
        summary: 'Trigger project compile',
        operationId: 'compileProject',
        responses: { '200': { description: 'Compile output' } },
      },
    },
    '/projects/{projectId}/compile/log': {
      get: {
        summary: 'Get compile log',
        operationId: 'getCompileLog',
        responses: { '200': { description: 'Raw build log' } },
      },
    },
    '/projects/{projectId}/compile/pdf': {
      get: {
        summary: 'Download compiled PDF',
        operationId: 'getCompilePdf',
        responses: { '200': { description: 'PDF stream' } },
      },
    },
  },
}

const McpOpenApiController = {
  getSpec(req, res) {
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send(JSON.stringify(OPENAPI_SPEC, null, 2))
  },
}

export default McpOpenApiController
