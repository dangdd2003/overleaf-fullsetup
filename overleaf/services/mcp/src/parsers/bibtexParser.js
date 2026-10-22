import { lineLookup, readBraceGroup } from './textEdit.js'

const IGNORED_TYPES = new Set(['comment', 'preamble', 'string'])
const FIELD_NAME = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/g
const BARE_VALUE = /[^,\n]*/y

/**
 * Parse the body of one entry into its fields.
 *
 * @param {string} body text between the entry's outer braces, after the key
 * @returns {Record<string, string>}
 */
function parseFields(body) {
  const fields = {}
  let i = 0

  while (i < body.length) {
    // Searched from i in place; slicing the body for each field copies it again.
    FIELD_NAME.lastIndex = i
    const nameMatch = FIELD_NAME.exec(body)
    if (!nameMatch) break
    const name = nameMatch[1].toLowerCase()
    i = nameMatch.index + nameMatch[0].length

    let value
    if (body[i] === '{') {
      const group = readBraceGroup(body, i)
      if (!group) break
      value = group.content
      i = group.endIndex + 1
    } else if (body[i] === '"') {
      let close = -1
      for (let j = i + 1; j < body.length; j++) {
        if (body[j] === '\\') {
          j++
          continue
        }
        if (body[j] === '"') {
          close = j
          break
        }
      }
      if (close === -1) break
      value = body.slice(i + 1, close)
      i = close + 1
    } else {
      BARE_VALUE.lastIndex = i
      value = BARE_VALUE.exec(body)[0]
      i += value.length
    }

    fields[name] = value.trim()
    const comma = body.indexOf(',', i)
    if (comma === -1) break
    i = comma + 1
  }

  return fields
}

/**
 * Parse a .bib file into structured entries.
 *
 * @param {string} text
 * @returns {{ type: string, key: string, fields: Record<string, string>, line: number }[]}
 */
export function parseBibtex(text) {
  const source = String(text ?? '')
  const lineOf = lineLookup(source)
  const entries = []

  for (const match of source.matchAll(/@([A-Za-z]+)\s*\{/g)) {
    const type = match[1].toLowerCase()
    const openIndex = match.index + match[0].length - 1
    const group = readBraceGroup(source, openIndex)
    if (!group) continue
    if (IGNORED_TYPES.has(type)) continue

    const comma = group.content.indexOf(',')
    const key = (comma === -1 ? group.content : group.content.slice(0, comma)).trim()
    if (!key) continue

    entries.push({
      type,
      key,
      fields: comma === -1 ? {} : parseFields(group.content.slice(comma + 1)),
      line: lineOf(match.index),
    })
  }

  return entries
}

/**
 * Filter entries by a case-insensitive substring of the key or any field value.
 *
 * @param {ReturnType<typeof parseBibtex>} entries
 * @param {string} query
 */
export function searchBibtex(entries, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return entries
  return entries.filter(entry => {
    if (entry.key.toLowerCase().includes(needle)) return true
    return Object.values(entry.fields).some(value =>
      value.toLowerCase().includes(needle)
    )
  })
}
