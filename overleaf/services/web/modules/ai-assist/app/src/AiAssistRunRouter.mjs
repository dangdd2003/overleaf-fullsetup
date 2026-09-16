import Settings from '@overleaf/settings'

export default {
  async apply(webRouter) {
    if (!Settings.aiAssist?.enabled) return

    const { default: AiAssistRunController } = await import('./AiAssistRunController.mjs')
    const { default: AuthenticationController } = await import('../../../../app/src/Features/Authentication/AuthenticationController.mjs')
    const { default: AuthorizationMiddleware } = await import('../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs')

    // 1. Primary project-scoped routes with strict authorization
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.createRun
    )

    webRouter.get(
      '/ai-assist/projects/:Project_id/runs/:runId/stream',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistRunController.streamRun
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/stop',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.stopRun
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/approve',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.approve
    )

    // 2. Legacy fallback routes (controller performs inline authorization check)
    webRouter.get(
      '/ai-assist/runs/:runId/stream',
      AuthenticationController.requireLogin(),
      AiAssistRunController.streamRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/stop',
      AuthenticationController.requireLogin(),
      AiAssistRunController.stopRun
    )

    webRouter.post(
      '/ai-assist/runs/:runId/approve',
      AuthenticationController.requireLogin(),
      AiAssistRunController.approve
    )
  },
}
