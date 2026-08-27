export default class OError extends Error {
  constructor(message, info = {}, cause = null) {
    super(message)
    this.info = info
    this.cause = cause
  }
}
