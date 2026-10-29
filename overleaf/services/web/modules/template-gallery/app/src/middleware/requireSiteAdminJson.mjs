import SessionManager from '../../../../../app/src/Features/Authentication/SessionManager.mjs'
import AuthorizationManager from '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs'

/**
 * Express middleware that checks if the request is from an authenticated site administrator,
 * returning JSON errors rather than HTML redirects.
 *
 * - 401 { error: "login_required" } if no userId
 * - 403 { error: "forbidden" } if not a site admin
 * - otherwise next()
 */
export async function requireSiteAdminJson(req, res, next) {
  const userId =
    SessionManager.getLoggedInUserId(req.session) ||
    req.session?.user?._id ||
    req.session?.passport?.user

  if (!userId) {
    return res.status(401).json({ error: 'login_required' })
  }

  try {
    const isSiteAdmin =
      typeof AuthorizationManager.promises?.isUserSiteAdmin === 'function'
        ? await AuthorizationManager.promises.isUserSiteAdmin(userId)
        : await new Promise((resolve, reject) => {
            AuthorizationManager.isUserSiteAdmin(userId, (err, isAdmin) => {
              if (err) return reject(err)
              resolve(Boolean(isAdmin))
            })
          })

    if (!isSiteAdmin) {
      return res.status(403).json({ error: 'forbidden' })
    }

    return next()
  } catch (_err) {
    return res.status(403).json({ error: 'forbidden' })
  }
}

export default requireSiteAdminJson
