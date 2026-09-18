import customLocalStorage from '@/infrastructure/local-storage'
import { TranscriptEntry, ToolCallRecord } from './agent-messages'

export const MAX_STORED_BYTES = 200000
const MAX_RESULT_CHARS = 4000

const keyFor = (projectId: string) => `ai-assist:chat:${projectId}`

/**
 * Cleans stored tool call results, unwrapping any legacy nested { truncated, preview }
 * objects and recovering content from truncated JSON strings.
 */
export function cleanStoredResult(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res
  let curr: any = res
  for (let i = 0; i < 20; i++) {
    if (curr && typeof curr === 'object' && curr.truncated && typeof curr.preview === 'string') {
      try {
        const parsed = JSON.parse(curr.preview)
        if (parsed && typeof parsed === 'object') {
          curr = parsed
          continue
        }
      } catch {}

      // If preview is a sliced JSON string containing "content" e.g. {"content":"...
      const contentMatch = curr.preview.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)/)
      if (contentMatch) {
        try {
          return { content: JSON.parse(`"${contentMatch[1]}"`), truncated: true }
        } catch {
          return {
            content: contentMatch[1]
              .replace(/\\n/g, '\n')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\'),
            truncated: true,
          }
        }
      }
      break
    }
    break
  }
  return curr
}

export const unwrapCallResult = cleanStoredResult

export function shrinkCall(call: ToolCallRecord): ToolCallRecord {
  if (!('result' in call) || !call.result) return call

  // If already shrunk / safe, don't re-shrink
  if (typeof call.result === 'object' && (call.result as any)._shrunk) {
    return call
  }

  // Handle read_file: preserve structured fields so the UI can still render lines!
  if (call.name === 'read_file' && typeof call.result === 'object') {
    const res = call.result as any
    if (typeof res.content === 'string' && res.content.length > MAX_RESULT_CHARS) {
      return {
        ...call,
        result: {
          path: res.path,
          from: res.from,
          to: res.to,
          totalLines: res.totalLines,
          content: res.content.slice(0, MAX_RESULT_CHARS) + '\n... (truncated)',
          truncated: true,
          _shrunk: true,
        },
      }
    }
    return { ...call, result: { ...res, _shrunk: true } }
  }

  // Handle list_files: keep file paths and lines, avoid raw blob
  if (call.name === 'list_files' && typeof call.result === 'object') {
    const res = call.result as any
    const files = Array.isArray(res) ? res : Array.isArray(res.files) ? res.files : []
    return {
      ...call,
      result: {
        files: files.slice(0, 100).map((f: any) => ({
          path: f.path,
          type: f.type,
          size: f.size,
          lines: f.lines,
        })),
        _shrunk: true,
      },
    }
  }

  // Handle outline_project
  if (call.name === 'outline_project' && typeof call.result === 'object') {
    const res = call.result as any
    return {
      ...call,
      result: {
        documentClass: res.documentClass,
        packages: res.packages?.slice(0, 50),
        sections: res.sections?.slice(0, 100),
        _shrunk: true,
      },
    }
  }

  // Generic fallback: if small enough, keep as-is with _shrunk marker
  const serialised = JSON.stringify(call.result) ?? ''
  if (serialised.length <= MAX_RESULT_CHARS) {
    if (typeof call.result === 'object') {
      return { ...call, result: { ...call.result, _shrunk: true } }
    }
    return call
  }

  // If too large and unknown, keep truncated flag without destroying JSON structure
  return {
    ...call,
    result: {
      truncated: true,
      message: 'Result truncated for storage',
      _shrunk: true,
    },
  }
}

export function deduplicateToolCalls(calls: ToolCallRecord[]): ToolCallRecord[] {
  const seen = new Set<string>()
  const result: ToolCallRecord[] = []
  for (const call of calls) {
    const key = call.id || `${call.name}:${JSON.stringify(call.args)}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(call)
    }
  }
  return result
}

export function deduplicateBlocks(blocks?: any[]): any[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const seen = new Set<string>()
  const result: any[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool_call') {
      const key = block.call?.id || `${block.call?.name}:${JSON.stringify(block.call?.args)}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(block)
      }
    } else {
      result.push(block)
    }
  }
  return result
}

