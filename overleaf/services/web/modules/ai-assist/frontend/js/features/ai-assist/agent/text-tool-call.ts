import { ToolCall } from '../providers/types'
import { AgentTool } from './tools/registry'

const FENCE_OPEN = '```json'

type ToolParameters = {
  required?: string[]
  properties?: Record<string, unknown>
}

function validate(
  parsed: any,
  tools: Record<string, AgentTool>
): ToolCall | null {
  if (typeof parsed?.name !== 'string') return null
  const tool = tools[parsed.name]
  if (!tool) return null
  const args = parsed.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }
  const parameters = tool.spec.parameters as ToolParameters | undefined
  const required: string[] = parameters?.required ?? []
  for (const key of required) {
    if (!(key in args)) return null
  }
  const properties = parameters?.properties ?? {}
  for (const key of Object.keys(args)) {
    if (!(key in properties)) return null
  }
  return { id: 'text-1', name: parsed.name, args }
}

/**
 * Pulls one tool call out of streamed assistant text that a provider without
 * native tool support emitted as a fenced json block.
 *
 * Returns null while the fence is still open so the caller can hold the tail
 * back instead of flashing half a JSON blob at the user, and null for anything
 * that is not a valid call against the current registry — prose that quotes
 * JSON must stay prose.
 */
export function extractFencedToolCall(
  pending: string,
  tools: Record<string, AgentTool>
): { call: ToolCall; before: string; after: string } | null {
  const open = pending.indexOf(FENCE_OPEN)
  if (open === -1) return null

  const bodyStart = open + FENCE_OPEN.length
  const close = pending.indexOf('```', bodyStart)
  if (close === -1) return null

  let parsed: any
  try {
    parsed = JSON.parse(pending.slice(bodyStart, close).trim())
  } catch {
    return null
  }

  const call = validate(parsed, tools)
  if (!call) return null

  return {
    call,
    before: pending.slice(0, open),
    after: pending.slice(close + 3),
  }
}

/**
 * End-of-turn rescue for models that answer with nothing but a bare tool-call
 * object. The text may already have streamed; the stored message drops it.
 */
export function parseWholeMessageToolCall(
  text: string,
  tools: Record<string, AgentTool>
): ToolCall | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  return validate(parsed, tools)
}
