import PrivilegeLevels from '../../../../app/src/Features/Authorization/PrivilegeLevels.mjs'
import McpErrors from './McpErrors.mjs'

/**
 * Access buckets from ProjectGetter.findAllUsersProjects, most privileged
 * first, with the access level each one grants.
 */
const ACCESS_BUCKETS = [
  ['owned', 'owner'],
  ['readAndWrite', PrivilegeLevels.READ_AND_WRITE],
  ['tokenReadAndWrite', PrivilegeLevels.READ_AND_WRITE],
  ['review', PrivilegeLevels.REVIEW],
  ['readOnly', PrivilegeLevels.READ_ONLY],
  ['tokenReadOnly', PrivilegeLevels.READ_ONLY],
]

/**
 * Parse an optional integer query or body parameter.
 *
 * @returns {number|null} the value, the fallback when absent, or null when it
 *   is not a safe integer of at least `min`
 */
function parseIntParam(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min ? n : null
}

/** A boolean flag, sent either as a boolean or as the string 'true'. */
function isTrueParam(value) {
  return value === true || value === 'true'
}

/** True when a slash-separated path has a '.' or '..' segment. */
function hasDotSegment(path) {
  return path.split('/').some(segment => segment === '..' || segment === '.')
}

/**
 * Reject with a validation error. `allowed` is shown to the model so it can
 * retry with a value that is accepted, rather than guessing.
 */
function invalid(res, message, { allowed, hint } = {}) {
  return McpErrors.send(res, McpErrors.CODES.VALIDATION, message, {
    hint,
    details: allowed ? { allowed } : undefined,
  })
}

export {
  ACCESS_BUCKETS,
  parseIntParam,
  isTrueParam,
  hasDotSegment,
  invalid,
}
