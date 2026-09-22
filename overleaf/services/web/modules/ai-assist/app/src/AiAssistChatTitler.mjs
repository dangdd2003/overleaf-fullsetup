import logger from '@overleaf/logger'
import { sanitizeChatTitle, fallbackTitleFor, reorganizePromptToTitle } from './AiAssistChatHistoryStore.mjs'

export const CHAT_TITLING_SYSTEM_PROMPT =
  'You are an expert conversation titler, exactly like Claude AI.\n' +
  'Your job is to read the user\'s first prompt, reorganize it, and create a concise, informative, 2 to 5 word title for the chat session that captures the core scheme and intent.\n' +
  'Rules:\n' +
  '- Strictly 2 to 5 words maximum.\n' +
  '- Clean Title Case (e.g., "Tighten Passive Phrasing in main.tex", "Scan for Unsupported Claims", "Resolve Compile Errors", "Create Modern Beamer Presentation", "Draft Abstract in main.tex").\n' +
  '- Base the title directly on the user\'s first prompt by reorganizing and summarizing its core task.\n' +
  '- Do NOT use quotation marks, backticks, or markdown formatting.\n' +
  '- Do NOT use trailing punctuation (no periods, colons, or commas).\n' +
  '- Do NOT use conversational filler words (e.g. "Chat about...", "Help with...", "A conversation on...", "Task:").\n' +
  '- Output ONLY the title text and nothing else.'

/**
 * Generates a concise 2-5 word chat title by reorganizing the user's first prompt,
 * matching Claude AI's prompt-reorganizing titling behavior.
 */
export async function generateChatTitle({
  client,
  firstMessageText,
  signal,
}) {
  const promptText =
    typeof firstMessageText === 'string' ? firstMessageText.trim() : ''
  if (!promptText) return 'New chat'

  if (!client || typeof client.streamChat !== 'function') {
    return reorganizePromptToTitle(promptText)
  }

  let timeoutSignal
  try {
    timeoutSignal = AbortSignal.timeout(5000)
  } catch {
    timeoutSignal = null
  }
  const combinedSignal = timeoutSignal
    ? AbortSignal.any([signal, timeoutSignal].filter(Boolean))
    : signal

  const userContent = `Reorganize this first prompt into a concise 2 to 5 word title for the chat session:\n\n${promptText.slice(0, 1000)}\n\nTitle:`

  let raw = ''
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
        raw += chunk.text
      }
    }
  } catch (err) {
    logger.warn({ err }, '[AiAssist] title generation request failed, using fallback title')
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
