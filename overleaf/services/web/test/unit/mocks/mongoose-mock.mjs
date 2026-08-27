import { ObjectId } from './mongodb-legacy-mock.mjs'

class Schema {
  constructor(definition, options = {}) {
    this.definition = definition
    this.options = options
    this.methods = {}
    this.statics = {}
  }
  pre() {
    return this
  }
  post() {
    return this
  }
  index() {
    return this
  }
  virtual() {
    return {
      get: () => this,
      set: () => this,
    }
  }
  plugin() {
    return this
  }
  set() {
    return this
  }
  add(obj) {
    if (this.definition && obj) {
      Object.assign(this.definition, obj)
    }
    return this
  }
  method(name, fn) {
    if (typeof name === 'object') {
      Object.assign(this.methods, name)
    } else {
      this.methods[name] = fn
    }
    return this
  }
  static(name, fn) {
    if (typeof name === 'object') {
      Object.assign(this.statics, name)
    } else {
      this.statics[name] = fn
    }
    return this
  }
  path() {
    return {
      validate: () => this,
      get: () => this,
      set: () => this,
    }
  }
}
Schema.ObjectId = ObjectId
Schema.Types = {
  ObjectId,
  Mixed: 'Mixed',
  Union: 'Union',
  String: String,
  Date: Date,
  Number: Number,
  Boolean: Boolean,
}

class Model {
  constructor(data) {
    Object.assign(this, data)
  }
  static create(doc) {
    return Promise.resolve(new Model(doc))
  }
  static findOne(query) {
    return Promise.resolve(null)
  }
  static find(query, projection) {
    return {
      sort: () => ({
        exec: () => Promise.resolve([]),
      }),
    }
  }
  static updateOne(query, update) {
    return Promise.resolve({ acknowledged: true, modifiedCount: 1 })
  }
  static deleteOne(query) {
    return Promise.resolve({ acknowledged: true, deletedCount: 1 })
  }
  save() {
    return Promise.resolve(this)
  }
}

const models = {}

function model(name, schema) {
  if (!models[name]) {
    models[name] = class extends Model {
      static modelName = name
      static schema = schema
    }
  }
  return models[name]
}

const Types = {
  ObjectId,
}

const mongoose = {
  Schema,
  Types,
  ObjectId,
  mongo: {
    ObjectId,
  },
  model,
  set: () => {},
  connect: () => Promise.resolve(),
  disconnect: () => Promise.resolve(),
  connection: {
    client: {},
    on: () => {},
  },
  plugin: () => {},
  Promise: global.Promise,
}

export { Schema, Types, ObjectId, model }
export default mongoose
