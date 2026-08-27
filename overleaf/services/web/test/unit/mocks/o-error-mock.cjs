class OError extends Error {
  constructor(message, info = {}, cause = null) {
    super(message)
    this.info = info
    this.cause = cause
  }
  static tag(err, message, info) {
    return new OError(message || err.message, info, err)
  }
}
module.exports = OError
