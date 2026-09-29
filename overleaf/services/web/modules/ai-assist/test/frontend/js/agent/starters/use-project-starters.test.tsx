import { expect } from 'chai'
import { renderHook, waitFor } from '@testing-library/react'
import customLocalStorage from '@/infrastructure/local-storage'
import { useProjectStarters } from '../../../../../frontend/js/features/ai-assist/agent/starters/use-project-starters'
import { createFakeHandle } from '../helpers/fake-handle'

describe('useProjectStarters recomputation', function () {
  beforeEach(function () {
    customLocalStorage.clear()
  })

  it('updates starters when compile outcome changes without requiring a new chat refresh', async function () {
    let compileState: any = {
      status: 'failure',
      errors: [{ message: 'err', file: 'main.tex', line: 1 }],
      warnings: [],
    }

    const { handle } = createFakeHandle({
      docs: { 'main.tex': 'x' },
      lastCompile: compileState,
    })
    handle.lastCompile = () => compileState

    const { result, rerender } = renderHook(
      ({ seed }) =>
        useProjectStarters({
          handle,
          files: [{ path: 'main.tex', type: 'doc', size: 100 }],
          projectId: 'p1',
          refreshSeed: seed,
        }),
      { initialProps: { seed: 0 } }
    )

    await waitFor(() => {
      expect(result.current.some(s => s.id === 'fix_compile_errors')).to.equal(true)
    })

    // Now compile passes cleanly
    compileState = { status: 'success', errors: [], warnings: [] }

    rerender({ seed: 0 })

    await waitFor(() => {
      expect(result.current.some(s => s.id === 'fix_compile_errors')).to.equal(false)
    })
  })
})
