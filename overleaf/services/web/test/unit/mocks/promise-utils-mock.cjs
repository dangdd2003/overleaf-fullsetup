const { promisify, callbackify } = require('node:util')

module.exports = {
  promisify,
  promisifyAll: o => o,
  promisifyClass: c => c,
  promisifyMultiResult: fn => fn,
  callbackify,
  callbackifyAll: o => o,
  callbackifyClass: c => c,
  callbackifyMultiResult: fn => fn,
  expressify: fn => fn,
  expressifyErrorHandler: fn => fn,
  promiseMapWithLimit: (limit, items, fn) => Promise.all(items.map(fn)),
  promiseMapSettledWithLimit: (limit, items, fn) =>
    Promise.allSettled(items.map(fn)),
}
