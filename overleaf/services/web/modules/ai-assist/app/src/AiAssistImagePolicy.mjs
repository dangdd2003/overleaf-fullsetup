/**
 * Per-provider, per-model choices for page images: how large to render a PDF
 * page, whether to split it, what colour to use, and which request parameter
 * makes the provider keep the detail. Also estimates what an image costs in
 * tokens, so the context budget counts real images instead of a flat guess.
 *
 * Sources (checked when this was written; re-check when models change):
 * - Anthropic vision, "Resolution and token cost" (platform.claude.com/docs/en/build-with-claude/vision):
 *   high-resolution tier for Claude 4.7 and later, 2576 px long edge and 4784
 *   visual tokens; standard tier 1568 px and 1568 tokens; a visual token is a
 *   28x28 px patch, so cost = ceil(w/28) * ceil(h/28).
 * - OpenAI images and vision guide (developers.openai.com/api/docs/guides/images-vision):
 *   detail levels low/high/original/auto; `original` is supported on gpt-5.4
 *   and later (incl. gpt-5.5, gpt-5.6, gpt-6-astra) but not on gpt-4o, gpt-4.1,
 *   gpt-5.1 or gpt-5.2. Tile formula (fit 2048, short side 768, 512 px tiles):
 *   gpt-4o/gpt-4.1 85 + 170 per tile; gpt-5/gpt-5.1 70 + 140 per tile. Newer
 *   models use 32 px patches times a per-model multiplier (1.2 for gpt-5.4+).
 * - Gemini media resolution (ai.google.dev/gemini-api/docs/media-resolution):
 *   per-image levels low 280, medium 560, high 1120, ultra_high 2240 tokens on
 *   Gemini 3 and 4. Older models tile 768 px at 258 tokens per tile (the
 *   image-understanding page). The request field could not be confirmed for
 *   generateContent: the docs show a per-media `resolution` in the Interactions
 *   API. The Gemini 3+ part field used here is `mediaResolution`, marked
 *   unverified in the report.
 */

/** Largest image a provider takes without downscaling it further. */
export const CLAUDE_HIGH_RES_EDGE_PX = 2576
export const CLAUDE_STANDARD_EDGE_PX = 1568
/** Visual tokens an image may take on each Claude tier (28 px patches). */
export const CLAUDE_HIGH_RES_TOKENS = 4784
export const CLAUDE_STANDARD_TOKENS = 1568
/** Fallback for providers and models the table does not know. */
export const FALLBACK_EDGE_PX = 1568
export const OPENAI_FIT_PX = 2048
export const OPENAI_SHORT_SIDE_PX = 768
export const GEMINI_ENGINE_EDGE_PX = 2048
export const IMAGE_TOKEN_FALLBACK = 1600

const CLAUDE_MODEL = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/
const OPENAI_GPT5 = /^gpt-5\.(\d+)/
const OPENAI_GPT6 = /^gpt-(\d+)/
const GEMINI_MODEL = /^gemini-(\d+)(?:\.(\d+))?/

/** Claude 4.7+ (Opus and Sonnet) and the whole Claude 5 family. */
export function isClaudeHighResModel(model) {
  const match = CLAUDE_MODEL.exec(String(model ?? ''))
  if (!match) return false
  const family = match[1]
  const major = Number(match[2])
  const minor = Number(match[3] ?? 0)
  if (major >= 5) return true
  if (major === 4 && minor >= 7) return family === 'opus' || family === 'sonnet'
  return false
}

/** gpt-5.4 and later, and gpt-6 and later: detail "original" and patch costs. */
export function isOpenAiOriginalModel(model) {
  const id = String(model ?? '')
  const gpt5 = OPENAI_GPT5.exec(id)
  if (gpt5) return Number(gpt5[1]) >= 4
  const gpt6 = OPENAI_GPT6.exec(id)
  return Boolean(gpt6) && Number(gpt6[1]) >= 6
}

