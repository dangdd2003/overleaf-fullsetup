import { promisify, callbackify } from 'node:util'

export function callbackifyAll(obj) {
  return obj
}

export function promisifyAll(obj) {
  return obj
}

export function promisifyClass(cls) {
  return cls
}

export function promisifyMultiResult(fn) {
  return fn
}

export function callbackifyClass(cls) {
  return cls
}

export function callbackifyMultiResult(fn) {
  return fn
}

export function expressify(fn) {
  return fn
}

export function expressifyErrorHandler(fn) {
  return fn
}

export async function promiseMapWithLimit(limit, items, fn) {
  return Promise.all(items.map(fn))
}

export async function promiseMapSettledWithLimit(limit, items, fn) {
  return Promise.allSettled(items.map(fn))
}

export { promisify, callbackify }

export default {
  promisify,
  promisifyAll,
  promisifyClass,
  promisifyMultiResult,
  callbackify,
  callbackifyAll,
  callbackifyClass,
  callbackifyMultiResult,
  expressify,
  expressifyErrorHandler,
  promiseMapWithLimit,
  promiseMapSettledWithLimit,
}
