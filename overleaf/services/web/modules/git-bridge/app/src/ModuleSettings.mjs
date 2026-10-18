import Settings from '@overleaf/settings'

if (Settings.enableGitBridge === undefined) {
  Settings.enableGitBridge = process.env.GIT_BRIDGE_ENABLED === 'true'
}
