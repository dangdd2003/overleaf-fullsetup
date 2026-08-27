class DummyMetric {
  inc() {}
  dec() {}
  set() {}
  observe() {}
  labels() {
    return this
  }
}

module.exports = {
  mongodb: { monitor: () => {} },
  inc: () => {},
  gauge: () => {},
  timer: () => {},
  prom: {
    Counter: DummyMetric,
    Gauge: DummyMetric,
    Histogram: DummyMetric,
    Summary: DummyMetric,
  },
}
