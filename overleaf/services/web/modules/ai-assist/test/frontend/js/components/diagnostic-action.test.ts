import { expect } from 'chai'
import suggestFixDiagnosticAction from '../../../../frontend/js/features/ai-assist/diagnostic-action'
import { setCompileLogEntries } from '../../../../frontend/js/features/ai-assist/log-entry-levels'

function setEntries(levels: Record<string, string>) {
  setCompileLogEntries(
    Object.entries(levels).map(([key, level]) => ({ key, level, raw: '' })) as any
  )
}

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

const DIAGNOSTIC = {
  message: 'Undefined control sequence.',
  severity: 'error' as const,
  compile: true as const,
  id: 'entry-1',
}

describe('suggestFixDiagnosticAction', function () {
  afterEach(function () {
    document.body.innerHTML = ''
    setMeta({ enabled: false })
    setCompileLogEntries(undefined)
  })

  it('renders nothing when AI assist is disabled', function () {
    setMeta({ enabled: false })
    expect(suggestFixDiagnosticAction(DIAGNOSTIC)).to.equal(null)
  })

  it('renders nothing for non-compile diagnostics', function () {
    setMeta()
    setEntries({ 'entry-1': 'error' })
    expect(
      suggestFixDiagnosticAction({ ...DIAGNOSTIC, compile: undefined })
    ).to.equal(null)
  })

  it('follows the log entry level, not the flattened diagnostic severity', function () {
    setMeta()
    // Core reports info/typesetting entries to the editor as 'warning'; the
    // logs pane offers no fix for them, so neither may the editor.
    for (const level of ['info', 'typesetting']) {
      setEntries({ 'entry-1': level })
      expect(
        suggestFixDiagnosticAction({ ...DIAGNOSTIC, severity: 'warning' })
      ).to.equal(null)
    }
    for (const level of ['error', 'warning']) {
      setEntries({ 'entry-1': level })
      expect(suggestFixDiagnosticAction(DIAGNOSTIC)).to.not.equal(null)
    }
  })

  it('renders nothing when the entry is not in the compile log', function () {
    setMeta()
    setEntries({ other: 'error' })
    expect(suggestFixDiagnosticAction(DIAGNOSTIC)).to.equal(null)
  })

  it('opens the log entry and clicks its suggest-fix button', async function () {
    setMeta()
    setEntries({ 'entry-1': 'error' })
    const events: any[] = []
    const onView = (e: Event) => events.push((e as CustomEvent).detail)
    window.addEventListener('editor:view-compile-log-entry', onView)

    const button = suggestFixDiagnosticAction(DIAGNOSTIC)!
    expect(button.textContent).to.equal('Suggest fix')

    let clicked = false
    button.click()
    // The log pane mounts after the event, so the entry appears later.
    const entry = document.createElement('div')
    entry.innerHTML = `<div class="log-entry" data-log-entry-id="entry-1"><button data-action="suggest-fix"></button></div>`
    entry
      .querySelector('button')!
      .addEventListener('click', () => (clicked = true))
    document.body.appendChild(entry)

    await new Promise(resolve => setTimeout(resolve, 150))
    window.removeEventListener('editor:view-compile-log-entry', onView)

    expect(events).to.deep.equal([{ id: 'entry-1' }])
    expect(clicked).to.equal(true)
  })
})