/** Tool results can be enormous; the transcript only needs enough to re-read. */
export function shrink(entry: TranscriptEntry): TranscriptEntry {
  if (entry.role !== 'assistant') return entry
  const dedupedCalls = deduplicateToolCalls(entry.toolCalls || [])
  const dedupedBlocks = deduplicateBlocks(entry.blocks)

  return {
    ...entry,
    toolCalls: dedupedCalls.map(shrinkCall),
    blocks: dedupedBlocks?.map(block =>
      block && block.type === 'tool_call' && block.call
        ? { ...block, call: shrinkCall(block.call) }
        : block
    ),
  }
}

function fit(transcript: TranscriptEntry[]) {
  let kept = transcript.map(shrink)
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_STORED_BYTES) {
    kept = kept.slice(1)
  }
  return kept
}

/**
 * Prepares a transcript for a background run payload, ensuring oversized historical
 * tool call results are shrunk or pruned so the request stays comfortably within limits.
 */
export function prepareTranscriptForRun(
  transcript: TranscriptEntry[],
  maxBytes: number = 4_500_000
): TranscriptEntry[] {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return transcript
  }

  // If already comfortably within limits, return as-is
  const jsonStr = JSON.stringify(transcript)
  if (jsonStr.length <= maxBytes) {
    return transcript
  }

  // First pass: shrink older assistant entries (preserve the latest assistant turn intact)
  const lastAssistantIdx = transcript.map(e => e.role).lastIndexOf('assistant')
  let result = transcript.map((entry, idx) => {
    if (entry.role === 'assistant' && idx !== lastAssistantIdx) {
      return shrink(entry)
    }
    return entry
  })

  if (JSON.stringify(result).length <= maxBytes) {
    return result
  }

  // Second pass: shrink all assistant turns
  result = result.map(entry => (entry.role === 'assistant' ? shrink(entry) : entry))

  if (JSON.stringify(result).length <= maxBytes) {
    return result
  }

  // Third pass: if still exceeds budget, drop oldest entries (preserving at least the last turn)
  while (result.length > 1 && JSON.stringify(result).length > maxBytes) {
    result = result.slice(1)
  }

  return result
}

/**
 * `customLocalStorage` handles the JSON encoding and swallows a denied, full or
 * corrupt store by returning null, so unreadable history degrades to an empty
 * transcript and unwritable history degrades to memory for this session.
 */
export function loadConversation(projectId: string): TranscriptEntry[] {
  try {
    const parsed = customLocalStorage.getItem(keyFor(projectId))
    if (!Array.isArray(parsed)) return []
    return parsed.map(entry => {
      if (!entry || typeof entry !== 'object') return entry
      if (entry.role !== 'assistant') return entry
      const dedupedCalls = deduplicateToolCalls(entry.toolCalls || [])
      const cleanCalls = dedupedCalls.map(c => ({
        ...c,
        result: cleanStoredResult(c?.result),
      }))
      const dedupedBlocks = deduplicateBlocks(entry.blocks)
      const cleanBlocks = dedupedBlocks?.map(b =>
        b && b.type === 'tool_call' && b.call
          ? { ...b, call: { ...b.call, result: cleanStoredResult(b.call?.result) } }
          : b
      )
      return {
        ...entry,
        toolCalls: cleanCalls,
        ...(cleanBlocks ? { blocks: cleanBlocks } : {}),
      }
    })
  } catch (err) {
    return []
  }
}

export function saveConversation(
  projectId: string,
  transcript: TranscriptEntry[]
) {
  try {
    customLocalStorage.setItem(keyFor(projectId), fit(transcript))
  } catch (err) {
  }
}

export function clearConversation(projectId: string) {
  customLocalStorage.removeItem(keyFor(projectId))
}
