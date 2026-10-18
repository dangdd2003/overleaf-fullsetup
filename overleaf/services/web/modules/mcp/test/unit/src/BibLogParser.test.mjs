import { describe, it, expect } from 'vitest'
import {
  parseBibLog,
  default as defaultParse,
} from '../../../app/src/BibLogParser.mjs'

describe('parseBibLog', () => {
  it('returns null for text that is neither BibTeX nor Biber', () => {
    expect(parseBibLog('')).toBeNull()
    expect(parseBibLog('nothing to see here')).toBeNull()
    expect(parseBibLog(undefined)).toBeNull()
  })

  it('exports the same function as the default export', () => {
    expect(defaultParse).toBe(parseBibLog)
  })

  it('reads BibTeX warnings and errors with file and line', () => {
    const log = [
      'This is BibTeX, Version 0.99d',
      'Warning--empty title in refs:1',
      '--line 4 of file refs.bib',
      'Warning--I didn\'t find a database entry for "x"',
      '---line 9 of file refs.bib',
      'bad field',
      "I'm skipping whatever remains of this entry",
      'I couldn\'t open database file missing.bib',
    ].join('\n')
    const result = parseBibLog(log)
    expect(result.dialect).toBe('bibtex')
    expect(result.warnings).toEqual([
      {
        level: 'warning',
        file: 'refs.bib',
        line: 4,
        message: 'empty title in refs:1',
      },
      {
        level: 'warning',
        file: null,
        line: null,
        message: 'I didn\'t find a database entry for "x"',
      },
    ])
    expect(result.errors).toEqual([
      {
        level: 'error',
        file: 'refs.bib',
        line: 9,
        message: 'bad field',
      },
      {
        level: 'error',
        file: null,
        line: null,
        message: "I couldn't open database file missing.bib",
      },
    ])
  })

  it('reads Biber lines and subsystem locations', () => {
    const log = [
      'INFO - This is Biber 2.20',
      '[1] Biber.pl > INFO - Reading refs.bib',
      '[2] Biber.pl > WARN - Name "x" has no surname',
      '[3] Biber.pl > ERROR - BibTeX subsystem: /tmp/abc/refs.bib_123.utf8, line 8, syntax error',
    ].join('\n')
    expect(parseBibLog(log)).toEqual({
      dialect: 'biber',
      errors: [
        {
          level: 'error',
          file: 'refs.bib',
          line: 8,
          message: 'syntax error',
        },
      ],
      warnings: [
        {
          level: 'warning',
          file: null,
          line: null,
          message: 'Name "x" has no surname',
        },
      ],
    })
  })

  it('keeps every entry of a large log, in order', () => {
    const count = 3000
    const blocks = ['This is BibTeX, Version 0.99d']
    const expected = { errors: [], warnings: [] }
    for (let i = 0; i < count; i++) {
      blocks.push(`Warning--warn ${i}\n--line ${i + 1} of file r.bib`)
      expected.warnings.push({
        level: 'warning',
        file: 'r.bib',
        line: i + 1,
        message: `warn ${i}`,
      })
      blocks.push(
        `e${i}---line ${i + 2} of file a.bib\nbody ${i}\nI'm skipping whatever remains of this entry`
      )
      expected.errors.push({
        level: 'error',
        file: 'a.bib',
        line: i + 2,
        message: `e${i}\nbody ${i}`,
      })
    }
    const result = parseBibLog(blocks.join('\n'))
    expect(result.errors).toHaveLength(count)
    expect(result.warnings).toHaveLength(count)
    expect(result.errors).toEqual(expected.errors)
    expect(result.warnings).toEqual(expected.warnings)
  })

  it('handles CRLF line endings', () => {
    const result = parseBibLog(
      'This is BibTeX, Version 0.99d\r\nWarning--one\r\nWarning--two\r\n'
    )
    expect(result.warnings.map(w => w.message)).toEqual(['one', 'two'])
  })
})
