// In-memory stand-in for the Mongo collection calls the template gallery makes,
// shared by the P4 (crawl & fetch) tests. Supports the operators those code
// paths use; anything else throws so a test never passes on a silent no-op.
// Not a test file: vitest only runs *.test.mjs.

import { randomUUID } from 'node:crypto'

/**
 * Resolves to the rejection reason. The unit bootstrap installs chai-as-promised,
 * which takes over `expect(promise).rejects`, so tests await through this instead.
 */
export async function rejectionOf(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the promise to reject, but it resolved')
}

export function getPath(doc, path) {
  let cur = doc
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(doc, path, value) {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object')
      cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function unsetPath(doc, path) {
  const parts = path.split('.')
  let cur = doc
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return
    cur = cur[parts[i]]
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]]
}

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a == null && b == null) return true
  return a === b
}

function isOperatorObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.keys(value).some(key => key.startsWith('$'))
  )
}

function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'date') return value instanceof Date
  if (type === 'number') return typeof value === 'number'
  throw new Error(`fake mongo: unsupported $type ${type}`)
}

function matchCondition(actual, cond) {
  if (!isOperatorObject(cond)) return sameValue(actual, cond)
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$eq':
        if (!sameValue(actual, arg)) return false
        break
      case '$ne':
        if (sameValue(actual, arg)) return false
        break
      case '$in':
        if (!arg.some(value => sameValue(actual, value))) return false
        break
      case '$nin':
        if (arg.some(value => sameValue(actual, value))) return false
        break
      case '$exists':
        if ((actual !== undefined) !== Boolean(arg)) return false
        break
      case '$type':
        if (!typeMatches(actual, arg)) return false
        break
      case '$not':
        if (matchCondition(actual, arg)) return false
        break
      case '$gt':
        if (!(actual > arg)) return false
        break
      case '$lt':
        if (!(actual < arg)) return false
        break
      case '$regex':
        if (typeof actual !== 'string' || !new RegExp(arg).test(actual))
          return false
        break
      default:
        throw new Error(`fake mongo: unsupported filter operator ${op}`)
    }
  }
  return true
}

export function matchesFilter(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some(sub => matchesFilter(doc, sub))) return false
      continue
    }
    if (!matchCondition(getPath(doc, key), cond)) return false
  }
  return true
}

function applyUpdate(doc, update, isInsert) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields)) {
      if (op === '$set') setPath(doc, path, structuredClone(value))
      else if (op === '$setOnInsert') {
        if (isInsert) setPath(doc, path, structuredClone(value))
      } else if (op === '$unset') unsetPath(doc, path)
      else if (op === '$inc')
        setPath(doc, path, (getPath(doc, path) || 0) + value)
      else if (op === '$max') {
        const current = getPath(doc, path)
        setPath(doc, path, current == null ? value : Math.max(current, value))
      } else throw new Error(`fake mongo: unsupported update operator ${op}`)
    }
  }
}

function sortRows(rows, spec) {
  if (!spec) return rows
  const [[key, dir]] = Object.entries(spec)
  return [...rows].sort((a, b) => {
    const va = getPath(a, key)
    const vb = getPath(b, key)
    if (va === vb) return 0
    if (va === undefined) return -dir
    if (vb === undefined) return dir
    return (va > vb ? 1 : -1) * dir
  })
}

function equalityFields(filter) {
  const doc = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$') || isOperatorObject(value)) continue
    setPath(doc, key, value)
  }
  return doc
}

/**
 * Creates a collection-like object. `docs` is exposed for assertions.
 * A unique index on `token` is enforced, as the real partial unique index is.
 */
export function createFakeCollection(initialDocs = []) {
  const docs = initialDocs.map(doc => structuredClone(doc))

  function insertFrom(filter, update) {
    const doc = equalityFields(filter)
    applyUpdate(doc, update, true)
    if (doc._id === undefined) doc._id = randomUUID()
    if (
      typeof doc.token === 'string' &&
      docs.some(row => row.token === doc.token)
    ) {
      const err = new Error(`E11000 duplicate key error token: ${doc.token}`)
      err.code = 11000
      throw err
    }
    docs.push(doc)
    return doc._id
  }

  function matching(filter) {
    return docs.filter(doc => matchesFilter(doc, filter))
  }

  function cursorOver(rows) {
    let sortSpec = null
    let skipN = 0
    let limitN = Infinity
    const cursor = {
      sort(spec) {
        sortSpec = spec
        return cursor
      },
      skip(n) {
        skipN = n
        return cursor
      },
      limit(n) {
        limitN = n
        return cursor
      },
      async toArray() {
        return sortRows(rows, sortSpec)
          .slice(skipN, skipN + limitN)
          .map(row => structuredClone(row))
      },
      async *[Symbol.asyncIterator]() {
        for (const row of await cursor.toArray()) yield row
      },
    }
    return cursor
  }

  return {
    docs,
    find(filter = {}) {
      return cursorOver(matching(filter))
    },
    async findOne(filter = {}, options = {}) {
      const [row] = sortRows(matching(filter), options.sort)
      return row ? structuredClone(row) : null
    },
    async countDocuments(filter = {}) {
      return matching(filter).length
    },
    async estimatedDocumentCount() {
      return docs.length
    },
    async updateOne(filter, update, options = {}) {
      const [target] = matching(filter)
      if (target) {
        applyUpdate(target, update, false)
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
      }
      if (options.upsert) {
        insertFrom(filter, update)
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
    },
    async updateMany(filter, update) {
      const rows = matching(filter)
      for (const row of rows) applyUpdate(row, update, false)
      return { matchedCount: rows.length, modifiedCount: rows.length }
    },
    /**
     * Unordered like the driver: every operation is attempted, and failed
     * inserts are reported as a MongoBulkWriteError carrying the partial result.
     */
    async bulkWrite(ops) {
      const result = { matchedCount: 0, upsertedCount: 0, modifiedCount: 0 }
      const writeErrors = []
      ops.forEach((op, index) => {
        if (!op.updateOne)
          throw new Error(
            'fake mongo: only updateOne is supported in bulkWrite'
          )
        const { filter, update, upsert } = op.updateOne
        const [target] = matching(filter)
        if (target) {
          applyUpdate(target, update, false)
          result.matchedCount++
          result.modifiedCount++
          return
        }
        if (!upsert) return
        try {
          insertFrom(filter, update)
          result.upsertedCount++
        } catch (err) {
          writeErrors.push({ index, code: err.code, errmsg: err.message })
        }
      })
      if (writeErrors.length > 0) {
        const err = new Error('bulk write exception')
        err.name = 'MongoBulkWriteError'
        err.code = 11000
        err.writeErrors = writeErrors
        err.result = result
        throw err
      }
      return result
    },
  }
}
