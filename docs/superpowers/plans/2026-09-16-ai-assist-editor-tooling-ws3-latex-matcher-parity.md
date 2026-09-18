# AI Assist Editor Tooling: Workstream 3 — Robust LaTeX Matching & Schema Ambiguity Resolution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port backend LaTeX tokenization and double-backslash unescaping to the frontend editor tooling, eliminate contradictory full-file replace guidance, provide informative line-number diagnostic feedback on `noMatch` and `ambiguous`, sanitize line-number prefixes in `newText`, and support line-scoped search (`startLine` / `endLine`).

**Architecture:** Frontend and backend have separate build targets in Overleaf (Webpack/TypeScript for the browser vs Node.js ESM for the backend). Rather than creating cross-boundary build dependencies, we create a dedicated frontend module `modules/ai-assist/frontend/js/features/ai-assist/agent/latex-matcher.ts` with full parity to `modules/ai-assist/app/src/AiAssistTools.mjs` (tokenization, double-backslash normalization, whitespace-agnostic token matching, candidate line search). `edit-file.ts` uses this matcher to execute 4-tier anchor matching and returns actionable candidate line numbers when edits fail. Line-number prefix contamination from `read_file` is defended with a majority guard in `cleanLineNumberPrefixes`, and the contradictory full-file replace guidance is excised from `AiAssistTools.mjs`.

**Tech Stack:** TypeScript, Node.js (ES modules `.mjs`), Webpack, Mocha + Chai + Sinon (Frontend unit tests), Vitest (Backend unit tests).

**Spec:** `overleaf/docs/superpowers/specs/2026-09-16-ai-assist-editor-tooling-redesign-design.md`

---

## Global Constraints

- **Never run `git commit`, `git push`, or any history-altering git command.** This repository requires explicit per-command user approval for all git writes. Leave every change in the working tree. Verification steps replace commit steps. This overrides any instruction from a sub-skill telling you to commit after each task.
- **Working directory for all commands:** `overleaf/services/web` inside the `ai-assist` worktree:
  `/home/dangdd/projects/overleaf-fullsetup/.claude/worktrees/ai-assist/overleaf/services/web`
- **Frontend test runner (Mocha — note: NOT vitest):**
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
    --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
    --require test/frontend/bootstrap.js \
    modules/ai-assist/test/frontend
  ```
  *Single-file execution:*
  ```bash
  NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
    --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
    --require test/frontend/bootstrap.js \
    modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
  ```
- **Backend test runner (Vitest — note: NOT mocha):**
  ```bash
  NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
  ```
- **Baselines (verified 2026-09-16, all green):**
  - Frontend: 774 passing, 0 failing across `modules/ai-assist/test/frontend`.
  - Backend: 10 test files, 107 passing across `modules/ai-assist/test/unit/src`.
- **Engineering over Prompts:** Fixes must be engineered into the tools and harness. Do not attempt to fix tool failures by adding workaround instructions to system prompts.
- **Fail-Closed Diff Gate:** Every edit remains behind the user approval diff card.
- **No Thrown Errors in Agent Loop:** All tool failures return structured error messages that models can inspect and retry.
- **Direct LLM Communication:** No new backend endpoints wrapping LLM provider APIs.

---

## Cross-Workstream Dependencies & Sequencing

This plan is **Workstream 3** in the 5-workstream sequence:
```
[WS1: Bridge Path Targeting] ──> [WS2: Precision Anchor Apply] ──> [WS3: LaTeX Matcher Parity] ──> [WS4: Compiler Feedback Loop] ──> [WS5: Context & Search Hygiene]
```

- **Relationship with WS1 & WS2:** WS1 establishes path targeting in `use-project-handle.ts` and `apply-fix-listener.tsx`, and WS2 replaces line-granular replacements with character-offset precision. WS3 operates at the anchor resolution and schema layer in `edit-file.ts`, `latex-matcher.ts`, `read-file.ts`, and `AiAssistTools.mjs`.
- **Line drift note:** When implementing after WS1/WS2, verify target functions by name (`editFileTool.execute`, `findUniqueSpan`) rather than absolute line numbers.

---

## File Structure & Changes Inventory

| File Path | Action | Description |
|---|---|---|
| `modules/ai-assist/frontend/js/features/ai-assist/agent/latex-matcher.ts` | **Create** | Frontend LaTeX tokenization, double-backslash normalization, 4-tier anchor matching, candidate line search, line-prefix sanitizer. Twin of `AiAssistTools.mjs`. |
| `modules/ai-assist/test/frontend/js/agent/latex-matcher.test.ts` | **Create** | Dedicated unit tests for `latex-matcher.ts` (tokenization, backslash repair, line number sanitization majority guard, candidate diagnostics). |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts` | **Modify** | Integrate `latex-matcher`, update JSON schema (`required: ['path', 'oldText', 'newText']`, optional `startLine`/`endLine`), sanitize `newText`, return line numbers on `noMatch`/`ambiguous`. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts` | **Modify** | Add optional `startLine?: number` and `endLine?: number` to `EditRequest` interface. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts` | **Modify** | Clarify in description that line number prefixes (`14: `) are for display/reference only and must not be included in edits. |
| `modules/ai-assist/frontend/js/features/ai-assist/agent/context/fix-source.ts` | **Modify** | Add explicit documentation on line-number prefixes in source windows. |
| `modules/ai-assist/app/src/AiAssistTools.mjs` | **Modify** | Remove false claim that `oldText: ""` replaces full file; sanitize `newText` line prefixes; update `edit_file` description and schema in backend. |
| `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts` | **Modify** | Unit tests for double-backslash matching, `newText` sanitization, candidate line numbers on failure, line scoping. |
| `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts` | **Modify** | Verify updated `read_file` parameter and schema descriptions. |
| `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs` | **Modify** | Vitest tests for backend schema accuracy and `cleanLineNumberPrefixes` integration. |

