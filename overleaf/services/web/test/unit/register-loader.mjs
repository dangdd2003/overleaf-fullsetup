import { register } from 'node:module'
import path from 'node:path'
import Module, { builtinModules } from 'node:module'

const MOCKS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'mocks'
)

const origResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === '@overleaf/o-error') {
    return path.join(MOCKS_DIR, 'o-error-mock.cjs')
  }
  if (request === '@overleaf/logger') {
    return path.join(MOCKS_DIR, 'logger-mock.cjs')
  }
  if (request === '@overleaf/settings') {
    return path.join(MOCKS_DIR, 'settings-mock.cjs')
  }
  if (request === '@overleaf/metrics') {
    return path.join(MOCKS_DIR, 'metrics-mock.cjs')
  }
  if (request === '@overleaf/promise-utils') {
    return path.join(MOCKS_DIR, 'promise-utils-mock.cjs')
  }
  try {
    return origResolveFilename.call(this, request, parent, isMain, options)
  } catch (err) {
    if (
      !request.startsWith('.') &&
      !request.startsWith('/') &&
      !builtinModules.includes(request.replace(/^node:/, ''))
    ) {
      return path.join(MOCKS_DIR, 'generic-mock.cjs')
    }
    throw err
  }
}

register('./test-loader.mjs', import.meta.url)
