function createSchema() {
  const schema = {
    parse: x => x,
    transform: () => createSchema(),
    min: () => createSchema(),
    max: () => createSchema(),
    email: () => createSchema(),
    optional: () => createSchema(),
    nullable: () => createSchema(),
    default: () => createSchema(),
    refine: () => createSchema(),
    array: () => createSchema(),
  }
  return new Proxy(schema, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return () => createSchema()
    },
    apply() {
      return createSchema()
    },
  })
}

export function parseReq() {
  return {}
}

export function handleValidationError(err, req, res, next) {
  next(err)
}

export class InvalidParamsError extends Error {}
export class InvalidRequestError extends Error {}

export const z = new Proxy({}, {
  get(target, prop) {
    return () => createSchema()
  },
})

export const zz = new Proxy({}, {
  get(target, prop) {
    return () => createSchema()
  },
})

export default {
  parseReq,
  handleValidationError,
  InvalidParamsError,
  InvalidRequestError,
  z,
  zz,
}
