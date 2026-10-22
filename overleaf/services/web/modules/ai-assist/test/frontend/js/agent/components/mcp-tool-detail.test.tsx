import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import { ToolCallDetailView } from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-detail'
import {
  ToolCallCard,
  ToolCallSummaryLine,
  summarise,
} from '../../../../../frontend/js/features/ai-assist/components/agent/tool-call-card'
import { subresultExpansionStore } from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-expansion-store'

const fakeT = (_key: string, opts?: any) =>
  typeof opts === 'string' ? opts : opts?.defaultValue || _key

const PAGED =
  '[Result r1: 12,345 characters]\n\nfirst page of the document\n\n[Page 1 of 3 of result r1. Call read_connector_result with id "r1" and page 2 to continue.]'

const mcpCall = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    name: 'mcp__github__search_issues',
    args: { query: 'overleaf latex', limit: 5 },
    result: { result: 'a short answer', isError: false },
    ...overrides,
  }) as any

describe('connector tool cards', function () {
  afterEach(function () {
    subresultExpansionStore.clear()
  })

  describe('header', function () {
    it('names the verb, the server and the argument summary', function () {
      const summary = summarise(mcpCall(), fakeT)
      expect(summary).to.deep.equal({
        action: 'Called search_issues',
        target: 'Github',
        meta: 'overleaf latex',
      })
    })

    it('shows the server while the call runs', function () {
      const pending = mcpCall()
      delete pending.result
      const summary = summarise(pending, fakeT)
      expect(summary.action).to.equal('Running…')
      expect(summary.target).to.equal('Github')
    })

    it('falls back to the server name when the connectors are not loaded', function () {
      const { container } = render(
        <ToolCallSummaryLine call={mcpCall() as any} />
      )
      expect(container.textContent).to.contain('Called search_issues')
      expect(container.textContent).to.contain('Github')
      expect(container.textContent).to.contain('overleaf latex')
    })

    it('leaves non-connector tools labelled as before', function () {
      expect(
        summarise(
          {
            id: 'x',
            name: 'read_file',
            args: { path: 'main.tex' },
            result: { content: '' },
          } as any,
          fakeT
        ).target
      ).to.equal('main.tex')
    })
  })

  describe('detail', function () {
    it('shows the result as well as the arguments', function () {
      const { container } = render(
        <ToolCallDetailView call={mcpCall() as any} />
      )
      expect(screen.getByText('Input')).to.exist
      expect(screen.getByText('query')).to.exist
      expect(screen.getByText('overleaf latex')).to.exist
      expect(screen.getByText('Output')).to.exist
      expect(container.textContent).to.contain('a short answer')
    })

    it('shows arrays of plain values as chips', function () {
      const { container } = render(
        <ToolCallDetailView
          call={mcpCall({ args: { labels: ['bug', 'docs'] } }) as any}
        />
      )
      const chips = container.querySelectorAll('.ai-assist-mcp-chip')
      expect(Array.from(chips).map((chip) => chip.textContent)).to.deep.equal([
        'bug',
        'docs',
      ])
    })

    it('pretty-prints a JSON result', function () {
      const { container } = render(
        <ToolCallDetailView
          call={
            mcpCall({
              result: { result: '{"title":"Fix","open":true}' },
            }) as any
          }
        />
      )
      expect(container.textContent).to.contain('"title": "Fix"')
      expect(container.textContent).to.contain('"open": true')
    })

    it('takes the paging header and trailer off a long result into a meta line', function () {
      const { container } = render(
        <ToolCallDetailView
          call={mcpCall({ result: { result: PAGED } }) as any}
        />
      )
      expect(screen.getByText(/12,345 characters · showing page 1 of 3/)).to
        .exist
      expect(container.textContent).to.contain('first page of the document')
      expect(container.textContent).to.not.contain('[Result r1')
      expect(container.textContent).to.not.contain('[Page 1 of 3')
    })

    it('reads a read_connector_result page with its arguments', function () {
      const call = {
        id: 'r',
        name: 'read_connector_result',
        args: { id: 'r1', page: 2 },
        result: {
          result:
            'second page\n\n[Page 2 of 3 of result r1. Call read_connector_result with id "r1" and page 3 to continue.]',
        },
      }
      const { container } = render(<ToolCallDetailView call={call as any} />)
      expect(screen.getByText('r1')).to.exist
      expect(screen.getByText('2')).to.exist
      expect(container.textContent).to.contain('second page')
      expect(container.textContent).to.not.contain('[Page 2')
      expect(screen.getByText(/showing page 2 of 3/)).to.exist
    })

    it('shows an error with its message', function () {
      render(
        <ToolCallDetailView
          call={
            mcpCall({ result: { error: 'Rate limited' }, isError: true }) as any
          }
        />
      )
      expect(screen.getByText(/Rate limited/)).to.exist
    })

    it('shows a failed result text as its message', function () {
      render(
        <ToolCallDetailView
          call={
            mcpCall({
              result: { result: 'Quota exceeded', isError: true },
            }) as any
          }
        />
      )
      expect(screen.getByText(/Quota exceeded/)).to.exist
    })

    it('says so when there is no output', function () {
      render(
        <ToolCallDetailView
          call={mcpCall({ result: { result: '   ' } }) as any}
        />
      )
      expect(screen.getByText('No output')).to.exist
    })

    it('shows an image as a placeholder', function () {
      render(
        <ToolCallDetailView
          call={mcpCall({ result: { result: '[Image: image/png]' } }) as any}
        />
      )
      expect(screen.getByText('Image (image/png)')).to.exist
    })

    it('notes when the stored history trimmed the result', function () {
      render(
        <ToolCallDetailView
          call={
            mcpCall({ result: { truncated: true, preview: 'cut off' } }) as any
          }
        />
      )
      expect(screen.getByText('Output trimmed in saved history')).to.exist
    })

    it('reads a string result given directly', function () {
      const { container } = render(
        <ToolCallDetailView call={mcpCall({ result: 'plain string' }) as any} />
      )
      expect(container.textContent).to.contain('plain string')
    })

    it('shows the running state before a result arrives', function () {
      const call = mcpCall()
      delete call.result
      render(<ToolCallDetailView call={call} />)
      expect(screen.getByText('Input')).to.exist
      expect(screen.getByText('Running…')).to.exist
    })

    it('toggles a long output between clamped and open', function () {
      const long = `${'word '.repeat(80)}end`
      const { container } = render(
        <ToolCallDetailView
          call={mcpCall({ result: { result: long } }) as any}
        />
      )
      const button = screen.getByRole('button', { name: /show more/i })
      expect(button.getAttribute('aria-expanded')).to.equal('false')
      expect(container.querySelector('.ai-assist-mcp-clamp.is-collapsed')).to
        .exist

      fireEvent.click(button)
      expect(
        screen
          .getByRole('button', { name: /show less/i })
          .getAttribute('aria-expanded')
      ).to.equal('true')
      expect(container.querySelector('.ai-assist-mcp-clamp.is-open')).to.exist
    })

    it('does not offer to show more for a short output', function () {
      render(
        <ToolCallDetailView
          call={mcpCall({ result: { result: 'short' } }) as any}
        />
      )
      expect(screen.queryByRole('button', { name: /show more/i })).to.be.null
    })
  })

  describe('expansion', function () {
    it('opens the detail from the header', function () {
      const { container } = render(<ToolCallCard call={mcpCall() as any} />)
      const summary = container.querySelector('.ai-assist-tool-call-summary')!
      ;(summary as HTMLElement).click()
      expect(container.querySelector('.ai-assist-tool-call-detail.is-mcp')).to
        .exist
      expect(container.textContent).to.contain('a short answer')
    })
  })
})
