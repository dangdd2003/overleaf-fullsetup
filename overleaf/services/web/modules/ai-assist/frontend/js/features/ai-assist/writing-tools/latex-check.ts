import { KEYED_COMMAND_PATTERN, MATH_PATTERN } from './latex-patterns'

export type LatexWarning = {
  kind: 'droppedKey' | 'addedKey' | 'math' | 'environment' | 'braces'
  message: string
}

/** \citep and \citet of one key are the same citation; so are \ref and \cref. */
function family(command: string): string {
  if (/cite/i.test(command)) return 'cite'
  if (command === 'label') return 'label'
  return 'ref'
}

function keyCounts(text: string) {
  const counts = new Map<string, { count: number; display: string }>()
  for (const match of text.matchAll(KEYED_COMMAND_PATTERN)) {
    const command = match[1]
    for (const key of match[3].split(',').map(k => k.trim())) {
      if (!key) continue
      const id = `${family(command)}:${key}`
      const entry = counts.get(id) ?? {
        count: 0,
        display: `\\${command}{${key}}`,
      }
      entry.count++
      counts.set(id, entry)
    }
  }
  return counts
}

/** Whitespace next to symbols does not change math; between letters it can. */
function normalizeMath(math: string, translate: boolean): string {
  let text = math.replace(/\s+/g, ' ').trim()
  text = text.replace(/ ?([^a-zA-Z\\ ]) ?/g, '$1')
  if (translate) text = text.replace(/\\text\{[^}]*\}/g, '\\text{}')
  return text
}

function countBy(items: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

export function braceBalance(text: string): number {
  let balance = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') {
      i++
    } else if (char === '{') {
      balance++
    } else if (char === '}') {
      balance--
    }
  }
  return balance
}

/**
 * What the result broke that the original had. Each finding is a warning for
 * the author; none of them blocks Replace.
 */
export function checkLatex(
  original: string,
  result: string,
  { translate = false }: { translate?: boolean } = {}
): LatexWarning[] {
  const warnings: LatexWarning[] = []

  const before = keyCounts(original)
  const after = keyCounts(result)
  for (const [id, entry] of before) {
    if ((after.get(id)?.count ?? 0) < entry.count) {
      warnings.push({
        kind: 'droppedKey',
        message: `${entry.display} was dropped`,
      })
    }
  }
  for (const [id, entry] of after) {
    if ((before.get(id)?.count ?? 0) < entry.count) {
      warnings.push({ kind: 'addedKey', message: `${entry.display} was added` })
    }
  }

  const mathBefore = countBy(
    [...original.matchAll(MATH_PATTERN)].map(m => normalizeMath(m[0], translate))
  )
  const mathAfter = countBy(
    [...result.matchAll(MATH_PATTERN)].map(m => normalizeMath(m[0], translate))
  )
  // One edited expression is one missing and one new: count it once
  let missingMath = 0
  let newMath = 0
  for (const [math, count] of mathBefore) {
    missingMath += Math.max(0, count - (mathAfter.get(math) ?? 0))
  }
  for (const [math, count] of mathAfter) {
    newMath += Math.max(0, count - (mathBefore.get(math) ?? 0))
  }
  const changedMath = Math.max(missingMath, newMath)
  if (changedMath > 0) {
    warnings.push({
      kind: 'math',
      message:
        changedMath === 1
          ? 'A math expression was changed'
          : `${changedMath} math expressions were changed`,
    })
  }

  const environments = (text: string) =>
    countBy([...text.matchAll(/\\(begin|end)\{([^}]+)\}/g)].map(m => `${m[1]}:${m[2]}`))
  const envBefore = environments(original)
  const envAfter = environments(result)
  const names = new Set(
    [...envBefore.keys(), ...envAfter.keys()].map(key => key.split(':')[1])
  )
  for (const name of names) {
    if (
      (envBefore.get(`begin:${name}`) ?? 0) !==
        (envAfter.get(`begin:${name}`) ?? 0) ||
      (envBefore.get(`end:${name}`) ?? 0) !== (envAfter.get(`end:${name}`) ?? 0)
    ) {
      warnings.push({
        kind: 'environment',
        message: `\\begin{${name}} / \\end{${name}} was changed`,
      })
    }
  }

  if (braceBalance(original) !== braceBalance(result)) {
    warnings.push({ kind: 'braces', message: 'Braces { } no longer balance' })
  }

  return warnings
}
