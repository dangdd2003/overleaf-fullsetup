import { ProjectHandle } from './project-handle'

const DENIED = 'This tool is not permitted to modify the project.'

const MUTATING_METHODS = new Set([
  'proposeEdit',
  'createFile',
  'configureAppearanceSettings',
  'configureCompilerSettings',
  'configureEditorSettings',
])

/**
 * A handle with the mutation methods removed.
 *
 * Every write reaches the project through mutation methods (`proposeEdit`,
 * `createFile`, `configureAppearanceSettings`, `configureCompilerSettings`,
 * `configureEditorSettings`). Handing a non-mutating tool a handle where they throw
 * makes "this tool cannot write" a property of the runtime rather than a promise
 * each tool has to keep.
 */
export function readOnlyHandle(handle: ProjectHandle): ProjectHandle {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && MUTATING_METHODS.has(prop)) {
        return () => Promise.reject(new Error(DENIED))
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}
