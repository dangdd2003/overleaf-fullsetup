import logger from '@overleaf/logger'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import Features from '../../../../app/src/infrastructure/Features.mjs'
import AdminProjectManagementController from './AdminProjectManagementController.mjs'

const rateLimiter = new RateLimiter('admin_project_mutations', {
  points: 30,
  duration: 60,
})

export default {
  apply(webRouter) {
    logger.debug({}, 'Init AdminProjectManagement router')

    if (!Features.hasFeature('admin-project-management')) {
      // Feature is disabled: register no routes at all, leaving the
      // instance's behaviour identical to stock upstream Overleaf CE
      // (the "Project URL Lookup" admin menu link is also hidden in
      // this case, see layout-react.pug / navbar-marketing.pug).
      return
    }

    const rateLimit = RateLimiterMiddleware.rateLimit(rateLimiter)

    webRouter.get(
      '/admin/project',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminProjectManagementController.renderLookupPage
    )

    webRouter.get(
      '/admin/project/lookup',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminProjectManagementController.resolveLookup
    )

    webRouter.get(
      '/admin/project/:projectId',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminProjectManagementController.renderProjectDetail
    )

    webRouter.post(
      '/admin/project/:projectId/transfer',
      rateLimit,
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminProjectManagementController.transferOwnership
    )
  },
}
