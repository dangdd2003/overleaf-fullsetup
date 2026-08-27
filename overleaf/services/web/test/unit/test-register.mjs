import { register } from 'node:module'
import { createRequire } from 'node:module'
import Module from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const mocksDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'mocks'
)

// Hook ESM loader
const loaderPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'test-loader.mjs'
)
register(pathToFileURL(loaderPath))

// Hook CJS resolver
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === '@overleaf/o-error') {
    return path.join(mocksDir, 'o-error-mock.cjs')
  }
  if (request === '@overleaf/settings') {
    return path.join(mocksDir, 'settings-mock.cjs')
  }
  if (request === '@overleaf/metrics') {
    return path.join(mocksDir, 'metrics-mock.cjs')
  }
  if (request === '@overleaf/logger') {
    return path.join(mocksDir, 'logger-mock.cjs')
  }
  if (request === '@overleaf/promise-utils') {
    return path.join(mocksDir, 'promise-utils-mock.cjs')
  }
  try {
    return originalResolveFilename.call(this, request, parent, isMain, options)
  } catch (err) {
    if (
      !request.startsWith('.') &&
      !request.startsWith('/') &&
      !Module.builtinModules.includes(request)
    ) {
      return path.join(mocksDir, 'generic-mock.cjs')
    }
    throw err
  }
}
