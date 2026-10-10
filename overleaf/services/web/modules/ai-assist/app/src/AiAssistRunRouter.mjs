import Settings from '@overleaf/settings'

export default {
  async apply(webRouter) {
    if (!Settings.aiAssist?.enabled) return

    const { default: AiAssistRunController } =
      await import('./AiAssistRunController.mjs')
    const { default: AuthenticationController } =
      await import('../../../../app/src/Features/Authentication/AuthenticationController.mjs')
    const { default: AuthorizationMiddleware } =
      await import('../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs')

    // 0. Provider requests (model list, connection test, in-page agent turns)
    // are made from the server so internal providers work behind a public domain.
    const { default: AiAssistProviderController } =
      await import('./AiAssistProviderController.mjs')

    webRouter.post(
      '/ai-assist/providers/models',
      AuthenticationController.requireLogin(),
      AiAssistProviderController.listModels
    )

    webRouter.post(
      '/ai-assist/providers/test',
      AuthenticationController.requireLogin(),
      AiAssistProviderController.test
    )

    webRouter.post(
      '/ai-assist/providers/chat',
      AuthenticationController.requireLogin(),
      AiAssistProviderController.chat
    )

    // Text only: the AI inside the editor, which never gets tools
    webRouter.post(
      '/ai-assist/providers/editor',
      AuthenticationController.requireLogin(),
      AiAssistProviderController.editorText
    )

    if (Settings.aiAssist?.webToolsEnabled) {
      webRouter.post(
        '/ai-assist/web-search/test',
        AuthenticationController.requireLogin(),
        AiAssistProviderController.testWebSearch
      )

      // Site icons for web result rows, fetched here because most sites only
      // name theirs in the home page's HTML.
      const { default: AiAssistFavicon } = await import('./AiAssistFavicon.mjs')
      webRouter.get(
        '/ai-assist/favicon',
        AuthenticationController.requireLogin(),
        AiAssistFavicon.serve
      )

      // web_search / web_fetch for the compile-log fix, which runs in the page
      const { default: AiAssistWebToolsController } =
        await import('./AiAssistWebToolsController.mjs')
      webRouter.post(
        '/ai-assist/projects/:Project_id/web-tools',
        AuthenticationController.requireLogin(),
        AuthorizationMiddleware.ensureUserCanReadProject,
        AiAssistWebToolsController.specs
      )
      webRouter.post(
        '/ai-assist/projects/:Project_id/web-tools/:name',
        AuthenticationController.requireLogin(),
        AuthorizationMiddleware.ensureUserCanReadProject,
        AiAssistWebToolsController.execute
      )
    }

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

    // A message typed while the run is still going: injected into the live run
    // rather than starting a second one.
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/message',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.queueMessage
    )

    // Takes such a message back before the run has read it
    webRouter.delete(
      '/ai-assist/projects/:Project_id/runs/:runId/message/:messageId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.unqueueMessage
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/mode',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.setMode
    )

    // The editor reports the outcome of a compile the run asked it to do.
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/compile',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.compileResult
    )

    // Chat history: one JSON file per conversation, scoped to the logged-in user.
    const { default: AiAssistChatHistoryController } =
      await import('./AiAssistChatHistoryController.mjs')

    webRouter.get(
      '/ai-assist/projects/:Project_id/chats',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.list
    )

    webRouter.get(
      '/ai-assist/projects/:Project_id/chats/:chatId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.get
    )

    webRouter.put(
      '/ai-assist/projects/:Project_id/chats/:chatId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.save
    )

    webRouter.delete(
      '/ai-assist/projects/:Project_id/chats/:chatId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.delete
    )

    webRouter.patch(
      '/ai-assist/projects/:Project_id/chats/:chatId',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.rename
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/chats/:chatId/generate-title',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistChatHistoryController.generateTitle
    )

    // Language suggestions' results, shared by a project's collaborators
    const { default: AiAssistLanguageCheckController } =
      await import('./AiAssistLanguageCheckController.mjs')

    webRouter.post(
      '/ai-assist/projects/:Project_id/language-checks/lookup',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      AiAssistLanguageCheckController.lookup
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/language-checks',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistLanguageCheckController.save
    )

    // Composer preferences (effort level, thinking switch), per user.
    const { default: AiAssistPreferencesController } =
      await import('./AiAssistPreferencesController.mjs')

    webRouter.get(
      '/ai-assist/preferences',
      AuthenticationController.requireLogin(),
      AiAssistPreferencesController.get
    )

    webRouter.put(
      '/ai-assist/preferences',
      AuthenticationController.requireLogin(),
      AiAssistPreferencesController.save
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
