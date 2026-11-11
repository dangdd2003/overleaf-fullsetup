import './abortsignal-polyfill'

export const signalWithTimeout = (signal?: AbortSignal, timeout?: number) => {
  const signals: AbortSignal[] = []
  if (signal) {
    signals.push(signal)
  }
  if (typeof timeout === 'number') {
    signals.push(AbortSignal.timeout(timeout))
  }
  if (signals.length === 0) {
    return new AbortController().signal
  }
  return AbortSignal.any(signals)
}
