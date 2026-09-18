/**
 * Frontend LaTeX tokenization, double-backslash normalization, and anchor matching.
 *
 * Note: Frontend and Backend have separate build pipelines in Overleaf. This module
 * is the TypeScript twin of matching functions in `modules/ai-assist/app/src/AiAssistTools.mjs`.
 * Any logic changes here must be mirrored in `AiAssistTools.mjs`.
 */

export type CodeToken = {
  text: string
  start: number
  end: number
}

export type MatchResult = {
  type: 'exact' | 'cleaned' | 'fuzzy' | 'whitespace' | 'fuzzy_words'
  anchor: string
  charStart?: number
  charEnd?: number
  score?: number
}

export function normalizeLines(str: string): string {
  return (str || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strips line numbers (e.g. "14: " or "14| ") from the start of lines.
 */
export function cleanLineNumbers(text: string): string {
  return (text || '').replace(/^\s*\d+[:|]\s?/gm, '')
}

/**
 * Normalizes double-escaped LaTeX macro backslashes that occur when models
 * emit LaTeX strings inside JSON tool calls (e.g. \\centering -> \centering).
 * Also strips accidental line-number prefixes.
 */
export function cleanOldText(text: string): string {
  if (!text) return ''
  let cleaned = cleanLineNumbers(text)
  // Normalize double-escaped LaTeX backslashes e.g. \\centering -> \centering
  cleaned = cleaned.replace(/\\\\([a-zA-Z@{}\[\]$%&_#\\]|\\\\)/g, '\\$1')
  return cleaned
}

/**
 * Tokenizes LaTeX code into commands, environments, braces, words, and backslashes.
 */
export function tokenizeCode(str: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const re = /\\[a-zA-Z@]+|\\end\{[^}]*\}|\\begin\{[^}]*\}|\{[^}]*\}|[^\s\\{}]+|\\/g
  let m: RegExpExecArray | null
  while ((m = re.exec(str)) !== null) {
    tokens.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return tokens
}

/**
 * Counts occurrences of needle in haystack with exact and trimmed-line fallbacks.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  let count = 0
  let index = normH.indexOf(normN)
  while (index !== -1) {
    count += 1
    index = normH.indexOf(normN, index + normN.length)
  }
  if (count > 0) return count

  // Fallback: trimmed lines (ignore trailing whitespace differences)
  const trimH = normH
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  const trimN = normN
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
  index = trimH.indexOf(trimN)
  while (index !== -1) {
    count += 1
    index = trimH.indexOf(trimN, index + trimN.length)
  }
  return count
}

/**
 * Matches needle against haystack across whitespace variations using token stream comparison.
 */
export function findWhitespaceAgnosticAnchor(
  haystack: string,
  needle: string
): { matchedText: string; charStart: number; charEnd: number } | null {
  if (!needle || !haystack) return null
  const cleanedNeedle = cleanOldText(needle)
  const hTokens = tokenizeCode(haystack)
  const nTokens = tokenizeCode(cleanedNeedle)

  if (nTokens.length === 0 || hTokens.length < nTokens.length) return null

  // Normalize tokens: strip redundant backslashes on commands
  const normN = nTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))
  const normH = hTokens.map(t => t.text.replace(/\\\\([a-zA-Z@]+)/g, '\\$1'))

  const matchIndices: number[] = []

  for (let i = 0; i <= normH.length - normN.length; i++) {
    let match = true
    for (let j = 0; j < normN.length; j++) {
      if (normH[i + j] !== normN[j]) {
        match = false
        break
      }
    }
    if (match) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    const endIdx = startIdx + normN.length - 1
    const charStart = hTokens[startIdx].start
    const charEnd = hTokens[endIdx].end
    return {
      matchedText: haystack.slice(charStart, charEnd),
      charStart,
      charEnd,
    }
  }

  return null
}

/**
 * Line-by-line fuzzy matching ignoring line prefixes and leading/trailing whitespace.
 */
export function findFuzzyUniqueAnchor(haystack: string, needle: string): string | null {
  if (!needle) return null
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)

  // 1. Try stripped line numbers
  const stripped = cleanLineNumbers(normN)
  if (stripped && stripped !== normN) {
    const strippedOccurrences = countOccurrences(normH, stripped)
    if (strippedOccurrences === 1) {
      return stripped
    }
  }

  // Also try cleaned old text (stripped line numbers + normalized backslashes)
  const cleaned = cleanOldText(normN)
  if (cleaned && cleaned !== normN) {
    const cleanedOccurrences = countOccurrences(normH, cleaned)
    if (cleanedOccurrences === 1) {
      return cleaned
    }
  }

  // 2. Line-by-line trimmed matching against haystack lines
  const hLines = normH.split('\n')
  const nLines = (cleaned || stripped || normN).split('\n')

  while (nLines.length > 1 && nLines[nLines.length - 1].trim() === '') {
    nLines.pop()
  }
  while (nLines.length > 1 && nLines[0].trim() === '') {
    nLines.shift()
  }

  const trimmedN = nLines.map(l => l.trim())
  if (trimmedN.length === 0 || trimmedN.every(l => l === '')) return null

  const matchIndices: number[] = []

  for (let i = 0; i <= hLines.length - trimmedN.length; i++) {
    let matches = true
    for (let j = 0; j < trimmedN.length; j++) {
      if (hLines[i + j].trim() !== trimmedN[j]) {
        matches = false
        break
      }
    }
    if (matches) {
      matchIndices.push(i)
    }
  }

  if (matchIndices.length === 1) {
    const startIdx = matchIndices[0]
    return hLines.slice(startIdx, startIdx + trimmedN.length).join('\n')
  }

  return null
}

