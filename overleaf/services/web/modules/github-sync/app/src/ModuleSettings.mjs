import Settings from '@overleaf/settings'

if (Settings.enableGithubSync === undefined) {
  Settings.enableGithubSync = process.env.GITHUB_SYNC_ENABLED === 'true'
}

if (Settings.githubSync === undefined) {
  const siteUrl =
    Settings.siteUrl ||
    process.env.OVERLEAF_SITE_URL ||
    'http://localhost'
  const tokenSecret = process.env.GITHUB_TOKEN_SECRET || ''

  Settings.githubSync = {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    redirectUri:
      process.env.GITHUB_REDIRECT_URI ||
      `${siteUrl}/auth/github/callback`,
    tokenSecret,
    reposDir:
      process.env.GITHUB_SYNC_REPOS_DIR ||
      '/var/lib/overleaf/data/github-sync/repos',
    apiBase: process.env.GITHUB_API_BASE || 'https://api.github.com',
    gitBase: process.env.GITHUB_GIT_BASE || 'https://github.com',
  }
}

if (
  Settings.githubSyncEncryptorOptions === undefined &&
  Settings.githubSync.tokenSecret
) {
  Settings.githubSyncEncryptorOptions = {
    cipherLabel: '2026.1-v3',
    cipherPasswords: {
      '2026.1-v3': Settings.githubSync.tokenSecret,
    },
  }
}

export default Settings.githubSync