---

### Task 1: Create Frontend LaTeX Matcher Module (`latex-matcher.ts`)

**Goal:** Port `cleanOldText`, `tokenizeCode`, `findWhitespaceAgnosticAnchor`, `locateAnchorInText`, `findMatchingLines`, and line prefix sanitization into a dedicated frontend TypeScript module, achieving full matching parity with backend `AiAssistTools.mjs`.

**Files:**
- Create: `modules/ai-assist/frontend/js/features/ai-assist/agent/latex-matcher.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/latex-matcher.test.ts`

**Detailed Implementation:**

Create `modules/ai-assist/frontend/js/features/ai-assist/agent/latex-matcher.ts`:
```ts
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
  type: 'exact' | 'cleaned' | 'fuzzy' | 'whitespace'
  anchor: string
  charStart?: number
  charEnd?: number
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
  cleaned = cleaned.replace(/\\\\([a-zA-Z@]+)/g, '\\$1')
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

  // 2. Line-by-line trimmed matching against haystack lines
  const hLines = normH.split('\n')
  const nLines = (stripped || normN).split('\n')

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

  return null
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
```

- [ ] **Step 1: Write unit tests in `modules/ai-assist/test/frontend/js/agent/latex-matcher.test.ts`**

Create `modules/ai-assist/test/frontend/js/agent/latex-matcher.test.ts`:
```ts
import { expect } from 'chai'
import {
  cleanOldText,
  cleanLineNumbers,
  cleanLineNumberPrefixes,
  tokenizeCode,
  countOccurrences,
  findWhitespaceAgnosticAnchor,
  findFuzzyUniqueAnchor,
  locateAnchorInText,
  findMatchingLines,
} from '../../../../frontend/js/features/ai-assist/agent/latex-matcher'

describe('latex-matcher', function () {
  describe('cleanOldText', function () {
    it('normalizes double-escaped LaTeX macro backslashes', function () {
      expect(cleanOldText('\\\\begin{equation}')).to.equal('\\begin{equation}')
      expect(cleanOldText('\\\\centering\\\\small')).to.equal('\\centering\\small')
      expect(cleanOldText('\\\\usepackage[utf8]{inputenc}')).to.equal('\\usepackage[utf8]{inputenc}')
    })

    it('strips line-number prefixes from oldText', function () {
      expect(cleanOldText('14: \\usepackage{amsmath}')).to.equal('\\usepackage{amsmath}')
      expect(cleanOldText('  102| \\begin{document}')).to.equal('\\begin{document}')
    })
  })

  describe('cleanLineNumberPrefixes (The Numbering Trap Guard)', function () {
    it('strips line numbers when majority of lines contain "N: " prefix', function () {
      const contaminated = '14: \\usepackage{amsmath}\n15: \\usepackage{amssymb}\n16: \\usepackage{graphicx}'
      const cleaned = cleanLineNumberPrefixes(contaminated)
      expect(cleaned).to.equal('\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}')
    })

    it('strips single line prefix when oldTextWasStripped is true', function () {
      const contaminated = '14: \\usepackage{amsmath}'
      expect(cleanLineNumberPrefixes(contaminated, true)).to.equal('\\usepackage{amsmath}')
    })

    it('preserves legitimate numbered lists and text containing numbers without colon prefix', function () {
      const list = '\\begin{enumerate}\n\\item 1. First point\n\\item 2. Second point\n\\end{enumerate}'
      expect(cleanLineNumberPrefixes(list)).to.equal(list)
    })

    it('preserves legitimate text where only an isolated single line starts with a number', function () {
      const text = 'Some introductory text.\n42 is the answer to the universe.\nMore text here.'
      expect(cleanLineNumberPrefixes(text)).to.equal(text)
    })
  })

  describe('locateAnchorInText 4-tier hierarchy', function () {
    const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Intro}\nHello world\n\\end{document}'

    it('tier 1: matches exact text', function () {
      const match = locateAnchorInText(doc, '\\section{Intro}')
      expect(match).to.deep.equal({ type: 'exact', anchor: '\\section{Intro}' })
    })

    it('tier 2: matches double-escaped backslashes and cleaned line numbers', function () {
      const match = locateAnchorInText(doc, '\\\\section{Intro}')
      expect(match).to.deep.equal({ type: 'cleaned', anchor: '\\section{Intro}' })
      const matchWithLine = locateAnchorInText(doc, '4: \\section{Intro}')
      expect(matchWithLine).to.deep.equal({ type: 'cleaned', anchor: '\\section{Intro}' })
    })

    it('tier 3: matches fuzzy trimmed anchor with whitespace/indentation differences', function () {
      const docWithIndent = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n  \\section{Intro}\nHello world\n\\end{document}'
      const match = locateAnchorInText(docWithIndent, '\\section{Intro}')
      expect(match).to.deep.equal({ type: 'fuzzy', anchor: '  \\section{Intro}' })
    })

    it('tier 4: matches whitespace-agnostic LaTeX tokens', function () {
      const match = locateAnchorInText(doc, '\\section  {Intro}')
      expect(match?.type).to.equal('whitespace')
      expect(match?.anchor).to.equal('\\section{Intro}')
    })

    it('returns null when anchor is absent', function () {
      const match = locateAnchorInText(doc, '\\section{NonExistent}')
      expect(match).to.equal(null)
    })
  })

  describe('findMatchingLines', function () {
    const doc = 'alpha\nbeta\ngamma\nbeta\nepsilon'

    it('returns 1-based candidate line numbers for occurrences', function () {
      const lines = findMatchingLines(doc, 'beta')
      expect(lines).to.deep.equal([2, 4])
    })

    it('finds candidate line for first line of multi-line anchor', function () {
      const lines = findMatchingLines(doc, 'gamma\nunknown')
      expect(lines).to.deep.equal([3])
    })

    it('returns empty array when no line matches', function () {
      expect(findMatchingLines(doc, 'zeta')).to.deep.equal([])
    })
  })
})
```

