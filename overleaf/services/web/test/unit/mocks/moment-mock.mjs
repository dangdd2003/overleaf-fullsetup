function moment(date) {
  const d = date ? new Date(date) : new Date()
  return {
    add: (n, unit) => moment(d),
    subtract: (n, unit) => moment(d),
    isBefore: other => d < (other ? new Date(other) : new Date()),
    isAfter: other => d > (other ? new Date(other) : new Date()),
    toDate: () => d,
    toISOString: () => d.toISOString(),
  }
}
export default moment
