import { ToolCall } from '../providers/types'
import { AgentTool } from './tools/registry'

const FENCE_OPEN = '```json'

type ToolParameters = {
  required?: string[]
  properties?: Record<string, unknown>
}

let callCounter = 0

export function nextToolCallId(prefix = 'call_txt'): string {
  callCounter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now()}_${callCounter}_${rand}`
}

/** Whether a parsed JSON value has the JSON Schema type the spec asks for. */
function matchesSchemaType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some(t => matchesSchemaType(value, t))
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'null':
      return value === null
    default:
      // No type in the spec: nothing to check against
      return true
  }
}

function validate(
  parsed: any,
  tools: Record<string, AgentTool>,
  toolOutputs: readonly string[],
  body: string
): ToolCall | null {
  if (typeof parsed?.name !== 'string') return null
  if (!Object.hasOwn(tools, parsed.name)) return null
  const tool = tools[parsed.name]
  if (!tool) return null
  // The block is a copy of a tool result the model was shown, not a call
  if (toolOutputs.some(output => output.includes(body))) return null
  const args = parsed.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return null
  }
  const parameters = tool.spec.parameters as ToolParameters | undefined
  const required: string[] = parameters?.required ?? []
  for (const key of required) {
    if (!Object.hasOwn(args, key)) return null
  }
  const properties = (parameters?.properties ?? {}) as Record<string, any>
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) return null
    const type = properties[key]?.type
    if (!matchesSchemaType((args as any)[key], type)) return null
  }
  return { id: nextToolCallId(), name: parsed.name, args }
}

export type TextToolCallOptions = {
  /**
   * Tool results already in the conversation. A block that repeats one of them
   * is the model quoting output, so it is left as text.
   */
  toolOutputs?: readonly string[]
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
  tools: Record<string, AgentTool>,
  options: TextToolCallOptions = {}
): { call: ToolCall; before: string; after: string } | null {
  const open = pending.indexOf(FENCE_OPEN)
  if (open === -1) return null

  const bodyStart = open + FENCE_OPEN.length
  const close = pending.indexOf('```', bodyStart)
  if (close === -1) return null

  const body = pending.slice(bodyStart, close).trim()
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }

  const call = validate(parsed, tools, options.toolOutputs ?? [], body)
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
  tools: Record<string, AgentTool>,
  options: TextToolCallOptions = {}
): ToolCall | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  return validate(parsed, tools, options.toolOutputs ?? [], trimmed)
}