function geminiMajor(model) {
  const match = GEMINI_MODEL.exec(String(model ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * The image settings for a run. `color` is the caller's decision for one
 * image (see wantsColor); everything else follows from provider and model.
 *
 * Returns:
 *   maxEdgePx     long-edge cap passed to inspectPdfPage
 *   split         'none' | 'halves' passed to inspectPdfPage
 *   grayscale     true for text pages, false when colour is wanted
 *   detail        OpenAI image_url detail ('original' | 'high'), or null
 *   mediaResolution  Gemini part field (level), or null
 *   tier          a name for logs and tests
 */
export function imagePolicyFor({ type, model, color = false } = {}) {
  const grayscale = !color
  const id = String(model ?? '')
  const policy = (tier, maxEdgePx, split, detail = null, mediaResolution = null) => ({
    tier,
    maxEdgePx,
    split,
    grayscale,
    detail,
    mediaResolution,
  })
  if (isClaudeHighResModel(model)) {
    return policy('claude-high', CLAUDE_HIGH_RES_EDGE_PX, 'none')
  }
  if (type === 'anthropic' || /^claude-/.test(id)) {
    return policy('claude-standard', CLAUDE_STANDARD_EDGE_PX, 'halves')
  }
  const gemini = geminiMajor(model)
  if (type === 'google' || gemini !== null) {
    return policy(
      'gemini',
      GEMINI_ENGINE_EDGE_PX,
      'none',
      null,
      gemini !== null && gemini >= 3 ? 'high' : null
    )
  }
  if (/^gpt-/.test(id)) {
    if (isOpenAiOriginalModel(model)) {
      return policy('openai-original', CLAUDE_HIGH_RES_EDGE_PX, 'none', 'original')
    }
    return policy('openai-high', OPENAI_FIT_PX, 'halves', 'high')
  }
  return policy('fallback', FALLBACK_EDGE_PX, 'halves')
}

/**
 * Options for inspectPdfPage that follow from the policy. `split` and
 * `maxEdgePx` are what the provider needs; colour is per image.
 */
export function inspectOptionsFor(policy) {
  return {
    maxEdgePx: policy.maxEdgePx,
    split: policy.split,
    grayscale: policy.grayscale,
  }
}

const COLOR_SOURCE =
  /\\(?:includegraphics|tikz|begin\{(?:tikzpicture|figure|axis|tabular|minipage)\}|includesvg|pgfplots|definecolor|textcolor|color\b|colorbox|fcolorbox|xcolor)/

/**
 * Colour is worth its cost when the source the page shows is a figure, a
 * TikZ picture or uses colour. Text pages stay grayscale.
 */
export function wantsColor(sourceText) {
  return COLOR_SOURCE.test(String(sourceText ?? ''))
}

/**
 * What one image costs in tokens, for the context budget. `width` and
 * `height` are the pixels the provider sees (after the run's resize). Returns
 * IMAGE_TOKEN_FALLBACK when the size is unknown.
 */
export function estimateImageTokens({
  width,
  height,
  provider,
  model,
  detail,
} = {}) {
  const w = Number(width)
  const h = Number(height)
  if (!(w > 0) || !(h > 0)) return IMAGE_TOKEN_FALLBACK
  const kind = provider ?? null

  if (kind === 'anthropic' || isClaudeHighResModel(model)) {
    // The provider scales an image down until it fits the tier's visual token
    // cap, so the cost is that of the scaled size.
    const cap = isClaudeHighResModel(model)
      ? CLAUDE_HIGH_RES_TOKENS
      : CLAUDE_STANDARD_TOKENS
    const tokens = (x, y) => Math.ceil(x / 28) * Math.ceil(y / 28)
    let cost = tokens(w, h)
    if (cost > cap) {
      const k = Math.sqrt(cap / cost)
      cost = tokens(Math.floor(w * k), Math.floor(h * k))
    }
    return cost
  }
  if (kind === 'google' || geminiMajor(model) !== null) {
    const major = geminiMajor(model)
    if (major !== null && major >= 3) {
      const levels = { low: 280, medium: 560, high: 1120, ultra_high: 2240 }
      return levels[detail] ?? levels.high
    }
    return Math.ceil(w / 768) * Math.ceil(h / 768) * 258
  }
  if (isOpenAiOriginalModel(model)) {
    const patches = Math.ceil(w / 32) * Math.ceil(h / 32)
    return Math.ceil(patches * 1.2)
  }
  if (/^gpt-/.test(String(model ?? ''))) {
    if (isOpenAiOriginalModel(model)) {
      // 32 px patches, shrunk to fit the patch budget, times the model's multiplier.
      const patches = Math.ceil(w / 32) * Math.ceil(h / 32)
      return Math.ceil(patches * 1.2)
    }
    const gpt5 = /^gpt-5(\.1)?(?![\d.])/.test(String(model))
    if (detail === 'low') return gpt5 ? 70 : 85
    // Fit 2048, then shrink the short side to 768, then count 512 px tiles.
    const scale = Math.min(1, OPENAI_FIT_PX / Math.max(w, h))
    let sw = w * scale
    let sh = h * scale
    const short = Math.min(sw, sh)
    if (short > OPENAI_SHORT_SIDE_PX) {
      const k = OPENAI_SHORT_SIDE_PX / short
      sw *= k
      sh *= k
    }
    const tiles = Math.ceil(sw / 512) * Math.ceil(sh / 512)
    return gpt5 ? 70 + 140 * tiles : 85 + 170 * tiles
  }
  return IMAGE_TOKEN_FALLBACK
}
