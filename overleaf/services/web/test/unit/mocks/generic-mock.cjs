// Generic mock that tracks calls on the function object itself, so that
// the apply trap and the get trap share the same state (spy().called etc.).
function createMock() {
  // Call state lives directly on the mockFn, shared between get and apply traps
  const mockFn = function (...args) {
    const calls = mockFn.__calls__
    const thisArg = this === mockFn ? undefined : this
    calls.push({ args, thisArg })
    return createMock() // chainable return value
  }

  // Initialise so both apply (before any get) and get see the same array
  mockFn.__calls__ = []

  const handler = {
    get(target, prop) {
      if (prop === '__esModule') return true
      if (prop === 'default') return createMock()
      if (prop === 'then') return undefined
      if (prop === 'toString') return () => 'mock'
      if (prop === 'valueOf') return () => undefined
      // Allow direct access to __calls__ without triggering the mock getter again
      if (prop === '__calls__') return mockFn.__calls__

      const calls = mockFn.__calls__

      // Real call-counting spy properties
      if (prop === 'called') return calls.length > 0
      if (prop === 'callCount') return calls.length
      if (prop === 'calledOnce') return calls.length === 1
      if (prop === 'calledTwice') return calls.length === 2
      if (prop === 'calledThrice') return calls.length === 3
      if (prop === 'notCalled') return calls.length === 0
      if (prop === 'firstCall') return calls[0] || null
      if (prop === 'lastCall') return calls[calls.length - 1] || null
      if (prop === 'getCall') return idx => calls[idx] || null
      if (prop === 'getCalls') return () => calls.slice()
      if (prop === 'mock') {
        // Return a plain object so .calls resolves to the real array, not a proxy
        const c = calls
        return Object.assign(function () {}, { calls: c })
      }
      if (prop === 'reset' || prop === 'resetHistory') {
        calls.length = 0
        return mockFn
      }
      if (prop === 'restore') return () => {}

      // Chainable stub methods (stub.returns(val), stub.callsFake(fn), etc.)
      if (
        prop === 'withArgs' ||
        prop === 'callThrough' ||
        prop === 'callsFake' ||
        prop === 'callsArg' ||
        prop === 'callsArgOn' ||
        prop === 'callsArgAsync' ||
        prop === 'callsArgOnAsync' ||
        prop === 'callArg' ||
        prop === 'callArgOn' ||
        prop === 'callArgAsync' ||
        prop === 'callArgOnAsync' ||
        prop === 'returns' ||
        prop === 'returnsArg' ||
        prop === 'returnsThis' ||
        prop === 'throws' ||
        prop === 'throwsArg' ||
        prop === 'throwsType' ||
        prop === 'resolves' ||
        prop === 'resolvesArg' ||
        prop === 'rejects' ||
        prop === 'rejectsArg' ||
        prop === 'rejectsThis' ||
        prop === 'yield' ||
        prop === 'yieldTo' ||
        prop === 'yieldAsync' ||
        prop === 'yieldToAsync' ||
        prop === 'onFirstCall' ||
        prop === 'onSecondCall' ||
        prop === 'onThirdCall' ||
        prop === 'createStubInstance'
      ) {
        return createMock()
      }

      return createMock()
    },
    apply(target, thisArg, argumentsList) {
      mockFn.__calls__.push({ args: argumentsList, thisArg })
      return createMock()
    },
    construct(target, args) {
      return createMock()
    },
  }

  return new Proxy(mockFn, handler)
}

module.exports = createMock()
