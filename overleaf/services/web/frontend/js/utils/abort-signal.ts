import './abortsignal-polyfill'

export const signalWithTimeout = (signal?: AbortSignal, timeout?: number) => {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) {
      controller.abort((signal as any).reason)
      return controller.signal
    }
    signal.addEventListener(
      'abort',
      () => controller.abort((signal as any).reason),
      { once: true }
    )
  }
  if (typeof timeout === 'number') {
    const timer = setTimeout(() => {
      controller.abort(new DOMException('TimeoutError', 'TimeoutError'))
    }, timeout)
    controller.signal.addEventListener('abort', () => clearTimeout(timer), {
      once: true,
    })
  }
  return controller.signal
}