- [ ] **Step 2: Run test to verify implementation**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/latex-matcher.test.ts
```

---

### Task 2: Update `project-handle.ts` and `edit-file.ts` with Full LaTeX Parity, Diagnostics, and Line Scoping

**Goal:** Update `edit-file.ts` to use `latex-matcher.ts`, sanitize `newText`, return line-numbered diagnostics on `noMatch` and `ambiguous`, enforce `required: ['path', 'oldText', 'newText']`, and add optional `startLine` / `endLine` search scoping.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/project-handle.ts` (lines 17-21)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts`
- Test: `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`

**Code Modification in `project-handle.ts`:**

*Existing Code in `project-handle.ts` (lines 17-21):*
```ts
export type EditRequest = {
  path: string
  oldText: string
  newText: string
}
```

*Replacement Code in `project-handle.ts`:*
```ts
export type EditRequest = {
  path: string
  oldText: string
  newText: string
  startLine?: number
  endLine?: number
}
```

**Code Modification in `edit-file.ts`:**

Replace the entire contents of `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/edit-file.ts` with:
```ts
import { AgentTool } from './registry'
import {
  cleanLineNumbers,
  cleanOldText,
  cleanLineNumberPrefixes,
  countOccurrences,
  findFuzzyUniqueAnchor,
  findMatchingLines,
  locateAnchorInText,
  normalizeLines,
} from '../latex-matcher'

// Re-export matching utilities for external callers and backwards compatibility
export {
  cleanLineNumbers,
  cleanOldText,
  cleanLineNumberPrefixes,
  countOccurrences,
  findFuzzyUniqueAnchor,
  findMatchingLines,
  locateAnchorInText,
}

