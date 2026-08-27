import Settings from '@overleaf/settings'
import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import PersonalAccessTokenController from './PersonalAccessTokenController.mjs'
import Oauth2TokenInfoController from './Oauth2TokenInfoController.mjs'
import GitBridgeApiController from './GitBridgeApiController.mjs'
import FileStoreController from '../FileStore/FileStoreController.mjs'

if (Settings.enableGitBridge === undefined) {
  Settings.enableGitBridge =
    process.env.GIT_BRIDGE_ENABLED === 'true' ||
    process.env.OVERLEAF_GIT_BRIDGE_ENABLED === 'true'
}

const GitBridgeRouter = {
  apply(webRouter, privateApiRouter, publicApiRouter) {
    // 1. User Personal Access Token (PAT) Management (Session Login & CSRF protected)
    webRouter.post(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.createToken
    )
    webRouter.get(
      '/user/personal-access-tokens',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.listTokens
    )
    webRouter.delete(
      '/user/personal-access-tokens/:tokenId',
      AuthenticationController.requireLogin(),
      PersonalAccessTokenController.revokeToken
    )

    // 2. OAuth2 Token Verification (token-authenticated)
    for (const r of [webRouter, publicApiRouter, privateApiRouter]) {
      r.get('/oauth/token/info', Oauth2TokenInfoController.getTokenInfo)
    }

    // 3. Snapshot and File APIs (token-authenticated with project-level authorization)
    for (const r of [webRouter, publicApiRouter, privateApiRouter]) {
      r.get(
        '/api/v0/docs/:projectId',
        GitBridgeApiController.requireGitBridgeAuth,
        GitBridgeApiController.requireProjectRead,
        GitBridgeApiController.getDoc
      )
      r.get(
        '/api/v0/docs/:projectId/saved_vers',
        GitBridgeApiController.requireGitBridgeAuth,
        GitBridgeApiController.requireProjectRead,
        GitBridgeApiController.getSavedVers
      )
      r.get(
        '/api/v0/docs/:projectId/snapshots/:versionId',
        GitBridgeApiController.requireGitBridgeAuth,
        GitBridgeApiController.requireProjectRead,
        GitBridgeApiController.getSnapshot
      )
      r.get(
        '/api/v0/docs/:projectId/file/:fileId',
        GitBridgeApiController.requireGitBridgeAuth,
        GitBridgeApiController.requireProjectRead,
        FileStoreController.getFile
      )
      r.post(
        '/api/v0/docs/:projectId/snapshots',
        GitBridgeApiController.requireGitBridgeAuth,
        GitBridgeApiController.requireProjectWrite,
        GitBridgeApiController.pushSnapshot
      )
    }
  },
}

export default GitBridgeRouter
export { GitBridgeRouter }
