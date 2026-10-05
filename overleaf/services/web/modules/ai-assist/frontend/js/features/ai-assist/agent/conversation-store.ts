import customLocalStorage from '@/infrastructure/local-storage'
import { TranscriptEntry, ToolCallRecord } from './agent-messages'

export const MAX_STORED_BYTES = 500000
const MAX_RESULT_CHARS = 4000

export const keyFor = (projectId: string, chatId?: string) =>
  chatId ? `ai-assist:chat:${projectId}:${chatId}` : `ai-assist:chat:${projectId}`

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

  // Handle web_fetch: the page text is what makes it large, and the panel
  // only shows where it came from
  if (call.name === 'web_fetch' && typeof call.result === 'object') {
    const res = call.result as any
    const { content, matches, ...rest } = res
    return {
      ...call,
      result: {
        ...rest,
        ...(typeof content === 'string'
          ? {
              content:
                content.length > MAX_RESULT_CHARS
                  ? content.slice(0, MAX_RESULT_CHARS) + '\n... (truncated)'
                  : content,
            }
          : {}),
        ...(Array.isArray(matches) ? { matches: matches.slice(0, 3) } : {}),
        _shrunk: true,
      },
    }
  }

  // Handle web_search: five full snippets outgrow the generic cap, and
  // dropping the results would lose the source numbers replies cite
  if (
    call.name === 'web_search' &&
    typeof call.result === 'object' &&
    Array.isArray((call.result as any).results)
  ) {
    const res = call.result as any
    return {
      ...call,
      result: {
        ...res,
        results: res.results.map((entry: any) => ({
          ...entry,
          ...(typeof entry?.snippet === 'string' && entry.snippet.length > 300
            ? { snippet: `${entry.snippet.slice(0, 299)}…` }
            : {}),
        })),
        _shrunk: true,
      },
    }
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

function deepShrinkCall(call: ToolCallRecord): ToolCallRecord {
  if (!('result' in call) || !call.result) return call
  if (typeof call.result === 'object') {
    const res = call.result as any
    if (call.name === 'read_file' && typeof res.content === 'string') {
      return {
        ...call,
        result: {
          path: res.path,
          from: res.from,
          to: res.to,
          totalLines: res.totalLines,
          content: res.content.slice(0, 500) + '\n... (truncated)',
          truncated: true,
          _shrunk: true,
        },
      }
    }
    return {
      ...call,
      result: {
        truncated: true,
        message: 'Result truncated for storage',
        _shrunk: true,
      },
    }
  }
  return call
}

function deepShrink(entry: TranscriptEntry): TranscriptEntry {
  if (entry.role !== 'assistant') return entry
  const dedupedCalls = deduplicateToolCalls(entry.toolCalls || [])
  const dedupedBlocks = deduplicateBlocks(entry.blocks)

  return {
    ...entry,
    toolCalls: dedupedCalls.map(deepShrinkCall),
    blocks: dedupedBlocks?.map(block =>
      block && block.type === 'tool_call' && block.call
        ? { ...block, call: deepShrinkCall(block.call) }
        : block
    ),
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

function fit(transcript: TranscriptEntry[]): TranscriptEntry[] {
  if (!Array.isArray(transcript) || transcript.length === 0) return []
  let kept = transcript.map(shrink)
  if (JSON.stringify(kept).length <= MAX_STORED_BYTES) {
    return kept
  }

  // Pass 2: Deep-shrink older assistant entries (preserve last assistant entry if possible)
  const lastAssistantIdx = kept.map(e => e.role).lastIndexOf('assistant')
  kept = kept.map((entry, idx) => {
    if (entry.role === 'assistant' && idx !== lastAssistantIdx) {
      return deepShrink(entry)
    }
    return entry
  })
  if (JSON.stringify(kept).length <= MAX_STORED_BYTES) {
    return kept
  }

  // Pass 3: Deep shrink all assistant entries
  kept = kept.map(entry => (entry.role === 'assistant' ? deepShrink(entry) : entry))
  if (JSON.stringify(kept).length <= MAX_STORED_BYTES) {
    return kept
  }

  // Pass 4: Fallback limit for extreme synthetic cases (e.g. hundreds of massive user messages)
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
 * The transcript without an entry repeated right after itself: the same id,
 * role and text. A chat reopened while its run was going could hold its
 * question twice, and every later run would send it twice.
 */
export function dropRepeatedEntries(
  transcript: TranscriptEntry[]
): TranscriptEntry[] {
  const kept = transcript.filter((entry, index) => {
    const previous = transcript[index - 1]
    return !(
      previous &&
      entry?.id &&
      entry.id === previous.id &&
      entry.role === previous.role &&
      entry.text === previous.text
    )
  })
  return kept.length === transcript.length ? transcript : kept
}

const isFinishedReply = (entry: TranscriptEntry) =>
  entry.role === 'assistant' && typeof entry.durationMs === 'number'

/**
 * The chat as shown, with what the server's copy of it adds: the top turns
 * this browser dropped to fit its storage, the turns after the ones shown,
 * and a reply finished since this copy was saved. Entries are lined up by id,
 * so a message both copies hold is never shown twice; copies that do not line
 * up are left as shown. Returns `local` itself when nothing is added.
 *
 * `live`: a run is writing the chat's reply. Only the top turns are put back;
 * the server's copy of the reply, or of anything after it, would be shown
 * next to the one the run is writing.
 */
export function mergeStoredTranscript(
  local: TranscriptEntry[],
  stored: TranscriptEntry[] | null | undefined,
  { live = false }: { live?: boolean } = {}
): TranscriptEntry[] {
  const server = dropRepeatedEntries(Array.isArray(stored) ? stored : [])
  if (server.length === 0) return local
  if (local.length === 0) return server

  const at = server.findIndex(entry => entry.id === local[0].id)
  if (at === -1) return local
  const overlap = Math.min(local.length, server.length - at)
  for (let i = 0; i < overlap; i++) {
    const theirs = server[at + i]
    if (theirs.id !== local[i].id || theirs.role !== local[i].role) {
      return local
    }
  }
  if (live) return at > 0 ? [...server.slice(0, at), ...local] : local

  let changed = at > 0
  const shown = local.map((entry, i) => {
    const theirs = i < overlap ? server[at + i] : null
    if (theirs && isFinishedReply(theirs) && !isFinishedReply(entry)) {
      changed = true
      return theirs
    }
    return entry
  })
  const after = server.slice(at + overlap)
  if (after.length > 0) changed = true
  if (!changed) return local
  return [...server.slice(0, at), ...shown, ...after]
}

/**
 * `customLocalStorage` handles the JSON encoding and swallows a denied, full or
 * corrupt store by returning null, so unreadable history degrades to an empty
 * transcript and unwritable history degrades to memory for this session.
 */
export function loadConversation(
  projectId: string,
  chatId?: string
): TranscriptEntry[] {
  try {
    // Each chat only ever reads its own copy. The one kept per project before
    // chats had ids is whichever chat was last open, so reading it for a chat
    // with no copy of its own showed a new chat another chat's turns; that
    // chat's turns come from the server's history instead.
    const parsed: any = customLocalStorage.getItem(keyFor(projectId, chatId))
    if (!Array.isArray(parsed)) return []
    return dropRepeatedEntries(parsed).map(entry => {
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
  chatIdOrTranscript: string | TranscriptEntry[],
  maybeTranscript?: TranscriptEntry[]
) {
  try {
    const chatId =
      typeof chatIdOrTranscript === 'string' ? chatIdOrTranscript : undefined
    const transcript = Array.isArray(chatIdOrTranscript)
      ? chatIdOrTranscript
      : maybeTranscript || []
    // Each chat under its own key only: one copy shared by every chat is what
    // let a new chat open showing the last one's turns
    customLocalStorage.setItem(keyFor(projectId, chatId), fit(transcript))
  } catch (err) {}
}

export function clearConversation(projectId: string, chatId?: string) {
  if (chatId) {
    customLocalStorage.removeItem(keyFor(projectId, chatId))
  }
  customLocalStorage.removeItem(keyFor(projectId))
}
