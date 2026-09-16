import { expect } from 'chai'
import { render, screen, waitFor } from '@testing-library/react'
import { EditorProviders } from '../../../../../../test/frontend/helpers/editor-providers'
import { resetMeta } from '../../../../../../test/frontend/helpers/reset-meta'
import { useProjectHandle } from '../../../../frontend/js/features/ai-assist/agent/use-project-handle'

function Probe() {
  const handle = useProjectHandle({
    requestApproval: async () => ({ accepted: false }),
  })

  const methods = [
    'rootDocPath',
    'listFiles',
    'readFile',
    'search',
    'currentSelection',
    'proposeEdit',
    'compile',
    'openFile',
    'lastCompile',
    'createFile',
  ]
  const missing = methods.filter(
    name => typeof (handle as any)[name] !== 'function'
  )

  return <div data-testid="probe">{missing.length ? missing.join(',') : 'ok'}</div>
}

describe('useProjectHandle inside the compile log pane', function () {
  beforeEach(function () {
    resetMeta()
  })

  it('resolves every context it needs under EditorProviders', async function () {
    render(
      <EditorProviders>
        <Probe />
      </EditorProviders>
    )

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).to.equal('ok')
    })
  })
})