/**
 * Four-tier anchor locator mirroring backend locateAnchorInText:
 * 1. Exact match
 * 2. Cleaned backslashes / line numbers
 * 3. Fuzzy anchor matching
 * 4. Whitespace-agnostic token matching
 */
export function locateAnchorInText(docText: string, anchor: string): MatchResult | null {
  if (!docText || !anchor) return null

  // 1. Exact match
  let count = countOccurrences(docText, anchor)
  if (count === 1) return { type: 'exact', anchor }

  // 2. Cleaned backslashes / line numbers
  const cleaned = cleanOldText(anchor)
  if (cleaned && cleaned !== anchor) {
    count = countOccurrences(docText, cleaned)
    if (count === 1) return { type: 'cleaned', anchor: cleaned }
  }

  // 3. Fuzzy anchor matching
  const fuzzy = findFuzzyUniqueAnchor(docText, anchor) || (cleaned ? findFuzzyUniqueAnchor(docText, cleaned) : null)
  if (fuzzy) return { type: 'fuzzy', anchor: fuzzy }

  // 4. Whitespace-agnostic token matching
  const wsMatch = findWhitespaceAgnosticAnchor(docText, anchor) || (cleaned ? findWhitespaceAgnosticAnchor(docText, cleaned) : null)
  if (wsMatch) {
    return {
      type: 'whitespace',
      anchor: wsMatch.matchedText,
      charStart: wsMatch.charStart,
      charEnd: wsMatch.charEnd,
    }
  }

  // 5. Fuzzy word window matching
  const wordMatch = findFuzzyWordWindow(docText, anchor) || (cleaned ? findFuzzyWordWindow(docText, cleaned) : null)
  if (wordMatch) {
    return {
      type: 'fuzzy_words',
      anchor: wordMatch.anchor,
      charStart: wordMatch.charStart,
      charEnd: wordMatch.charEnd,
      score: wordMatch.score,
    }
  }

  return null
}

export function cleanWord(w: string): string {
  return (w || '').toLowerCase().replace(/[^a-z0-9\\]/g, '')
}

/**
 * Matches a passage against the document by word sequence alignment.
 * Handles paragraphs with differing line-wrapping, LaTeX quotes ('' vs "),
 * escaped symbols (\\% vs %), tildes (~ vs space), and minor punctuation differences.
 */
export function findFuzzyWordWindow(
  docText: string,
  needleText: string,
  threshold = 0.75
): { anchor: string; charStart: number; charEnd: number; score: number } | null {
  if (!docText || !needleText) return null

  // Tokenize doc into words with character offsets
  const docWords: Array<{ clean: string; start: number; end: number }> = []
  const wordRe = /\S+/g
  let m: RegExpExecArray | null
  while ((m = wordRe.exec(docText)) !== null) {
    const raw = m[0]
    const clean = cleanWord(raw)
    if (clean) {
      docWords.push({ clean, start: m.index, end: m.index + raw.length })
    }
  }

  const needleWords: string[] = []
  while ((m = wordRe.exec(needleText)) !== null) {
    const clean = cleanWord(m[0])
    if (clean) needleWords.push(clean)
  }

  if (needleWords.length < 3 || docWords.length < 3) return null
  const nLen = needleWords.length

  const hits: Array<{ startIdx: number; endIdx: number; score: number }> = []
  const minW = Math.max(3, nLen - 4)
  const maxW = Math.min(docWords.length, nLen + 4)

  for (let i = 0; i <= docWords.length - minW; i++) {
    for (let w = minW; w <= Math.min(docWords.length - i, maxW); w++) {
      let matches = 0
      let d = 0
      let n = 0
      while (d < w && n < nLen) {
        if (docWords[i + d].clean === needleWords[n]) {
          matches++
          d++
          n++
        } else if (d + 1 < w && docWords[i + d + 1].clean === needleWords[n]) {
          d += 2
          n++
          matches += 0.8
        } else if (n + 1 < nLen && docWords[i + d].clean === needleWords[n + 1]) {
          d++
          n += 2
          matches += 0.8
        } else {
          d++
          n++
        }
      }
      const score = (2 * matches) / (w + nLen)
      if (score >= threshold) {
        hits.push({ startIdx: i, endIdx: i + w - 1, score })
      }
    }
  }

  if (hits.length === 0) return null

  // Cluster overlapping hits (overlapping index ranges correspond to the same document occurrence)
  hits.sort((a, b) => b.score - a.score)
  const clusters: Array<{ best: { startIdx: number; endIdx: number; score: number } }> = []
  for (const hit of hits) {
    let merged = false
    for (const cluster of clusters) {
      if (Math.max(hit.startIdx, cluster.best.startIdx) <= Math.min(hit.endIdx, cluster.best.endIdx)) {
        merged = true
        break
      }
    }
    if (!merged) {
      clusters.push({ best: hit })
    }
  }

  if (clusters.length === 1 && clusters[0].best.score >= threshold) {
    const best = clusters[0].best
    const startChar = docWords[best.startIdx].start
    const endChar = docWords[best.endIdx].end
    return {
      anchor: docText.slice(startChar, endChar),
      charStart: startChar,
      charEnd: endChar,
      score: best.score,
    }
  }

  return null
}

