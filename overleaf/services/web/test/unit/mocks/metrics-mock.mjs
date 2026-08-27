class DummyMetric {
  inc() {}
  dec() {}
  set() {}
  observe() {}
  labels() {
    return this
  }
}

const metrics = {
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
export default metrics
