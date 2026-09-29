import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
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
  },
}

export default AiAssistModule