export const editFileTool: AgentTool = {
  // The loop must wait for the user's decision before continuing.
  suspends: true,
  mutates: true,
  spec: {
    name: 'edit_file',
    description:
      'Edit a project file. Replace oldText with newText. Pass oldText: "" to append newText to the end of the file. Pass newText: "" to delete oldText. The user reviews the change as a diff and may reject it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        oldText: {
          type: 'string',
          description:
            'The exact text to replace, unique within the file. Pass an empty string "" to append newText to the end of the file. Pass full file content if replacing the entire file.',
        },
        newText: {
          type: 'string',
          description:
            'The replacement text (or text to append if oldText is empty). Pass an empty string "" to delete oldText.',
        },
        startLine: {
          type: 'number',
          description:
            'Optional 1-based start line to constrain anchor search for ambiguous or repetitive LaTeX blocks.',
        },
        endLine: {
          type: 'number',
          description:
            'Optional 1-based end line to constrain anchor search for ambiguous or repetitive LaTeX blocks.',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },

  async execute({ path, oldText, newText, startLine, endLine }, handle) {
    if (typeof newText !== 'string') {
      return { error: 'Parameter \'newText\' must be a string containing the replacement or appended text (pass "" to delete).' }
    }

    if (typeof oldText !== 'string') {
      return {
        error: `Parameter 'oldText' is required to replace text in ${path}. Provide the exact snippet from the file to replace, or pass "" to append to the end of the file.`,
      }
    }

    const files = await handle.listFiles()
    const file = files.find(candidate => candidate.path === path)
    if (!file) return { error: `File not found: ${path}` }
    if (file.type === 'binary') {
      return { error: `${path} is a binary file and cannot be edited.` }
    }

    // Determine if oldText had line number prefixes stripped
    const strippedOld = cleanLineNumbers(oldText)
    const oldTextWasStripped = strippedOld !== oldText && strippedOld.length > 0

    // Sanitize newText to prevent raw line-number prefix contamination
    const sanitizedNewText = cleanLineNumberPrefixes(newText, oldTextWasStripped)

    // Append mode: when oldText is explicitly empty string ""
    const isAppend = oldText.length === 0
    if (isAppend) {
      const outcome = await handle.proposeEdit({ path, oldText: '', newText: sanitizedNewText })
      switch (outcome.status) {
        case 'applied':
          return {
            status: 'applied',
            message: `Appended the change to ${path}.`,
            startLine: (outcome as any).startLine,
          }
        case 'rejected': {
          const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
          return {
            status: 'rejected',
            note: outcome.note,
            message: `The user rejected this change${userNote}. Do not attempt the same change again in this turn. Acknowledge the rejection, address their feedback, and explain an alternative approach or ask how they would like to proceed.`,
          }
        }
        case 'drifted':
          return {
            status: 'drifted',
            message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
          }
        default:
          return outcome
      }
    }

    const { lines } = await handle.readFile(path)
    const fullDocText = lines.join('\n')

    // Apply optional line scoping if startLine / endLine provided
    let searchDocText = fullDocText
    let lineOffset = 0
    if (typeof startLine === 'number' && startLine >= 1) {
      const startIdx = startLine - 1
      const endIdx = typeof endLine === 'number' && endLine >= startLine ? endLine : lines.length
      searchDocText = lines.slice(startIdx, endIdx).join('\n')
      lineOffset = startIdx
    }

    const match = locateAnchorInText(searchDocText, oldText)
    const cleanedOld = cleanOldText(oldText)
    let targetAnchor = match ? match.anchor : (countOccurrences(searchDocText, cleanedOld) > 0 ? cleanedOld : oldText)
    let matches = countOccurrences(searchDocText, targetAnchor)

    if (!match && matches === 0) {
      const candidateLines = findMatchingLines(fullDocText, oldText)
      const candidateHint = candidateLines.length > 0
        ? ` (Found similar line around line(s) ${candidateLines.join(', ')}). Use read_file to inspect the file around those lines.`
        : ` If replacing existing text, copy an existing anchor line that already appears in ${path}. If you want to append content to the end of ${path}, call edit_file with oldText: "" and newText with your content.`

      return {
        status: 'noMatch',
        message: `That text did not appear in ${path}.${candidateHint}`,
      }
    }

    if (matches > 1) {
      const candidateLines = findMatchingLines(searchDocText, targetAnchor).map(l => l + lineOffset)
      const lineList = candidateLines.length > 0 ? ` (around line(s) ${candidateLines.join(', ')})` : ''
      return {
        status: 'ambiguous',
        matches,
        message: `That text appears ${matches} times in ${path}${lineList}. Include more surrounding context lines or use startLine/endLine to disambiguate.`,
      }
    }

    const outcome = await handle.proposeEdit({
      path,
      oldText: targetAnchor,
      newText: sanitizedNewText,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    })

    switch (outcome.status) {
      case 'applied':
        return {
          status: 'applied',
          message: `Applied the change to ${path}.`,
          startLine: (outcome as any).startLine,
        }
      case 'rejected': {
        const userNote = outcome.note ? ` with note: "${outcome.note}"` : ''
        return {
          status: 'rejected',
          note: outcome.note,
          message: `The user rejected this change${userNote}. Do not attempt the same change again in this turn. Acknowledge the rejection, address their feedback, and explain an alternative approach or ask how they would like to proceed.`,
        }
      }
      case 'drifted':
        return {
          status: 'drifted',
          message: `${path} changed while the user was reviewing. Re-read it before trying again.`,
        }
      default:
        return outcome
    }
  },
}
```

- [ ] **Step 1: Update `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`**

Add the following test cases to `modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts`:
```ts
  it('matches double-escaped LaTeX macro backslashes', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'doc.tex': '\\begin{equation}\nx = 1\n\\end{equation}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'doc.tex', oldText: '\\\\begin{equation}\nx = 1', newText: '\\begin{equation}\nx = 2' },
      handle
    )

    expect(result.status).to.equal('applied')
    expect(calls.filter(call => call.name === 'proposeEdit')).to.have.length(1)
  })

  it('sanitizes line-number prefixes from newText when contaminated by read_file', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'packages.tex': '\\usepackage{amsmath}\n\\usepackage{amssymb}\n' },
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      {
        path: 'packages.tex',
        oldText: '\\usepackage{amsmath}\n\\usepackage{amssymb}',
        newText: '1: \\usepackage{amsmath}\n2: \\usepackage{amssymb}\n3: \\usepackage{graphicx}',
      },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect((propose?.args as any).newText).to.equal(
      '\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{graphicx}'
    )
  })

  it('reports candidate line numbers on ambiguous matches', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(result.message).to.include('around line(s) 2, 4')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports ambiguous when double-escaped or line-prefixed anchor appears multiple times', async function () {
    const { handle, calls } = createFakeHandle({
      docs: { 'multi.tex': 'line 1\n\\section{Beta}\nline 3\n\\section{Beta}\nline 5\n' },
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'multi.tex', oldText: '\\\\section{Beta}', newText: '\\section{Beta 2}' },
      handle
    )

    expect(result.status).to.equal('ambiguous')
    expect(result.matches).to.equal(2)
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('reports candidate line numbers on noMatch when similar line is found', async function () {
    const { handle, calls } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'gamma\nnonexistent line', newText: 'REPLACED' },
      handle
    )

    expect(result.status).to.equal('noMatch')
    expect(result.message).to.include('Found similar line around line(s) 3')
    expect(calls.some(call => call.name === 'proposeEdit')).to.equal(false)
  })

  it('disambiguates repeated anchor using startLine and endLine', async function () {
    const { handle, calls } = createFakeHandle({
      docs: DOCS,
      onEdit: () => ({ status: 'applied' }),
    })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', oldText: 'beta', newText: 'BETA_SECOND', startLine: 3, endLine: 5 },
      handle
    )

    expect(result.status).to.equal('applied')
    const propose = calls.find(call => call.name === 'proposeEdit')
    expect((propose?.args as any).startLine).to.equal(3)
  })

  it('rejects call when oldText parameter is missing or non-string', async function () {
    const { handle } = createFakeHandle({ docs: DOCS })

    const result: any = await TOOLS.edit_file.execute(
      { path: 'main.tex', newText: 'BETA' } as any,
      handle
    )

    expect(result.error).to.include("Parameter 'oldText' is required")
  })