/**
 * Formats rich preview snippets around occurrences of an ambiguous anchor.
 */
export function formatAmbiguousOccurrences(
  docText: string,
  lineNumbers: number[],
  maxOccurrences = 4
): string {
  const lines = docText.split('\n')
  const shown = lineNumbers.slice(0, maxOccurrences)
  const previews = shown.map(lineNo => {
    const idx = lineNo - 1
    const start = Math.max(0, idx - 1)
    const end = Math.min(lines.length, idx + 3)
    const snippet = lines
      .slice(start, end)
      .map((l, offset) => `    ${start + offset + 1}: ${l}`)
      .join('\n')
    return `  Occurrence around line ${lineNo}:\n${snippet}`
  })

  return previews.join('\n\n')
}

/**
 * Returns up to 5 1-based candidate line numbers where the anchor (or its first non-empty line)
 * occurs in the haystack. Used for diagnostic error messages.
 */
export function findMatchingLines(haystack: string, needle: string): number[] {
  if (!needle || !haystack) return []
  const normH = normalizeLines(haystack)
  const normN = cleanOldText(normalizeLines(needle))
  const hLines = normH.split('\n')
  const nLines = normN.split('\n').map(l => l.trim()).filter(Boolean)
  if (nLines.length === 0) return []

  const targetLine = nLines[0]
  const results: number[] = []

  // Check exact line match or substring match for first line
  for (let i = 0; i < hLines.length; i++) {
    const trimmedH = hLines[i].trim()
    if (trimmedH === targetLine || (targetLine.length > 5 && trimmedH.includes(targetLine))) {
      results.push(i + 1)
    }
  }
  return results.slice(0, 5)
}

/**
 * Sanitizes accidental line-number prefixes in newText (e.g. "14: \\usepackage{amsmath}")
 * while protecting legitimate numbered content (e.g. "1. First item" in lists or math constants).
 *
 * Guard rule: Only strips if:
 * 1. oldTextWasStripped is true (the model was confirmed to be quoting numbered lines), OR
 * 2. A majority (>= 50%) of non-empty lines match the /^\s*\d+[:|]\s?/ pattern.
 */
export function cleanLineNumberPrefixes(text: string, oldTextWasStripped = false): string {
  if (!text) return ''
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter(l => l.trim().length > 0)
  if (nonEmptyLines.length === 0) return text

  const prefixRegex = /^\s*\d+[:|]\s?/
  const matchingLines = nonEmptyLines.filter(l => prefixRegex.test(l))

  const isMajority = matchingLines.length >= Math.ceil(nonEmptyLines.length / 2)
  if (oldTextWasStripped || isMajority) {
    return lines.map(line => line.replace(prefixRegex, '')).join('\n')
  }

  return text
}

/**
 * The nearest existing lines to an anchor that did not match.
 * Gives the model actionable lines to copy from, turning a dead-end noMatch into a productive edit.
 */
export function nearestLines(
  text: string,
  oldText: string,
  limit = 5
): Array<{ line: number; text: string }> {
  const cleaned = cleanOldText(oldText || '')
  const probes = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 4)
  if (probes.length === 0) return []

  const lines = normalizeLines(text).split('\n')
  const scored: Array<{ line: number; text: string; score: number }> = []

  lines.forEach((line, index) => {
    const candidate = line.trim()
    if (!candidate) return
    for (const probe of probes) {
      let score = 0
      if (candidate === probe) score = 3
      else if (candidate.includes(probe) || probe.includes(candidate)) score = 2
      else if (
        probe.length > 6 &&
        candidate.toLowerCase().includes(probe.slice(0, 6).toLowerCase())
      ) {
        score = 1
      }
      if (score > 0) {
        scored.push({ line: index + 1, text: line, score })
        break
      }
    }
  })

  return scored
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit)
    .map(({ line, text: lineText }) => ({ line, text: lineText }))
}

