import crypto from 'node:crypto'

/**
 * Valid canonical licence codes recognized by the template gallery.
 */
export const LICENCE_CODES = [
  'cc-by-4.0',
  'cc-by-sa-4.0',
  'lppl-1.3c',
  'mit',
  'cc0-1.0',
  'apache-2.0',
  'other',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0',
  'cc-by-nc-nd-4.0',
  'unknown',
]

/**
 * Suggests a canonical licence code from an upstream declared label.
 *
 * @param {string | null | undefined} declaredLabel
 * @returns {string}
 */
export function suggestCodeFromLabel(declaredLabel) {
  if (!declaredLabel || typeof declaredLabel !== 'string') {
    return 'unknown'
  }

  const trimmed = declaredLabel.trim()
  if (!trimmed) {
    return 'unknown'
  }

  const lower = trimmed.toLowerCase()

  // Non-commercial rules checked first
  if (
    lower.includes('cc by-nc-nd') ||
    lower.includes('attribution-noncommercial-noderivatives') ||
    lower.includes('by-nc-nd')
  ) {
    return 'cc-by-nc-nd-4.0'
  }
  if (
    lower.includes('cc by-nc-sa') ||
    lower.includes('attribution-noncommercial-sharealike') ||
    lower.includes('by-nc-sa')
  ) {
    return 'cc-by-nc-sa-4.0'
  }
  if (
    lower.includes('cc by-nc') ||
    lower.includes('attribution-noncommercial') ||
    lower.includes('by-nc')
  ) {
    return 'cc-by-nc-4.0'
  }

  // Creative Commons ShareAlike
  if (
    lower.includes('cc by-sa') ||
    lower.includes('attribution-sharealike') ||
    lower.includes('by-sa')
  ) {
    return 'cc-by-sa-4.0'
  }

  // Creative Commons Attribution
  if (
    lower.includes('cc by') ||
    lower.includes('creative commons cc by') ||
    lower.includes('attribution 4.0')
  ) {
    return 'cc-by-4.0'
  }

  // CC0 / Public Domain
  if (
    lower.includes('cc0') ||
    lower.includes('public domain') ||
    lower.includes('cc-0')
  ) {
    return 'cc0-1.0'
  }

  // LPPL
  if (
    lower.includes('latex project public license') ||
    lower.includes('lppl')
  ) {
    return 'lppl-1.3c'
  }

  // MIT
  if (
    lower === 'mit' ||
    lower.includes('mit license') ||
    lower === 'mit licenced' ||
    lower === 'mit licensed'
  ) {
    return 'mit'
  }

  // Apache
  if (
    lower.includes('apache') ||
    lower.includes('apache license') ||
    lower.includes('apache 2.0')
  ) {
    return 'apache-2.0'
  }

  // Other
  if (
    lower.includes('other (as stated in the work)') ||
    lower.includes('other (stated in the work)') ||
    lower === 'other' ||
    lower.startsWith('other')
  ) {
    return 'other'
  }

  return 'unknown'
}

