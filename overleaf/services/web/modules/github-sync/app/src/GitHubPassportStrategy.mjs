import OAuth2Module from 'passport-oauth2'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { User } from '../../../../app/src/models/User.mjs'
import UserAuditLogHandler from '../../../../app/src/Features/User/UserAuditLogHandler.mjs'
import GitHubApiManager from './GitHubApiManager.mjs'
import GitHubCredentialsManager from './GitHubCredentialsManager.mjs'

const PROVIDER = 'github'
const OAuth2Strategy = OAuth2Module?.Strategy || OAuth2Module

// Core of the OAuth verify callback; exported separately for unit testing.
export async function handleOAuthVerify(req, accessToken, refreshToken, profile) {
  const userId = req.user._id
  const email = await GitHubApiManager.promises.getPrimaryEmail(accessToken)
  await GitHubCredentialsManager.promises.storeCredentials(userId, {
    githubUserId: profile.id,
    githubUsername: profile.login,
    email,
    accessToken,
    scope: ['repo', 'user:email'],
  })
  // Mongo rejects $pull and $push on one field in a single update, so drop any
  // previous github entry first — otherwise re-linking appends a duplicate.
  await User.updateOne(
    { _id: userId },
    { $pull: { thirdPartyIdentifiers: { providerId: PROVIDER } } }
  )
  await User.updateOne(
    { _id: userId },
    {
      $set: { 'features.github': true },
      $push: {
        thirdPartyIdentifiers: {
          providerId: PROVIDER,
          externalUserId: String(profile.id),
        },
      },
    }
  )
  await UserAuditLogHandler.promises.addEntry(
    userId,
    'link-github',
    userId,
    req.ip,
    { providerId: PROVIDER, githubUsername: profile.login }
  )
  req.session.projectSyncSuccessMessage = 'GitHub account linked'
  return true
}

export function createStrategy(passport) {
  if (!Settings.enableGithubSync) return
  if (!Settings.githubSync?.clientId || !Settings.githubSync?.clientSecret) {
    logger.warn(
      {},
      'GitHub sync enabled but GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET missing; skipping strategy registration'
    )
    return
  }

  class GitHubStrategy extends OAuth2Strategy {
    constructor() {
      super(
        {
          authorizationURL: 'https://github.com/login/oauth/authorize',
          tokenURL: 'https://github.com/login/oauth/access_token',
          clientID: Settings.githubSync.clientId,
          clientSecret: Settings.githubSync.clientSecret,
          callbackURL:
            Settings.githubSync?.redirectUri ||
            `${Settings.siteUrl}/auth/github/callback`,
          scope: ['repo', 'user:email'],
          passReqToCallback: true,
          // The callback is mounted on the non-CSRF router, so the OAuth state
          // parameter is the only thing stopping an attacker from replaying
          // their own `code` to bind their GitHub account to a victim's session.
          state: true,
        },
        async (req, accessToken, refreshToken, params, profile, done) => {
          try {
            const user = await GitHubApiManager.promises.getUser(accessToken)
            const ok = await handleOAuthVerify(req, accessToken, refreshToken, {
              id: user.id,
              login: user.login,
            })
            done(null, ok)
          } catch (err) {
            done(err)
          }
        }
      )
      this.name = 'github-sync'
    }
  }

  passport.use(new GitHubStrategy())
}

export default { createStrategy, handleOAuthVerify }
