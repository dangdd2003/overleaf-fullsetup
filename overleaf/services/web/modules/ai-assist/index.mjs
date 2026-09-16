import './app/src/ModuleSettings.mjs'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
}

export default AiAssistModule
