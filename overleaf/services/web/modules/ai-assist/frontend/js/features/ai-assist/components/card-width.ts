/**
 * Every AI result card (Writing tools, TeXGPT, the table and equation
 * generators) shares this width, so one footer of actions always fits on a
 * line. Must match `$ai-card-width` in ai-assist.scss. The language
 * suggestion card is smaller and keeps its own.
 */
export const AI_CARD_WIDTH = 600
export const AI_CARD_MARGIN = 16

/** The card width, kept inside the viewport. */
export function aiCardWidth(): number {
  return Math.min(AI_CARD_WIDTH, window.innerWidth - 2 * AI_CARD_MARGIN)
}
