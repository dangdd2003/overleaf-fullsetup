class ObjectId {
  constructor(id) {
    this.id = id || 'mock_object_id'
  }
  toString() {
    return this.id.toString()
  }
  static isValid(id) {
    return Boolean(id)
  }
}

class Collection {
  constructor(name) {
    this.name = name
  }
  findOne(query, options) {
    return Promise.resolve(null)
  }
  find(query, options) {
    return {
      toArray: () => Promise.resolve([]),
      sort: () => ({
        toArray: () => Promise.resolve([]),
        [Symbol.asyncIterator]: () => (async function* () {})(),
      }),
      [Symbol.asyncIterator]: () => (async function* () {})(),
    }
  }
  updateOne() {
    return Promise.resolve({ acknowledged: true, modifiedCount: 1 })
  }
  deleteOne() {
    return Promise.resolve({ acknowledged: true, deletedCount: 1 })
  }
}

class Db {
  collection(name) {
    return new Collection(name)
  }
  collections() {
    return Promise.resolve([])
  }
}

class MongoClient {
  connect() {
    return Promise.resolve()
  }
  close() {
    return Promise.resolve()
  }
  db() {
    return new Db()
  }
}

const ReadPreference = {
  primary: { mode: 'primary' },
  secondary: { mode: 'secondary' },
  secondaryPreferred: { mode: 'secondaryPreferred' },
}

const mongodb = {
  ObjectId,
  MongoClient,
  ReadPreference,
}

export { ObjectId, MongoClient, ReadPreference }
export default mongodb
