import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'
import bodyParser from '../../app/src/infrastructure/BodyParserWrapper.mjs'
import logger from '@overleaf/logger'

/** Room on top of the transcript for provider settings and the rest of a body. */
const BODY_HEADROOM_BYTES = 2 * 1024 * 1024

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
  // A chat is sent whole and can outgrow the app's 12 MB JSON limit; this
  // parser runs first for the assistant's routes, so the app's one skips them
  appMiddleware(app) {
    if (!Settings.aiAssist?.enabled) return
    app.use(
      '/ai-assist',
      bodyParser.json({
        limit: Settings.aiAssist.maxTranscriptBytes + BODY_HEADROOM_BYTES,
      })
    )
  },
  // Invoked by app.mjs via Modules.start() at boot. Import lazily so a
  // disabled feature never touches Redis at all.
  async start() {
    if (!Settings.aiAssist?.enabled) return

    const { default: control } = await import('./app/src/AiAssistRunControl.mjs')
    const { default: reaper } = await import('./app/src/AiAssistRunReaper.mjs')
    const { default: manager } = await import('./app/src/AiAssistRunManager.mjs')
    const {
      addRequiredCleanupHandlerBeforeDrainingConnections,
    } = await import('../../app/src/infrastructure/GracefulShutdown.mjs')

    manager.attachControl(control)

    const stopControl = await control.start({
      onCommand: command => manager.onCommand(command),
    })
    reaper.start()

    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run control',
      stopControl
    )
    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run reaper',
      () => reaper.stop()
    )

    // The connector collections' indexes, created only while the feature is on
    if (Settings.aiAssist?.enabled) {
      const { ensureAiAssistIndexes } = await import(
        './app/src/AiAssistIndexes.mjs'
      )
      await ensureAiAssistIndexes().catch(err =>
        logger.error({ err }, '[AiAssist] connector indexes not created')
      )
    }
  },
  hooks: {
    promises: {
      // Fired by UserDeleter when an account is deleted and again when it
      // expires; removing twice is a no-op
      async deleteUser(userId) {
        if (!Settings.aiAssist?.enabled) return
        const { removeUserData } = await import(
          './app/src/AiAssistUserCleanup.mjs'
        )
        await removeUserData(userId)
      },
      async expireDeletedUser(userId) {
        if (!Settings.aiAssist?.enabled) return
        const { removeUserData } = await import(
          './app/src/AiAssistUserCleanup.mjs'
        )
        await removeUserData(userId)
      },
    },
  },
}

export default AiAssistModule
