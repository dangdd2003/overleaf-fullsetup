import { collapse } from './util.mjs'

/**
 * Whether what a route brought back is the page, or something standing in
 * for it: a bot check, or the empty shell of a page that renders in
 * JavaScript. Either sends the fetch on to the next route.
 */

/** Below this much text, an HTML page is suspected of being a shell. */
export const THIN_CHARS = 400
/** A page with this much text is content, whatever words it contains. */
const CONTENT_CHARS = 2000

const CHALLENGE_PATTERNS = [
  /<title>\s*just a moment\.*\s*<\/title>/i,
  /window\._cf_chl_opt/i,
  /attention required!\s*\|\s*cloudflare/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /enable javascript and cookies to continue/i,
  /captcha-delivery\.com/i,
  /px-captcha/i,
  /_incapsula_resource/i,
  /<title>\s*access denied\s*<\/title>[\s\S]{0,4000}reference\s*#/i,
  /please verify you are (?:a )?human/i,
  /complete the security check/i,
]

const SHELL_PATTERNS = [
  /<div\b[^>]*\bid\s*=\s*["']?(?:root|__next|app)["']?[^>]*>\s*<\/div>/i,
  /<[^>]+\bng-app\b/i,
  /<noscript\b[^>]*>[\s\S]{0,500}?enable javascript/i,
]

/** True when the page is a bot check rather than the content asked for. */
export function isChallenge(html = '', text = '') {
  if (collapse(text).length >= CONTENT_CHARS) return false
  return CHALLENGE_PATTERNS.some(
    pattern => pattern.test(html) || pattern.test(text)
  )
}

/**
 * 'challenge', 'thin' or 'ok'. `html` is the raw page when there is one;
 * `text` is what was extracted from it, or what a reader API returned.
 */
export function assessContent({ html = '', text = '' } = {}) {
  if (isChallenge(html, text)) return 'challenge'
  if (
    html &&
    collapse(text).length < THIN_CHARS &&
    (html.length > 20_000 || SHELL_PATTERNS.some(pattern => pattern.test(html)))
  ) {
    return 'thin'
  }
  return 'ok'
}
