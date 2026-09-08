const os = require('node:os')
const path = require('node:path')
const base = require(process.env.BASE_CONFIG)

module.exports = base.mergeWith({
  enableGithubSync: true,
  githubSync: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenSecret: 'this-is-a-weak-secret-for-tests-2026.1-v3',
    reposDir: path.join(os.tmpdir(), 'ghsync-acceptance-repos'),
    apiBase: 'https://api.github.com',
    gitBase: 'https://github.com',
  },
  githubSyncEncryptorOptions: {
    cipherLabel: '2026.1-v3',
    cipherPasswords: {
      '2026.1-v3': 'this-is-a-weak-secret-for-tests-2026.1-v3',
    },
  },
})
