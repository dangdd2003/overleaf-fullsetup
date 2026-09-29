import getMeta from '@/utils/meta'
import { ToolSpec, WebSearchSettings } from '../../providers/types'
import { isWebToolsAvailable, readWebSearchSettings } from '../../provider-store'
import { AgentTool } from './registry'

const ALLOWED_WEB_TOOLS = new Set(['web_search', 'web_fetch'])

type KnownCall = { name: string; args: unknown; result: unknown }

function csrfHeaders(): Record<string, string> {
  const token =
    (typeof window !== 'undefined' && (window as any).csrfToken) ||
    getMeta('ol-csrfToken') ||
    ''
  return token ? { 'X-Csrf-Token': token } : {}
}

async function postJson(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<any> {
  const response = await fetchImpl(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`)
  }
  return payload
}

/**
 * web_search and web_fetch for one fix run, executed by the server. A fresh
 * set per run holds that run's earlier calls, which the server needs to keep
 * source numbers stable and to spot a repeated search.
 */
export function createFixWebTools({
  projectId,
  specs,
  webSearchSettings,
  contextWindow,
  fetchImpl = fetch,
}: {
  projectId: string
  specs: ToolSpec[]
  webSearchSettings: WebSearchSettings | null
  contextWindow: number
  fetchImpl?: typeof fetch
}): Record<string, AgentTool> {
  const knownCalls: KnownCall[] = []
  // The model reads the server's rendering; the transcript keeps the result
  const texts = new WeakMap<object, string>()

  const tools: Record<string, AgentTool> = {}
  for (const spec of specs) {
    if (!ALLOWED_WEB_TOOLS.has(spec.name)) continue
    tools[spec.name] = {
      spec,
      suspends: false,
      mutates: false,
      async execute(args, _handle, options) {
        const payload = await postJson(
          fetchImpl,
          `/ai-assist/projects/${projectId}/web-tools/${spec.name}`,
          { args, webSearchSettings, contextWindow, knownCalls },
          options?.signal
        )
        const result = payload?.result ?? { error: 'The web request failed.' }
        if (result && typeof result === 'object') {
          if (typeof payload?.text === 'string') texts.set(result, payload.text)
          knownCalls.push({ name: spec.name, args, result })
        }
        return result
      },
      render(result) {
        const text =
          result && typeof result === 'object' ? texts.get(result) : undefined
        return text ?? JSON.stringify(result)
      },
    }
  }
  return tools
}

/**
 * The fix run's web tools, or null when this instance or this user has none.
 * Never throws: a fix without the web is still a fix.
 */
export async function prepareFixWebTools({
  projectId,
  contextWindow,
  fetchImpl = fetch,
}: {
  projectId: string
  contextWindow: number
  fetchImpl?: typeof fetch
}): Promise<{ tools: Record<string, AgentTool>; search: boolean } | null> {
  if (!isWebToolsAvailable()) return null
  const webSearchSettings = readWebSearchSettings()
  if (webSearchSettings?.sourceMode === 'disabled') return null
  try {
    const payload = await postJson(
      fetchImpl,
      `/ai-assist/projects/${projectId}/web-tools`,
      { webSearchSettings }
    )
    const specs: ToolSpec[] = Array.isArray(payload?.specs) ? payload.specs : []
    const tools = createFixWebTools({
      projectId,
      specs,
      webSearchSettings,
      contextWindow,
      fetchImpl,
    })
    if (!Object.keys(tools).length) return null
    return { tools, search: 'web_search' in tools }
  } catch {
    return null
  }
}