/**
 * Detects licence code from full licence or readme text content.
 * Evaluates non-commercial rules FIRST, then standard open licenses.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
export function detectFromText(text) {
  if (!text || typeof text !== 'string') {
    return null
  }

  const s = text

  // 1. Non-commercial rules FIRST
  if (
    /Attribution-NonCommercial-NoDerivatives 4\.0/i.test(s) ||
    /CC BY-NC-ND 4\.0/i.test(s) ||
    /CC-BY-NC-ND/i.test(s)
  ) {
    return 'cc-by-nc-nd-4.0'
  }

  if (
    /Attribution-NonCommercial-ShareAlike 4\.0/i.test(s) ||
    /CC BY-NC-SA 4\.0/i.test(s) ||
    /CC-BY-NC-SA/i.test(s)
  ) {
    return 'cc-by-nc-sa-4.0'
  }

  if (
    /Attribution-NonCommercial 4\.0/i.test(s) ||
    /CC BY-NC 4\.0/i.test(s) ||
    /CC-BY-NC/i.test(s)
  ) {
    return 'cc-by-nc-4.0'
  }

  // 2. CC BY-SA 4.0
  if (
    /Attribution-ShareAlike 4\.0/i.test(s) ||
    /CC BY-SA 4\.0/i.test(s) ||
    /CC-BY-SA/i.test(s)
  ) {
    return 'cc-by-sa-4.0'
  }

  // 3. CC BY 4.0
  if (
    /Attribution 4\.0 International/i.test(s) ||
    /CC BY 4\.0/i.test(s) ||
    /Creative Commons Attribution 4\.0/i.test(s)
  ) {
    return 'cc-by-4.0'
  }

  // 4. LPPL 1.3c
  if (
    /LaTeX Project Public License(?:, version 1\.3c| 1\.3c)?/i.test(s) ||
    /LPPL 1\.3c/i.test(s) ||
    /LPPL Version 1\.3c/i.test(s)
  ) {
    return 'lppl-1.3c'
  }

  // 5. MIT License
  if (
    /MIT License/i.test(s) ||
    /Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i.test(s)
  ) {
    return 'mit'
  }

  // 6. CC0 1.0
  if (
    /CC0 1\.0 Universal/i.test(s) ||
    /CC0 1\.0/i.test(s) ||
    /Public Domain Dedication/i.test(s)
  ) {
    return 'cc0-1.0'
  }

  // 7. Apache License, Version 2.0
  if (
    /Apache License, Version 2\.0/i.test(s) ||
    /Apache License\s+Version 2\.0/i.test(s) ||
    /http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/i.test(s)
  ) {
    return 'apache-2.0'
  }

  return null
}

/**
 * Computes deterministic sha256 hash of licence state.
 *
 * @param {{ declared?: string | null, code?: string | null, detected?: string | null, detectedSha256?: string | null, conflict?: boolean }} params
 * @returns {string}
 */
export function computeLicenceHash({ declared, code, detected, detectedSha256, conflict } = {}) {
  const payload = JSON.stringify([
    declared || '',
    code || 'unknown',
    detected || null,
    detectedSha256 || null,
    Boolean(conflict),
  ])
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * Evaluates full licence state against configuration rules.
 *
 * @param {object} licenceObj - Item's licence object
 * @param {object} licenceCfg - Settings.templateGallery.licence
 * @returns {{ conflict: boolean, isBlocked: boolean, requiresAck: boolean, ackValid: boolean, licenceHash: string }}
 */
export function evaluateLicence(licenceObj = {}, licenceCfg = {}) {
  const declared = licenceObj?.declared || ''
  const code = licenceObj?.code || suggestCodeFromLabel(declared)
  const detected = licenceObj?.detected || null
  const detectedSha256 = licenceObj?.detectedSha256 || null

  // Conflict exists if detected code exists and does not match resolved code
  const conflict = Boolean(detected && detected !== code)

  const licenceHash = computeLicenceHash({
    declared,
    code,
    detected,
    detectedSha256,
    conflict,
  })

  const blockedCodes = Array.isArray(licenceCfg?.blockedCodes)
    ? licenceCfg.blockedCodes
    : ['cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0', 'unknown']

  const counselOverride = Array.isArray(licenceCfg?.counselOverride)
    ? licenceCfg.counselOverride
    : []

  const ackRequiredCodes = Array.isArray(licenceCfg?.ackRequiredCodes)
    ? licenceCfg.ackRequiredCodes
    : ['other']

  const ackMinNoteChars = Number(licenceCfg?.ackMinNoteChars) || 20

  // Blocked check: a blocked code on EITHER side (declared code or detected code) stops publication
  // unless overridden by counsel
  const codeBlocked = blockedCodes.includes(code) && !counselOverride.includes(code)
  const detectedBlocked =
    Boolean(detected) && blockedCodes.includes(detected) && !counselOverride.includes(detected)
  const isBlocked = codeBlocked || detectedBlocked

  // Requires ack: code is in ackRequiredCodes OR conflict is true
  const requiresAck = ackRequiredCodes.includes(code) || conflict

  // Ack validation check
  const ack = licenceObj?.ack
  let ackValid = false
  if (ack && typeof ack === 'object') {
    const hasAdmin = Boolean(ack.by)
    const note = String(ack.note || '').trim()
    const noteOk = note.length >= ackMinNoteChars
    const hashMatches = ack.hash ? ack.hash === licenceHash : true
    ackValid = hasAdmin && noteOk && hashMatches
  }

  return {
    conflict,
    isBlocked,
    requiresAck,
    ackValid,
    licenceHash,
  }
}

export default {
  LICENCE_CODES,
  suggestCodeFromLabel,
  detectFromText,
  computeLicenceHash,
  evaluateLicence,
}
