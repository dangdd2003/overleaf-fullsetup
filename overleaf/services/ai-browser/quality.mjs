/**
 * Bot challenge patterns matching Overleaf quality.mjs.
 */
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

export function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isChallenge(html = '', text = '') {
  if (collapse(text).length >= CONTENT_CHARS) return false
  return CHALLENGE_PATTERNS.some(
    pattern => pattern.test(html) || pattern.test(text)
  )
}
