/**
 * Every AI result card shares this width, so one footer of actions always
 * fits on a line. The card is never wider than the room its editor card
 * has (`--ai-floating-max-width`); see `$ai-card-width` in ai-assist.scss,
 * which must match. The language suggestion card is smaller and keeps its
 * own.
 */
export const AI_CARD_WIDTH = 600