```

- [ ] **Step 2: Run test suite**
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/edit-tool.test.ts
```

---

### Task 3: Update `read-file.ts` and `fix-source.ts` Tool Specs and Guidance

**Goal:** Update parameter descriptions in `read-file.ts` and documentation in `fix-source.ts` to make it unambiguous that line-number prefixes (`14: `) are display-only and must never be included in `oldText` or `newText`.

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/tools/read-file.ts` (lines 11-23)
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/agent/context/fix-source.ts` (lines 20-35)
- Test: `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`

**Code Modification in `read-file.ts`:**

*Existing Code in `read-file.ts` (lines 11-23):*
```ts
  spec: {
    name: 'read_file',
    description:
      'Read one text file, or a line range of one, as numbered lines. Get the range from get_outline or search_text first rather than guessing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        from: { type: 'number', description: 'First line, 1-indexed' },
        to: { type: 'number', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
```

*Replacement Code in `read-file.ts` (lines 11-25):*
```ts
  spec: {
    name: 'read_file',
    description:
      'Read one text file, or a line range of one, as numbered lines. Line numbers in the output (e.g. "14: ") are for display and reference only; never include line number prefixes in oldText or newText when calling edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        from: { type: 'number', description: 'First line, 1-indexed' },
        to: { type: 'number', description: 'Last line, inclusive' },
      },
      required: ['path'],
    },
  },
```

