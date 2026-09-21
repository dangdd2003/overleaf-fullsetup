import Settings from '@overleaf/settings'

if (Settings.enableApiDocs === undefined) {
  Settings.enableApiDocs = process.env.API_DOCS_ENABLED === 'true'
}

export default Settings
