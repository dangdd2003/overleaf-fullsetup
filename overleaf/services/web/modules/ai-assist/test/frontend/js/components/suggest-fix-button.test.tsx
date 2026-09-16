import { expect } from 'chai'
import { render, screen, fireEvent } from '@testing-library/react'
import SuggestFixButton from '../../../../frontend/js/features/ai-assist/components/suggest-fix-button'
import type { LogEntry } from '@/features/pdf-preview/util/types'

function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache?.clear()
  document.head.innerHTML = enabled
    ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
    : ''
}

// The shape the compile-log pane actually passes: a LogEntry identifies itself
// with `key`, not `id` (see features/pdf-preview/util/types.ts). The pane also
// passes that same value as the separate `id` prop.
const LOG_ENTRY: Partial<LogEntry> = {
  key: 'entry-1',
  level: 'error',
  message: 'Undefined control sequence',
}

/** Mimics the log-entry markup the pane renders around this button. */
function renderInEntry(ui: React.ReactElement, { collapsed = false } = {}) {
  const container = document.createElement('div')
  container.innerHTML = `<div class="log-entry"><div data-action="expand-collapse" data-collapsed="${collapsed}"></div><div class="slot"></div></div>`
  document.body.appendChild(container)

  const toggle = container.querySelector(
    '[data-action="expand-collapse"]'
  ) as HTMLElement
  const toggleClicks: number[] = []
  toggle.addEventListener('click', () => toggleClicks.push(1))

  render(ui, { container: container.querySelector('.slot') as HTMLElement })

  return { container, toggleClicks }
}

describe('SuggestFixButton', function () {
  beforeEach(function () {
    setMeta()
    document.body.innerHTML = ''
  })

  it('renders nothing when the feature is disabled', function () {
    setMeta({ enabled: false })
    const { container } = render(<SuggestFixButton logEntry={LOG_ENTRY} />)
    expect(container.textContent).to.equal('')
  })

  it('renders nothing without a log entry key', function () {
    const { container } = render(<SuggestFixButton logEntry={{}} />)
    expect(container.textContent).to.equal('')
  })

  it('renders nothing for an info-level log entry', function () {
    const { container } = render(
      <SuggestFixButton logEntry={{ key: 'entry-1', level: 'info' }} />
    )
    expect(container.textContent).to.equal('')
  })

  it('renders for a warning-level log entry', function () {
    render(<SuggestFixButton logEntry={{ key: 'entry-1', level: 'warning' }} />)
    expect(screen.getByRole('button', { name: /suggest fix/i })).to.exist
  })

  it('renders for a log entry identified by key', function () {
    render(<SuggestFixButton logEntry={LOG_ENTRY} />)
    expect(screen.getByRole('button', { name: /suggest fix/i })).to.exist
  })

  it('renders when only the id prop is supplied', function () {
    render(<SuggestFixButton id="entry-1" logEntry={{ level: 'error' }} />)
    expect(screen.getByRole('button', { name: /suggest fix/i })).to.exist
  })

  it('exposes data-action="suggest-fix" on the rendered button', function () {
    // use-log-events.ts:46 finds this button by that exact selector when the
    // editor asks the log pane for a fix. If the attribute does not reach the
    // DOM the editor-initiated path silently does nothing.
    const { container } = render(<SuggestFixButton logEntry={LOG_ENTRY} />)
    const button = container.querySelector('button[data-action="suggest-fix"]')
    expect(button).to.exist
  })

  it('dispatches aiAssist:suggestFix with the entry key when clicked', function () {
    const received: any[] = []
    const listener = (e: Event) => received.push((e as CustomEvent).detail)
    window.addEventListener('aiAssist:suggestFix', listener)

    try {
      render(<SuggestFixButton logEntry={LOG_ENTRY} />)
      fireEvent.click(screen.getByRole('button', { name: /suggest fix/i }))
      expect(received).to.deep.equal([{ entryId: 'entry-1' }])
    } finally {
      window.removeEventListener('aiAssist:suggestFix', listener)
    }
  })

  it('targets only its own entry', function () {
    const received: any[] = []
    const listener = (e: Event) => received.push((e as CustomEvent).detail)
    window.addEventListener('aiAssist:suggestFix', listener)

    try {
      render(<SuggestFixButton logEntry={{ key: 'entry-A', level: 'error' }} />)
      render(<SuggestFixButton logEntry={{ key: 'entry-B', level: 'error' }} />)
      const buttons = screen.getAllByRole('button', { name: /suggest fix/i })
      fireEvent.click(buttons[1])
      expect(received).to.deep.equal([{ entryId: 'entry-B' }])
    } finally {
      window.removeEventListener('aiAssist:suggestFix', listener)
    }
  })

  it('expands a collapsed entry before dispatching', function () {
    // The suggestion panel renders inside the entry's content, which the pane
    // keeps mounted but hidden while collapsed. Without this the stream would
    // arrive somewhere the user cannot see.
    const { toggleClicks } = renderInEntry(
      <SuggestFixButton logEntry={LOG_ENTRY} />,
      { collapsed: true }
    )

    fireEvent.click(screen.getByRole('button', { name: /suggest fix/i }))
    expect(toggleClicks).to.have.length(1)
  })

  it('leaves an already-expanded entry alone', function () {
    const { toggleClicks } = renderInEntry(
      <SuggestFixButton logEntry={LOG_ENTRY} />,
      { collapsed: false }
    )

    fireEvent.click(screen.getByRole('button', { name: /suggest fix/i }))
    expect(toggleClicks).to.have.length(0)
  })
})
