const defaultFeatures = {
  collaborators: -1,
  dropbox: true,
  github: true,
  gitBridge: true,
  versioning: true,
  compileTimeout: 180,
  compileGroup: 'standard',
  references: true,
  trackChanges: true,
}

const apis = new Proxy(
  {
    v1: { url: 'http://localhost/api/v1' },
    v1_history: { url: 'http://localhost/api/v1_history' },
    linkedUrlProxy: { url: 'http://localhost/proxy' },
    documentupdater: { url: 'http://localhost/docupdater' },
    docstore: {
      url: 'http://localhost/docstore',
      pubUrl: 'http://localhost/docstore',
    },
    filestore: { url: 'http://localhost/filestore' },
    clsi: { url: 'http://localhost/clsi' },
    project_history: { url: 'http://localhost/project_history' },
    thirdPartyDataStore: { url: 'http://localhost/tpds' },
    web: { url: 'http://localhost/web' },
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop]
      return {
        url: `http://localhost/${String(prop)}`,
        pubUrl: `http://localhost/${String(prop)}`,
      }
    },
  }
)

const features = new Proxy(
  {},
  {
    get() {
      return defaultFeatures
    },
  }
)

const settings = {
  siteUrl: 'http://localhost:3000',
  internalHost: '127.0.0.1',
  port: 3000,
  mongo: {
    url: 'mongodb://localhost:27017/test',
    options: {},
    hasSecondaries: false,
  },
  redis: {},
  security: {
    bcryptRounds: 12,
  },
  apis,
  features,
  plans: [],
  path: {
    dumpFolder: '/tmp',
  },
  validRootDocExtensions: ['tex'],
  textExtensions: ['tex', 'bib', 'sty', 'cls', 'txt', 'md'],
  max_doc_length: 2000000,
  editableFilenames: [],
  fileIgnorePattern: '**/.git/**',
  moduleImportSequence: [],
  enabledLinkedFileTypes: [],
  defaultFeatures,
  personalAccessTokens: { expiry: { warningWindowDays: 2 } },
  overleaf: {},
  enableGitBridge: true,
  enableGithubSync: false,
  lockManager: {},
  limits: {
    httpGlobalAgentMaxSockets: 40,
    httpsGlobalAgentMaxSockets: 40,
  },
}

export default settings
