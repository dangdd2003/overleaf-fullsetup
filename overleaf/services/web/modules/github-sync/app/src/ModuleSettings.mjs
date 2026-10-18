import Settings from '@overleaf/settings'

if (Settings.enableGithubSync === undefined) {
  Settings.enableGithubSync = process.env.GITHUB_SYNC_ENABLED === 'true'
}

if (Settings.githubSync === undefined) {
  const siteUrl = Settings.siteUrl || 'http://localhost'

  Settings.githubSync = {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    redirectUri: `${siteUrl}/auth/github/callback`,
    // Generated and persisted by server-ce/init_scripts/100_generate_github_secret.sh
    tokenSecret: process.env.GITHUB_TOKEN_ENCRYPTION_SECRET || '',
    reposDir: '/var/lib/overleaf/data/github-sync/repos',
    // Point both at a GitHub Enterprise Server to sync with it instead
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
