// In-memory stand-in for a MongoDB collection in the dedup tests. It implements the
// query and update operators the storage code uses, with Mongo's null semantics
// (a null match also matches a missing field) and nothing more.
import { randomUUID } from 'node:crypto'

const clone = value => (value === undefined ? undefined : structuredClone(value))

function getPath(doc, dotted) {
  let value = doc
  for (const key of dotted.split('.')) {
    if (value == null || typeof value !== 'object') return undefined
    value = value[key]
  }
  return value
}

function setPath(doc, dotted, value) {
  const keys = dotted.split('.')
  let target = doc
  for (const key of keys.slice(0, -1)) {
    if (target[key] == null || typeof target[key] !== 'object') target[key] = {}
    target = target[key]
  }
  target[keys[keys.length - 1]] = value
}

function unsetPath(doc, dotted) {
  const keys = dotted.split('.')
  let target = doc
  for (const key of keys.slice(0, -1)) {
    if (target == null || typeof target !== 'object') return
    target = target[key]
  }
  if (target && typeof target === 'object') delete target[keys[keys.length - 1]]
}

const same = (a, b) => {
  if (a === null || a === undefined) return b === null || b === undefined
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return a === b
}

function compare(a, b) {
  const va = a instanceof Date ? a.getTime() : a
  const vb = b instanceof Date ? b.getTime() : b
  return va < vb ? -1 : va > vb ? 1 : 0
}

function typeOk(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'date') return value instanceof Date
  if (type === 'number') return typeof value === 'number'
  throw new Error(`FakeCollection: unsupported $type ${type}`)
}

function isOperatorObject(cond) {
  return (
    cond !== null &&
    typeof cond === 'object' &&
    !(cond instanceof Date) &&
    !Array.isArray(cond) &&
    Object.keys(cond).length > 0 &&
    Object.keys(cond).every(key => key.startsWith('$'))
  )
}

function matchValue(actual, cond) {
  if (!isOperatorObject(cond)) return same(actual, cond)
  for (const [op, arg] of Object.entries(cond)) {
    if (op === '$ne' && same(actual, arg)) return false
    if (op === '$in' && !arg.some(candidate => same(actual, candidate))) return false
    if (op === '$nin' && arg.some(candidate => same(actual, candidate))) return false
    if (op === '$gt' && !(actual != null && compare(actual, arg) > 0)) return false
    if (op === '$lt' && !(actual != null && compare(actual, arg) < 0)) return false
    if (op === '$exists' && (actual !== undefined) !== arg) return false
    if (op === '$type' && !typeOk(actual, arg)) return false
    if (op === '$not' && matchValue(actual, arg)) return false
    if (!['$ne', '$in', '$nin', '$gt', '$lt', '$exists', '$type', '$not'].includes(op)) {
      throw new Error(`FakeCollection: unsupported operator ${op}`)
    }
  }
  return true
}

export function matchDoc(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some(sub => matchDoc(doc, sub))) return false
    } else if (key === '$and') {
      if (!cond.every(sub => matchDoc(doc, sub))) return false
    } else if (!matchValue(getPath(doc, key), cond)) {
      return false
    }
  }
  return true
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set') {
      for (const [path, value] of Object.entries(fields)) setPath(doc, path, clone(value))
    } else if (op === '$unset') {
      for (const path of Object.keys(fields)) unsetPath(doc, path)
    } else if (op === '$addToSet') {
      for (const [path, value] of Object.entries(fields)) {
        const list = Array.isArray(getPath(doc, path)) ? getPath(doc, path) : []
        const items = value && value.$each ? value.$each : [value]
        for (const item of items) {
          if (!list.some(existing => same(existing, item))) list.push(clone(item))
        }
        setPath(doc, path, list)
      }
    } else if (op === '$pull') {
      for (const [path, value] of Object.entries(fields)) {
        const list = getPath(doc, path)
        if (Array.isArray(list)) setPath(doc, path, list.filter(item => !same(item, value)))
      }
    } else {
      throw new Error(`FakeCollection: unsupported update ${op}`)
    }
  }
}

function sortDocs(docs, spec) {
  const entries = Object.entries(spec)
  return docs.sort((a, b) => {
    for (const [path, dir] of entries) {
      const c = compare(getPath(a, path) ?? null, getPath(b, path) ?? null)
      if (c !== 0) return c * dir
    }
    return 0
  })
}

class Cursor {
  constructor(docs) {
    this.docs = docs
  }

  sort(spec) {
    this.docs = sortDocs(this.docs, spec)
    return this
  }

  limit(n) {
    this.docs = this.docs.slice(0, n)
    return this
  }

  async toArray() {
    return this.docs.map(clone)
  }

  async *[Symbol.asyncIterator]() {
    for (const doc of this.docs) yield clone(doc)
  }
}

export class FakeCollection {
  constructor(docs = []) {
    this.docs = docs.map(clone)
    this.calls = { updateOne: [] }
  }

  find(filter = {}) {
    return new Cursor(this.docs.filter(doc => matchDoc(doc, filter)).map(clone))
  }

  async findOne(filter = {}, opts = {}) {
    let matches = this.docs.filter(doc => matchDoc(doc, filter)).map(clone)
    if (opts.sort) matches = sortDocs(matches, opts.sort)
    return matches[0] ?? null
  }

  async insertOne(doc) {
    this.docs.push(clone(doc))
    return { acknowledged: true, insertedId: doc._id }
  }

  async countDocuments(filter = {}) {
    return this.docs.filter(doc => matchDoc(doc, filter)).length
  }

  async updateOne(filter, update, opts = {}) {
    this.calls.updateOne.push({ filter, update })
    const doc = this.docs.find(candidate => matchDoc(candidate, filter))
    if (doc) {
      applyUpdate(doc, update)
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }
    }
    if (opts.upsert) {
      const created = {}
      for (const [key, cond] of Object.entries(filter)) {
        if (!key.startsWith('$') && !isOperatorObject(cond)) setPath(created, key, cond)
      }
      if (created._id === undefined) created._id = randomUUID()
      applyUpdate(created, update)
      this.docs.push(created)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
  }

  // Test helper: the stored doc by id or token, without cloning
  peek(predicate) {
    return this.docs.find(predicate) ?? null
  }
}

export default FakeCollection
