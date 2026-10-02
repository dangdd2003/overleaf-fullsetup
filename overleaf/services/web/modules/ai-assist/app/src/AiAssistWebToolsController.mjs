import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import './ModuleSettings.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { AiAssistWebTools, WEB_TOOL_NAMES } from './AiAssistWebTools.mjs'
import { renderToolResult } from './AiAssistToolRender.mjs'
import { resolveWebSearchSettings } from './AiAssistRunController.mjs'

// Earlier web calls of one fix run; a fix is capped far below this
const MAX_KNOWN_CALLS = 50

function knownCallsFrom(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      call =>
        call &&
        typeof call === 'object' &&
        WEB_TOOL_NAMES.has(call.name) &&
        call.result &&
        typeof call.result === 'object'
    )
    .slice(-MAX_KNOWN_CALLS)
    .map(call => ({
      name: call.name,
      args: call.args ?? {},
      result: call.result,
    }))
}

/**
 * web_search and web_fetch for runs that execute in the browser (the
 * compile-log fix). The chat's server runs call AiAssistWebTools directly.
 */
export class AiAssistWebToolsController {
  constructor({
    webToolsFactory = (settings, { userId, contextWindow } = {}) =>
      new AiAssistWebTools(settings, {
        cacheOwner: userId,
        contextWindow,
        prefetch: Settings.aiAssist?.webPrefetchResults,
      }),
  } = {}) {
    this.webToolsFactory = webToolsFactory
  }

  _tools(req, res) {
    let settings
    try {
      settings = resolveWebSearchSettings(req.body?.webSearchSettings)
    } catch (err) {
      res.status(400).json({ error: err.message })
      return null
    }
    if (!settings) {
      res.status(403).json({ error: 'Web search is turned off.' })
      return null
    }
    const loggedIn = SessionManager.getLoggedInUserId(req.session)
    const userId =
      loggedIn && /^[0-9a-f]{24}$/i.test(String(loggedIn))
        ? String(loggedIn)
        : null
    const contextWindow =
      Number(req.body?.contextWindow) > 0
        ? Number(req.body.contextWindow)
        : undefined
    return this.webToolsFactory(settings, { userId, contextWindow })
  }

  specs = async (req, res) => {
    const tools = this._tools(req, res)
    if (!tools) return
    res.json({ specs: tools.getToolSpecs() })
  }

  execute = async (req, res) => {
    const name = req.params.name
    if (!WEB_TOOL_NAMES.has(name)) {
      return res.status(404).json({ error: 'Unknown web tool.' })
    }
    const tools = this._tools(req, res)
    if (!tools) return
    tools.rememberSources?.([
      { role: 'assistant', toolCalls: knownCallsFrom(req.body?.knownCalls) },
    ])
    const controller = new AbortController()
    req.on?.('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    try {
      const args =
        req.body?.args && typeof req.body.args === 'object' ? req.body.args : {}
      const result = await tools.execute(name, args, {
        signal: controller.signal,
      })
      res.json({ result, text: renderToolResult(name, result) })
    } catch (err) {
      logger.warn({ err, name }, '[AiAssist] Web tool failed')
      res.status(500).json({ error: 'The web request failed.' })
    }
  }
}

export default new AiAssistWebToolsController()