- [ ] **Step 1: Update `read-tools.test.ts` to verify description update**

In `modules/ai-assist/test/frontend/js/agent/read-tools.test.ts`, add a test verifying that `readFileTool.spec.description` includes the explicit guidance about line numbers being for display and reference only:
```ts
  it('read_file description clarifies line numbers are for display only', function () {
    expect(readFileTool.spec.description).to.include('Line numbers in the output')
    expect(readFileTool.spec.description).to.include('never include line number prefixes in oldText or newText')
  })
```

Run test suite:
```bash
NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/js/agent/read-tools.test.ts
```

---

### Task 4: Fix Backend Spec & Line Sanitization in `AiAssistTools.mjs`

**Goal:** Eliminate contradictory guidance claiming that `oldText: ""` replaces full files in `AiAssistTools.mjs`, sanitize `newText` line prefixes in backend execution (including standard edits, full-file replaces, and appends), mirror `findMatchingLines` substring matching improvements for full frontend/backend parity, and add `startLine` / `endLine` parameters to the backend schema.

**Files:**
- Modify: `modules/ai-assist/app/src/AiAssistTools.mjs` (lines 50-70, 192-207, 487-575, 1209-1240)
- Test: `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`

**Code Modification in `AiAssistTools.mjs`:**

1. In `modules/ai-assist/app/src/AiAssistTools.mjs`, add `cleanLineNumberPrefixes`:
```js
export function cleanLineNumberPrefixes(text, oldTextWasStripped = false) {
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
```

2. In `AiAssistTools.mjs` around lines 192-207, update `findMatchingLines` to mirror `latex-matcher.ts` (using `cleanOldText` and substring matching for diagnostic parity):

*Existing Code (lines 192-205):*
```js
export function findMatchingLines(haystack, needle) {
  if (!needle) return []
  const normH = normalizeLines(haystack)
  const normN = normalizeLines(needle)
  const hLines = normH.split('\n')
  const nFirst = normN.split('\n')[0].trim()
  const results = []

  for (let i = 0; i < hLines.length; i++) {
    if (hLines[i].trim() === nFirst) {
      results.push(i + 1)
    }
  }
  return results.slice(0, 5)
}
```

*Replacement Code in `AiAssistTools.mjs`:*
```js
export function findMatchingLines(haystack, needle) {
  if (!needle || !haystack) return []
  const normH = normalizeLines(haystack)
  const normN = cleanOldText(normalizeLines(needle))
  const hLines = normH.split('\n')
  const nLines = normN.split('\n').map(l => l.trim()).filter(Boolean)
  if (nLines.length === 0) return []

  const targetLine = nLines[0]
  const results = []

  for (let i = 0; i < hLines.length; i++) {
    const trimmedH = hLines[i].trim()
    if (trimmedH === targetLine || (targetLine.length > 5 && trimmedH.includes(targetLine))) {
      results.push(i + 1)
    }
  }
  return results.slice(0, 5)
}
```

3. In `AiAssistTools.mjs` around lines 487-575, compute `sanitizedNewText` before replacement checks, update the whole-file replace and append logic, handle ambiguous cleaned anchors, and use `sanitizedNewText` in standard replacements:

