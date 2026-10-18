
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
    '/projects-zip': {
      get: {
        summary: 'Download several projects as one zip (projectIds as a comma-separated query)',
        operationId: 'downloadProjectsZip',
        responses: { '200': { description: 'Zip archive' } },
      },
      post: {
        summary: 'Download several projects as one zip (projectIds in the body)',
        operationId: 'downloadProjectsZipPost',
        responses: { '200': { description: 'Zip archive' } },
      },
    },
    '/projects/{projectId}': {
      get: {
        summary: 'Get project metadata, settings and allowed values',
        operationId: 'getProject',
        responses: { '200': { description: 'Project details' } },
      },
      delete: {
        summary: 'Permanently delete a project (owner only, requires confirm)',
        operationId: 'deleteProject',
        responses: { '200': { description: 'Project deleted' } },
      },
    },
    '/projects/{projectId}/settings': {
      patch: {
        summary: 'Update name, compiler, image, spell check or root document',
        operationId: 'updateProjectSettings',
        responses: { '200': { description: 'Before/after changes' } },
      },
    },
    '/projects/{projectId}/status': {
      post: {
        summary: 'Archive, trash or restore a project for the caller',
        operationId: 'setProjectStatus',
        responses: { '200': { description: 'New status' } },
      },
    },
    '/projects/{projectId}/copy': {
      post: {
        summary: 'Duplicate a project',
        operationId: 'copyProject',
        responses: { '200': { description: 'The new project' } },
      },
    },
    '/projects/{projectId}/tree': {
      get: {
        summary: 'List project files and folders',
        operationId: 'listFiles',
        responses: { '200': { description: 'Files tree' } },
      },
    },
    '/projects/{projectId}/zip': {
      get: {
        summary: 'Download the whole project as a zip',
        operationId: 'downloadProjectZip',
        responses: { '200': { description: 'Zip archive' } },
      },
    },
    '/projects/{projectId}/doc': {
      get: {
        summary: 'Read a text document, optionally a line range',
        operationId: 'readDoc',
        responses: { '200': { description: 'Document lines' } },
      },
      post: {
        summary: 'Create or replace a text document',
        operationId: 'writeDoc',
        responses: { '200': { description: 'Write result' } },
      },
    },
    '/projects/{projectId}/file': {
      get: {
        summary: 'Download a binary file by path (text documents are read with readDoc)',
        operationId: 'downloadFile',
        responses: { '200': { description: 'File contents' } },
      },
      post: {
        summary: 'Upload a binary file from base64 content or a URL',
        operationId: 'uploadFile',
        responses: { '200': { description: 'Stored file' } },
      },
      delete: {
        summary: 'Delete a file or folder by path',
        operationId: 'deleteFile',
        responses: { '200': { description: 'Deleted entity' } },
      },
    },
    '/projects/{projectId}/folder': {
      post: {
        summary: 'Create a folder, with any missing parents',
        operationId: 'createFolder',
        responses: { '200': { description: 'Folder created' } },
      },
    },
    '/projects/{projectId}/move': {
      post: {
        summary: 'Move or rename a document, file or folder',
        operationId: 'moveEntity',
        responses: { '200': { description: 'Entity moved' } },
      },
    },
    '/projects/{projectId}/wordcount': {
      get: {
        summary: 'Count words, characters and lines in the project documents',
        operationId: 'wordCount',
        responses: { '200': { description: 'Word counts' } },
      },
    },
    '/projects/{projectId}/search': {
      get: {
        summary: 'Search project files for text or patterns',
        operationId: 'searchFiles',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'query', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'regex', in: 'query', required: false, schema: { type: 'boolean', default: false } },
          { name: 'caseSensitive', in: 'query', required: false, schema: { type: 'boolean', default: false } },
          { name: 'path', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'glob', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'contextLines', in: 'query', required: false, schema: { type: 'integer', default: 0 } },
          { name: 'maxMatches', in: 'query', required: false, schema: { type: 'integer', default: 50 } },
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
    '/projects/{projectId}/compile/diagnostics': {
      get: {
        summary: 'Parsed compile log: errors, warnings, bad boxes and advice',
        operationId: 'getCompileDiagnostics',
        responses: { '200': { description: 'Structured log diagnostics' } },
      },
    },
    '/projects/{projectId}/compile/pdf-page': {
      get: {
        summary:
          'Render one page of a build as an image, with a SyncTeX map from page heights to source lines and the bad boxes on the page',
        operationId: 'getCompiledPdfPage',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'buildId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'clsiserverid', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'path', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'line', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'region', in: 'query', required: false, schema: { type: 'string', enum: ['full', 'top', 'middle', 'bottom'], default: 'full' } },
          { name: 'endLine', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'With path and line: the last line of the block to zoom on' },
          { name: 'maxEdgePx', in: 'query', required: false, schema: { type: 'integer', minimum: 512, maximum: 2576, default: 1568 } },
          { name: 'grayscale', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Defaults to true, or false when zooming on a block with endLine' },
          { name: 'split', in: 'query', required: false, schema: { type: 'string', enum: ['none', 'halves'], default: 'none' } },
          { name: 'labels', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Draw block ids [B1], [B2], ... on the image' },
        ],
        responses: { '200': { description: 'Page images (base64, one per part) and their source map' } },
      },
    },
    '/projects/{projectId}/compile/pdf-overview': {
      get: {
        summary: 'Thumbnails of up to 12 pages of a build in one image, with what measuring each page found',
        operationId: 'getCompiledPdfOverview',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'buildId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'clsiserverid', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'fromPage', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'toPage', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': { description: 'Overview image and per-page measurements' } },
      },
    },
    '/projects/{projectId}/compile/pdf-search': {
      get: {
        summary: 'Find text in the rendered PDF, with each match page, height and source line',
        operationId: 'searchCompiledPdf',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'buildId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'clsiserverid', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'query', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'fromPage', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'toPage', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': { description: 'Matches with page, height and source' } },
      },
    },
    '/projects/{projectId}/compile/pdf-diff': {
      get: {
        summary: 'Compare the pages of two builds of a project, pixel by pixel, with the changed regions boxed',
        operationId: 'diffCompiledPdf',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'buildId', in: 'query', required: true, schema: { type: 'string' }, description: 'The newer build' },
          { name: 'beforeBuildId', in: 'query', required: false, schema: { type: 'string' }, description: 'The older build; defaults to the one compiled before buildId' },
          { name: 'clsiserverid', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Changed pages, regions and an annotated image' } },
      },
    },
    '/projects/{projectId}/compile/pdf-block': {
      get: {
        summary: 'Resolve a block id drawn on a page image (B3) to its source file and lines',
        operationId: 'resolveCompiledPdfBlock',
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'buildId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'clsiserverid', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'blockId', in: 'query', required: true, schema: { type: 'string', pattern: '^B\\d+$' } },
        ],
        responses: { '200': { description: 'File, line and endLine of the block' } },
      },
    },
    '/projects/{projectId}/compile/clean': {
      post: {
        summary: 'Clear the build auxiliary files so the next compile starts clean',
        operationId: 'cleanCompile',
        responses: { '200': { description: 'Status ok' } },
      },
    },
    '/projects/{projectId}/compile/clear-cache': {
      post: {
        summary: 'Deprecated name for cleanCompile',
        operationId: 'clearCompileCache',
        deprecated: true,
        responses: { '200': { description: 'Status ok' } },
      },
    },
    '/projects/{projectId}/synctex': {
      get: {
        summary: 'Map a PDF position to source lines, or a source line to PDF positions',
        operationId: 'syncTex',
        responses: { '200': { description: 'SyncTeX positions' } },
      },
    },
    '/projects/{projectId}/history': {
      get: {
        summary: 'List recent project history versions, optionally for one path',
        operationId: 'listHistory',
        responses: { '200': { description: 'History entries' } },
      },
    },
    '/projects/{projectId}/history/diff': {
      get: {
        summary: 'Changes to one document between two history versions',
        operationId: 'getHistoryDiff',
        responses: { '200': { description: 'Line-anchored changes' } },
      },
    },
    '/projects/{projectId}/history/restore': {
      post: {
        summary: 'Restore one file to its content at a history version',
        operationId: 'restoreFile',
        responses: { '200': { description: 'Restored entity' } },
      },
    },
    '/tags': {
      get: {
        summary: 'List your project tags, optionally with the tagged project ids',
        operationId: 'listTags',
        responses: { '200': { description: 'Tags' } },
      },
      post: {
        summary: 'Create a tag (returns the existing tag when the name is taken)',
        operationId: 'createTag',
        responses: { '200': { description: 'The tag' } },
      },
    },
    '/tags/{tagId}': {
      patch: {
        summary: 'Rename a tag or change its colour',
        operationId: 'updateTag',
        responses: { '200': { description: 'The tag before and after' } },
      },
      delete: {
        summary: 'Delete a tag; the tagged projects are not touched',
        operationId: 'deleteTag',
        responses: { '200': { description: 'Deleted tag' } },
      },
    },
    '/tags/{tagId}/projects': {
      post: {
        summary: 'Add projects to a tag',
        operationId: 'addProjectsToTag',
        responses: { '200': { description: 'Added and already-tagged ids' } },
      },
    },
    '/tags/{tagId}/projects/remove': {
      post: {
        summary: 'Remove projects from a tag',
        operationId: 'removeProjectsFromTag',
        responses: { '200': { description: 'Removed and not-tagged ids' } },
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
