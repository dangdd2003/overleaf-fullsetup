import Settings from '@overleaf/settings'

if (Settings.enableMcp === undefined) {
  Settings.enableMcp = process.env.MCP_ENABLED === 'true'
}