*Existing Code (lines 487-508):*
```js
        // Whole file replacement:
        const hasDocClass = (args.newText || '').includes('\\documentclass')
        const isDocEmpty = !doc || docText.trim().length === 0
        const isFullFileReplace =
          (typeof args.oldText === 'string' && args.oldText.trim().length > 0 && normalizeLines(args.oldText).trim() === normalizeLines(docText).trim()) ||
          ((args.oldText === '' || args.oldText === undefined) && (hasDocClass || isDocEmpty))

        if (isFullFileReplace && doc) {
          const updatedLines = (args.newText || '').split('\n')
          await this.docUpdater.setDocument(projectId, doc._id, userId, updatedLines, 'ai-assist')
          return { status: 'applied', path: doc.path }
        }

        // Append mode: only when oldText is explicitly empty string "" and NOT full-file LaTeX
        if (args.oldText === '' && doc) {
          const appended = docText.endsWith('\n') || docText.length === 0
            ? docText + (args.newText || '')
            : docText + '\n' + (args.newText || '')
          await this.docUpdater.setDocument(projectId, doc._id, userId, appended.split('\n'), 'ai-assist')
          return { status: 'applied', path: doc.path }
        }
```

*Replacement Code in `AiAssistTools.mjs` (lines 487-508):*
```js
        const strippedOld = cleanLineNumbers(args.oldText || '')
        const oldTextWasStripped = strippedOld !== args.oldText && strippedOld.length > 0
        const sanitizedNewText = cleanLineNumberPrefixes(args.newText || '', oldTextWasStripped)

        // Whole file replacement: only when oldText matches the full file or file is empty
        const isDocEmpty = !doc || docText.trim().length === 0
        const isFullFileReplace =
          (typeof args.oldText === 'string' && args.oldText.trim().length > 0 && normalizeLines(args.oldText).trim() === normalizeLines(docText).trim()) ||
          (isDocEmpty && typeof args.oldText === 'string')

        if (isFullFileReplace && doc) {
          const updatedLines = sanitizedNewText.split('\n')
          await this.docUpdater.setDocument(projectId, doc._id, userId, updatedLines, 'ai-assist')
          return { status: 'applied', path: doc.path }
        }

        // Append mode: when oldText is explicitly empty string ""
        if (args.oldText === '' && doc) {
          const appended = docText.endsWith('\n') || docText.length === 0
            ? docText + sanitizedNewText
            : docText + '\n' + sanitizedNewText
          await this.docUpdater.setDocument(projectId, doc._id, userId, appended.split('\n'), 'ai-assist')
          return { status: 'applied', path: doc.path }
        }
```

*Also in `AiAssistTools.mjs` lines 548-575, ensure `sanitizedNewText` is used in standard edits and ambiguous checks detect cleaned anchors:*

*Existing Code (lines 548-571):*
```js
        if (!targetMatch || !resolvedDoc) {
          if (resolvedDocText) {
            const matches = countOccurrences(resolvedDocText, targetAnchor)
            if (matches > 1) {
              const occurrences = findMatchingLines(resolvedDocText, targetAnchor)
              return {
                error: `That text appears ${matches} times in ${resolvedDoc.path} (around line(s) ${occurrences.join(', ')}). Include more surrounding context lines so the anchor is unique.`,
              }
            }
          }
          return {
            error: `Could not find target text in ${args.path} or any other project file. If replacing text, copy an existing anchor line that appears in the file.`,
          }
        }

        // Perform replacement
        let replaced
        if (targetMatch.charStart !== undefined && targetMatch.charEnd !== undefined) {
          replaced = resolvedDocText.slice(0, targetMatch.charStart) + (args.newText || '') + resolvedDocText.slice(targetMatch.charEnd)
        } else {
          const matchedAnchor = targetMatch.anchor
          const normDoc = normalizeLines(resolvedDocText)
          const normAnchor = normalizeLines(matchedAnchor)
          if (normDoc.includes(normAnchor)) {
            replaced = normDoc.replace(normAnchor, args.newText || '')
          } else {
            replaced = resolvedDocText.replace(matchedAnchor, args.newText || '')
          }
        }
```

