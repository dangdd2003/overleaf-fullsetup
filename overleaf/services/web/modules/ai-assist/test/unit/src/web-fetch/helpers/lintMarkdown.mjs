/**
 * Structural problems in Markdown, for tests: a fence left open, or a table
 * row whose cell count differs from the row above it.
 */
export function lintMarkdown(text) {
  const problems = []
  let fence = null
  let width = null
  for (const [index, line] of text.split('\n').entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = null
      }
      continue
    }
    if (marker) {
      fence = marker[1]
      width = null
      continue
    }
    if (line.startsWith('|')) {
      const cells = line.replace(/\\\|/g, '').split('|').length - 2
      if (width === null) width = cells
      else if (cells !== width) {
        problems.push(`line ${index + 1}: ${cells} cells, expected ${width}`)
      }
    } else {
      width = null
    }
  }
  if (fence) problems.push('unclosed fence')
  return problems
}
