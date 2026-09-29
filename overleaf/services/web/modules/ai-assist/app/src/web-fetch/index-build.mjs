import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { eachBlock, searchText } from './blocks.mjs'
import { pageMap } from './pages.mjs'

/**
 * Builds the search index of a long document: one SQLite file with the
 * document's blocks (offsets, kind, the headings above them) and an FTS5
 * index of their normalized text. Runs in an extraction worker, once per
 * document, so the web process never scans a large text on its event loop.
 * The file is private to this process and thrown away with the index, so it
 * skips the journal.
 */

const SCHEMA = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  start INTEGER NOT NULL,
  stop INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts USING fts5(
  body, section,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
`

/** Block rows are numbered from 1, in document order: row id = block index + 1. */
export function buildIndexFile(text, file, size) {
  fs.rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(SCHEMA)
    const insertBlock = db.prepare(
      'INSERT INTO blocks (id, start, stop, kind, level, path) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertText = db.prepare(
      'INSERT INTO fts (rowid, body, section) VALUES (?, ?, ?)'
    )
    // Blocks of one section share their path
    let lastPath = null
    let lastJson = '[]'
    let lastSection = ''
    db.exec('BEGIN')
    const count = eachBlock(text, block => {
      const key = block.path.join('\n')
      if (key !== lastPath) {
        lastPath = key
        lastJson = JSON.stringify(block.path)
        lastSection = searchText(block.path.join(' '))
      }
      const id = block.index + 1
      insertBlock.run(
        id,
        block.start,
        block.end,
        block.kind,
        block.level,
        lastJson
      )
      insertText.run(
        id,
        searchText(text.slice(block.start, block.end)),
        lastSection
      )
    })
    db.exec('COMMIT')
    db.exec("INSERT INTO fts (fts) VALUES ('optimize')")
    return { count, map: pageMap(text, size) }
  } finally {
    db.close()
  }
}
