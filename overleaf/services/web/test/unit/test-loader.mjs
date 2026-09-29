import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { builtinModules } from 'node:module'

const MOCKS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'mocks'
)

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'mongoose') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'mongoose-mock.mjs')).href,
    }
  }
  if (specifier === 'mongodb-legacy' || specifier === 'mongodb') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'mongodb-legacy-mock.mjs')).href,
    }
  }
  if (specifier === 'moment') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'moment-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/settings') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'settings-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/metrics') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'metrics-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/logger') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'logger-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/o-error') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'o-error-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/mongo-utils') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'mongo-utils-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/fetch-utils') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'fetch-utils-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/promise-utils') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'promise-utils-mock.mjs')).href,
    }
  }
  if (specifier === 'vitest') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'vitest-mock.mjs')).href,
    }
  }
  if (specifier === 'cache-flow') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'cache-flow-mock.mjs')).href,
    }
  }
  if (specifier === '@overleaf/validation-tools') {
    return {
      shortCircuit: true,
      url: pathToFileURL(path.join(MOCKS_DIR, 'validation-tools-mock.mjs')).href,
    }
  }

  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('file:') &&
      !builtinModules.includes(specifier.replace(/^node:/, ''))
    ) {
      return {
        shortCircuit: true,
        url: pathToFileURL(path.join(MOCKS_DIR, 'generic-mock.mjs')).href,
      }
    }
    throw err
  }
}
