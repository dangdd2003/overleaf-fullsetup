import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import signature from 'cookie-signature'
import AiAssistRunRouter from './app/src/AiAssistRunRouter.mjs'
import bodyParser from '../../app/src/infrastructure/BodyParserWrapper.mjs'
import logger from '@overleaf/logger'

/** Room on top of the transcript for provider settings and the rest of a body. */
const BODY_HEADROOM_BYTES = 2 * 1024 * 1024

/**
 * The routes whose bodies carry a whole chat (or a message with its context):
 * run create, chat save and a message sent into a run. Only these get the large
 * parser.
 */
const LARGE_BODY_ROUTES = [
  { method: 'POST', path: /^\/ai-assist\/projects\/[0-9a-fA-F]{24}\/runs\/?$/ },
  {
    method: 'PUT',
    path: /^\/ai-assist\/projects\/[0-9a-fA-F]{24}\/chats\/[^/]+\/?$/,
  },
  {
    method: 'POST',
    path: /^\/ai-assist\/projects\/[0-9a-fA-F]{24}\/runs\/[^/]+\/message\/?$/,
  },
]

function isLargeBodyRoute(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0]
  return LARGE_BODY_ROUTES.some(
    route => route.method === req.method && route.path.test(path)
  )
}

/**
 * Only a browser carrying a validly signed session cookie reaches the large
 * body parser; unsigned or forged cookies stay on the small app parser.
 */
function hasSessionCookie(req) {
  const name = Settings.cookieName
  const cookies = typeof req.headers?.cookie === 'string' ? req.headers.cookie : ''
  const secrets = [
    Settings.security?.sessionSecret,
    Settings.security?.sessionSecretUpcoming,
    Settings.security?.sessionSecretFallback,
  ].filter(Boolean)
  if (!name || secrets.length === 0) return false

  for (const cookie of cookies.split(';')) {
    const trimmed = cookie.trim()
    if (!trimmed.startsWith(`${name}=`)) continue
    let raw = trimmed.slice(name.length + 1)
    try {
      raw = decodeURIComponent(raw)
    } catch {
      return false
    }
    if (!raw.startsWith('s:')) return false
    const unsigned = raw.slice(2)
    if (secrets.some(secret => signature.unsign(unsigned, secret) !== false)) {
      return true
    }
  }
  return false
}

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: AiAssistRunRouter,
  // A chat is sent whole and can outgrow the app's 12 MB JSON limit, so the
  // routes that carry one get a larger parser. Anonymous requests and every
  // other route fall through to the app's parser.
  appMiddleware(app) {
    if (!Settings.aiAssist?.enabled) return
    const largeJson = bodyParser.json({
      limit: Settings.aiAssist.maxTranscriptBytes + BODY_HEADROOM_BYTES,
    })
    app.use('/ai-assist', (req, res, next) => {
      if (!isLargeBodyRoute(req) || !hasSessionCookie(req)) return next()
      return largeJson(req, res, next)
    })
  },
  // Invoked by app.mjs via Modules.start() at boot. Import lazily so a
  // disabled feature never touches Redis at all.
  async start() {
    if (!Settings.aiAssist?.enabled) return

    const { default: control } = await import('./app/src/AiAssistRunControl.mjs')
    const { default: reaper } = await import('./app/src/AiAssistRunReaper.mjs')
    const { default: manager } = await import('./app/src/AiAssistRunManager.mjs')
    const { default: runController } = await import(
      './app/src/AiAssistRunController.mjs'
    )
    const {
      addOptionalCleanupHandlerBeforeStoppingTraffic,
      addRequiredCleanupHandlerBeforeDrainingConnections,
    } = await import('../../app/src/infrastructure/GracefulShutdown.mjs')

    manager.attachControl(control)

    const stopControl = await control.start({
      onCommand: command => manager.onCommand(command),
    })
    reaper.start()

    addOptionalCleanupHandlerBeforeStoppingTraffic(
      'ai-assist streams & runs',
      () => {
        runController.closeAllStreams?.()
        return manager.shutdown?.()
      }
    )
    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run control',
      stopControl
    )
    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run reaper',
      () => reaper.stop()
    )
    addRequiredCleanupHandlerBeforeDrainingConnections(
      'ai-assist run manager',
      () => manager.shutdown?.()
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
      // Fired by ProjectDeleter when a deleted project expires
      async projectExpired(projectId) {
        if (!Settings.aiAssist?.enabled) return
        const { removeProjectData } = await import(
          './app/src/AiAssistUserCleanup.mjs'
        )
        await removeProjectData(projectId)
      },
    },
  },
}

export default AiAssistModule
