import Settings from '@overleaf/settings'

export default {
  applyNonCsrfRouter(webRouter) {
    if (!Settings.aiAssist?.enabled) {
      return
    }
    // Loaded on the first callback, so a disabled instance loads no connector code
    webRouter.get('/ai-assist/connectors/oauth/callback', (req, res, next) =>
      import('./connectors/ConnectorController.mjs')
        .then(({ default: ConnectorController }) =>
          ConnectorController.oauthCallback(req, res, next)
        )
        .catch(next)
    )
  },

  async apply(webRouter) {
    if (!Settings.aiAssist?.enabled) return

    const { default: AiAssistRunController } =
      await import('./AiAssistRunController.mjs')
    const { default: AuthenticationController } =
      await import('../../../../app/src/Features/Authentication/AuthenticationController.mjs')
    const { default: AuthorizationMiddleware } =
      await import('../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs')

    // Limits per user. Loaded here, not at import: the limiters connect to Redis.
    // A run is a long, paid model conversation; each provider call is one model
    // step of it, and a chat turn is a few of them, so those allow far more.
    const { default: RateLimiterMiddleware } =
      await import('../../../../app/src/Features/Security/RateLimiterMiddleware.mjs')
    const { RateLimiter } =
      await import('../../../../app/src/infrastructure/RateLimiter.mjs')
    const runLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-runs', { points: 20, duration: 60 })
    )
    const providerLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-providers', { points: 300, duration: 60 })
    )
    const faviconLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-favicon', { points: 240, duration: 60 })
    )
    const connectorIconLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-connector-icon', { points: 240, duration: 60 })
    )
    const connectorProbeLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-connector-probe', { points: 20, duration: 60 })
    )

    // 0. Provider requests (model list, connection test, in-page agent turns)
    // are made from the server so internal providers work behind a public domain.
    const { default: AiAssistProviderController } =
      await import('./AiAssistProviderController.mjs')

    webRouter.post(
      '/ai-assist/providers/models',
      AuthenticationController.requireLogin(),
      providerLimit,
      AiAssistProviderController.listModels
    )

    webRouter.post(
      '/ai-assist/providers/test',
      AuthenticationController.requireLogin(),
      providerLimit,
      AiAssistProviderController.test
    )

    webRouter.post(
      '/ai-assist/providers/chat',
      AuthenticationController.requireLogin(),
      providerLimit,
      AiAssistProviderController.chat
    )

    // Text only: the AI inside the editor, which never gets tools
    webRouter.post(
      '/ai-assist/providers/editor',
      AuthenticationController.requireLogin(),
      providerLimit,
      AiAssistProviderController.editorText
    )

    if (Settings.aiAssist?.webToolsEnabled) {
      webRouter.post(
        '/ai-assist/web-search/test',
        AuthenticationController.requireLogin(),
        providerLimit,
        AiAssistProviderController.testWebSearch
      )

      // Site icons for web result rows, fetched here because most sites only
      // name theirs in the home page's HTML.
      const { default: AiAssistFavicon } = await import('./AiAssistFavicon.mjs')
      webRouter.get(
        '/ai-assist/favicon',
        AuthenticationController.requireLogin(),
        faviconLimit,
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
      runLimit,
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

    // Has the run answer such a message now, cutting short the reply it is
    // streaming
    webRouter.post(
      '/ai-assist/projects/:Project_id/runs/:runId/message/:messageId/now',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistRunController.sendQueuedNow
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

    // Checkpoint & rewind endpoints
    const { default: AiAssistCheckpointController } =
      await import('./AiAssistCheckpointController.mjs')

    webRouter.post(
      '/ai-assist/projects/:Project_id/chats/:chatId/rewind/check',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistCheckpointController.check
    )

    webRouter.post(
      '/ai-assist/projects/:Project_id/chats/:chatId/rewind',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistCheckpointController.rewind
    )

    // Copies a chat's checkpoints to a forked chat so its code can be rewound
    webRouter.post(
      '/ai-assist/projects/:Project_id/chats/:chatId/checkpoints/fork',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      AiAssistCheckpointController.fork
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

    // User AI provider and web search settings (encrypted at rest on server)
    const { default: AiAssistUserSettingsController } =
      await import('./AiAssistUserSettingsController.mjs')

    const settingsLimit = RateLimiterMiddleware.rateLimit(
      new RateLimiter('ai-assist-user-settings', { points: 60, duration: 60 })
    )

    webRouter.get(
      '/ai-assist/settings',
      AuthenticationController.requireLogin(),
      AiAssistUserSettingsController.get
    )

    webRouter.put(
      '/ai-assist/settings',
      AuthenticationController.requireLogin(),
      settingsLimit,
      AiAssistUserSettingsController.save
    )

    if (Settings.aiAssist?.enabled) {
      const { default: ConnectorController } =
        await import('./connectors/ConnectorController.mjs')

      webRouter.get(
        '/ai-assist/connectors',
        AuthenticationController.requireLogin(),
        ConnectorController.list
      )

      webRouter.post(
        '/ai-assist/connectors/probe',
        AuthenticationController.requireLogin(),
        connectorProbeLimit,
        ConnectorController.probe
      )

      webRouter.post(
        '/ai-assist/connectors',
        AuthenticationController.requireLogin(),
        ConnectorController.create
      )

      webRouter.post(
        '/ai-assist/connectors/import',
        AuthenticationController.requireLogin(),
        ConnectorController.import
      )

      webRouter.patch(
        '/ai-assist/connectors/:id',
        AuthenticationController.requireLogin(),
        ConnectorController.update
      )

      webRouter.delete(
        '/ai-assist/connectors/:id',
        AuthenticationController.requireLogin(),
        ConnectorController.remove
      )

      webRouter.post(
        '/ai-assist/connectors/:id/authorize',
        AuthenticationController.requireLogin(),
        ConnectorController.authorize
      )

      webRouter.post(
        '/ai-assist/connectors/:id/refresh',
        AuthenticationController.requireLogin(),
        ConnectorController.refresh
      )

      webRouter.post(
        '/ai-assist/connectors/:id/disconnect',
        AuthenticationController.requireLogin(),
        ConnectorController.disconnect
      )

      webRouter.get(
        '/ai-assist/connectors/oauth/client-metadata.json',
        ConnectorController.clientMetadata
      )

      webRouter.get(
        '/ai-assist/connectors/:connectorId/icon',
        AuthenticationController.requireLogin(),
        connectorIconLimit,
        ConnectorController.icon
      )
    }

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