*Replacement Code in `AiAssistTools.mjs` (lines 548-571):*
```js
        if (!targetMatch || !resolvedDoc) {
          if (resolvedDocText) {
            const cleanedOld = cleanOldText(targetAnchor)
            const checkAnchor = countOccurrences(resolvedDocText, cleanedOld) > 0 ? cleanedOld : targetAnchor
            const matches = countOccurrences(resolvedDocText, checkAnchor)
            if (matches > 1) {
              const occurrences = findMatchingLines(resolvedDocText, checkAnchor)
              return {
                error: `That text appears ${matches} times in ${resolvedDoc.path} (around line(s) ${occurrences.join(', ')}). Include more surrounding context lines so the anchor is unique.`,
              }
            }
          }
          return {
            error: `Could not find target text in ${args.path} or any other project file. If replacing text, copy an existing anchor line that appears in the file.`,
          }
        }

        // Perform replacement
        let replaced
        if (targetMatch.charStart !== undefined && targetMatch.charEnd !== undefined) {
          replaced = resolvedDocText.slice(0, targetMatch.charStart) + sanitizedNewText + resolvedDocText.slice(targetMatch.charEnd)
        } else {
          const matchedAnchor = targetMatch.anchor
          const normDoc = normalizeLines(resolvedDocText)
          const normAnchor = normalizeLines(matchedAnchor)
          if (normDoc.includes(normAnchor)) {
            replaced = normDoc.replace(normAnchor, sanitizedNewText)
          } else {
            replaced = resolvedDocText.replace(matchedAnchor, sanitizedNewText)
          }
        }
```

4. In `AiAssistTools.mjs` around lines 1209-1228, fix the schema description and properties:

*Existing Code (lines 1209-1226):*
```js
      {
        name: 'edit_file',
        description: 'Edit a project file. Replace oldText with newText. If replacing the entire file, you can pass oldText matching the whole file or empty string "".',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file' },
            oldText: {
              type: 'string',
              description: 'The exact text to replace. Pass an empty string "" if replacing the entire file or appending content.',
            },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
```

*Replacement Code in `AiAssistTools.mjs`:*
```js
      {
        name: 'edit_file',
        description:
          'Edit a project file. Replace oldText with newText. Pass oldText: "" to append newText to the end of the file. Pass newText: "" to delete oldText.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to file' },
            oldText: {
              type: 'string',
              description:
                'The exact text to replace. Pass an empty string "" to append content to the end of the file. Pass full file content if replacing the whole file.',
            },
            newText: {
              type: 'string',
              description:
                'Replacement text (or text to append if oldText is empty). Pass an empty string "" to delete oldText.',
            },
            startLine: {
              type: 'number',
              description: 'Optional 1-based start line to constrain search range for ambiguous anchors.',
            },
            endLine: {
              type: 'number',
              description: 'Optional 1-based end line to constrain search range for ambiguous anchors.',
            },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
```

- [ ] **Step 1: Write backend tests in `modules/ai-assist/test/unit/src/AiAssistTools.test.mjs`**

Add test cases verifying `cleanLineNumberPrefixes` and the corrected tool schema:
```js
  it('sanitizes line-number prefixes from newText in edit_file', async function () {
    const result = await tools.executeTool(
      'proj-1',
      'user-1',
      'edit_file',
      {
        path: 'main.tex',
        oldText: 'line 2: target text',
        newText: '2: line 2: replaced text',
      }
    )
    expect(result.status).to.equal('applied')
    expect(mockDocUpdater.setDocument.calledOnce).to.be.true
    const lines = mockDocUpdater.setDocument.firstCall.args[3]
    expect(lines).to.deep.equal(['line 1', 'line 2: replaced text', 'line 3'])
  })

  it('edit_file schema describes oldText: "" strictly for appending, not replacing', function () {
    const specs = tools.getToolSpecs()
    const editSpec = specs.find(s => s.name === 'edit_file')
    expect(editSpec.description).to.not.include('empty string "" if replacing the entire file')
    expect(editSpec.parameters.properties.oldText.description).to.include('append')
    expect(editSpec.parameters.properties).to.have.property('startLine')
    expect(editSpec.parameters.properties).to.have.property('endLine')
  })
```

- [ ] **Step 2: Run backend test suite**
```bash
NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
```

---

## Out of Scope

- **Editor Bridge switching & path-based routing:** Covered in Workstream 1.
- **Character-offset and sub-line delta application in CodeMirror:** Covered in Workstream 2.
- **Compiler feedback loop synchronization and log error delta tracking:** Covered in Workstream 4.
- **Search glob pre-filtering and package option retention:** Covered in Workstream 5.

---

## Verification & Baselines

Run both test suites to confirm full green verification with zero regressions:

1. **Frontend Mocha Test Suite:**
   ```bash
   NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha \
     --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx \
     --require test/frontend/bootstrap.js \
     modules/ai-assist/test/frontend
   ```
   *Expected Outcome:* **>= 774 passing, 0 failing**.

2. **Backend Vitest Test Suite:**
   ```bash
   NODE_ENV=test ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src
   ```
   *Expected Outcome:* **10 test files, >= 107 passing, 0 failing**.
