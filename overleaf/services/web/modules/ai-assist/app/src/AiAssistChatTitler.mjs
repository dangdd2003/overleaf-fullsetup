import logger from '@overleaf/logger'
import {
  sanitizeChatTitle,
  reorganizePromptToTitle,
} from './AiAssistChatHistoryStore.mjs'
import { ProviderError } from './AiAssistErrors.mjs'
import { withProviderRetry } from './AiAssistRetry.mjs'

// Each try gets this long to answer; the whole title, retries included, this long
const ATTEMPT_TIMEOUT_MS = 5000
const TOTAL_TIMEOUT_MS = 30000

export const CHAT_TITLING_SYSTEM_PROMPT =
  'You are an expert conversation titler, exactly like Claude AI.\n' +
  "Your job is to read the user's first prompt, reorganize it, and create a concise, informative, 2 to 5 word title for the chat session that captures the core scheme and intent.\n" +
  'Rules:\n' +
  '- Strictly 2 to 5 words maximum.\n' +
  '- Clean Title Case (e.g., "Tighten Passive Phrasing in main.tex", "Scan for Unsupported Claims", "Resolve Compile Errors", "Create Modern Beamer Presentation", "Draft Abstract in main.tex").\n' +
  "- Base the title directly on the user's first prompt by reorganizing and summarizing its core task.\n" +
  '- Do NOT use quotation marks, backticks, or markdown formatting.\n' +
  '- Do NOT use trailing punctuation (no periods, colons, or commas).\n' +
  '- Do NOT use conversational filler words (e.g. "Chat about...", "Help with...", "A conversation on...", "Task:").\n' +
  '- Output ONLY the title text and nothing else.'

/** An AbortSignal that fires after `ms`, or null where the runtime has none. */
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return null
  }
}

/**
 * Generates a concise 2-5 word chat title by reorganizing the user's first prompt,
 * matching Claude AI's prompt-reorganizing titling behavior.
 */
export async function generateChatTitle({ client, firstMessageText, signal }) {
  const promptText =
    typeof firstMessageText === 'string' ? firstMessageText.trim() : ''
  if (!promptText) return 'New chat'

  if (!client || typeof client.streamChat !== 'function') {
    return reorganizePromptToTitle(promptText)
  }

  const userContent = `Reorganize this first prompt into a concise 2 to 5 word title for the chat session:\n\n${promptText.slice(0, 1000)}\n\nTitle:`

  let raw = ''
  try {
    const totalSignal = timeoutSignal(TOTAL_TIMEOUT_MS)
    const outerSignal = totalSignal
      ? AbortSignal.any([signal, totalSignal].filter(Boolean))
      : signal
    raw = await withProviderRetry(
      async () => {
        const attemptSignal = timeoutSignal(ATTEMPT_TIMEOUT_MS)
        const combinedSignal = attemptSignal
          ? AbortSignal.any([outerSignal, attemptSignal])
          : outerSignal
        let text = ''
        try {
          for await (const chunk of client.streamChat({
            system: CHAT_TITLING_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userContent }],
            // Reasoning/thinking models bill hidden reasoning tokens out of this
            // same budget, so a tight cap can leave zero tokens for the visible
            // title text. Leave enough headroom for that before the few output
            // words we actually want.
            maxTokens: 300,
            tools: [],
            signal: combinedSignal,
          })) {
            if (chunk?.type === 'text' && typeof chunk.text === 'string') {
              text += chunk.text
            }
          }
        } catch (err) {
          // Only this try ran out of time: a timeout to retry, not a cancel
          if (attemptSignal?.aborted && !outerSignal.aborted) {
            throw new ProviderError('Connection timed out', {
              code: 'providerTimeout',
            })
          }
          throw err
        }
        return text
      },
      { policy: 'background', signal: outerSignal }
    )
  } catch (err) {
    logger.warn(
      { err },
      '[AiAssist] title generation request failed, using fallback title'
    )
    return reorganizePromptToTitle(promptText)
  }

  const sanitized = sanitizeChatTitle(raw)
  if (!sanitized) {
    logger.warn(
      { rawLength: raw.length },
      '[AiAssist] title generation returned no usable text, using fallback title'
    )
  }
  return sanitized || reorganizePromptToTitle(promptText)
}
