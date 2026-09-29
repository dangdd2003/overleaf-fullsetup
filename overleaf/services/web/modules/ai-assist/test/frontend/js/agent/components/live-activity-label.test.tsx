import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import {
  SubresultGroup,
  formatSubresultsSummary,
} from '../../../../../frontend/js/features/ai-assist/components/agent/subresult-group'

const fakeT = (_key: string, opts?: any) =>
  typeof opts === 'string' ? opts : opts?.defaultValue || _key

function live(items: any[]) {
  return formatSubresultsSummary(items, true, fakeT).title
}

const thinking = (text = 'weighing the preamble') => ({
  type: 'thinking' as const,
  thinking: text,
})

const running = (name: string, args: any = {}) => ({
  type: 'tool_call' as const,
  call: { id: `${name}-live`, name, args },
})

const finished = (name: string, args: any = {}) => ({
  type: 'tool_call' as const,
  call: { id: `${name}-done`, name, args, result: {} },
})

/**
 * The activity line is a tally, not a status. It accumulates what the run has
 * done — "Read 2 files, checked references" — and never reports what is
 * happening at this instant. Transient verbs ("Reading…", "Editing…") made it
 * flicker on every call, which is noise; the separate status line is where
 * "still going" belongs.
 */
describe('the activity line is a tally, not a live status', function () {
  it('names no verb while a read is in flight and returns empty before completion', function () {
    const title = live([running('read_file', { path: 'chapter3.tex' })])

    expect(title).to.equal('')
  })

  it('names no verb when completed while another is in flight', function () {
    const title = live([finished('edit_file', { path: 'main.tex' }), running('read_file', { path: 'chapter3.tex' })])

    expect(title).to.equal('Edited 1 file')
    expect(title).to.not.contain('main.tex')
    expect(title).to.not.contain('…')
  })

  it('never says Thinking or Working in place of an activity', function () {
    for (const items of [
      [],
      [thinking()],
      [finished('read_file')],
      [running('search_project', { query: 'graphicx' })],
    ]) {
      const title = live(items)
      expect(title).to.not.contain('Thinking')
      expect(title).to.not.contain('Working')
    }
  })

  it('says nothing at all before any tool has run', function () {
    expect(live([])).to.equal('')
    expect(live([thinking()])).to.equal('')
  })

  it('only grows as calls accumulate, so it never flickers', function () {
    const first = live([finished('read_file', { path: 'a.tex' })])
    const second = live([
      finished('read_file', { path: 'a.tex' }),
      running('read_file', { path: 'b.tex' }),
    ])
    const third = live([
      finished('read_file', { path: 'a.tex' }),
      finished('read_file', { path: 'b.tex' }),
      running('edit_file', { path: 'c.tex' }),
    ])

    expect(first).to.equal('Read 1 file')
    expect(second).to.equal('Read 1 file')
    expect(third).to.equal('Read 2 files')
  })

  it('summarizes completed tool calls when finished', function () {
    const { title } = formatSubresultsSummary(
      [
        finished('read_file', { path: 'a.tex' }),
      ] as any,
      false,
      fakeT
    )

    expect(title).to.equal('Read 1 file')
    expect(title).to.not.contain('…')
  })
})

describe('SubresultGroup while a run is starting', function () {
  it('renders nothing for an empty group that is not live', function () {
    const { container } = render(
      <SubresultGroup items={[]} onDecision={() => {}} />
    )

    expect(container.querySelector('.ai-assist-subresult-group')).to.equal(null)
  })

  it('renders nothing for a live group with no blocks yet', function () {
    const { container } = render(
      <SubresultGroup items={[]} isLive onDecision={() => {}} />
    )

    expect(container.querySelector('.ai-assist-subresult-group')).to.equal(null)
  })

  it('renders nothing for a live group with only running calls before any complete', function () {
    const { container } = render(
      <SubresultGroup
        items={[running('read_file', { path: 'main.tex' })]}
        isLive
        onDecision={() => {}}
      />
    )

    expect(container.querySelector('.ai-assist-subresult-group')).to.equal(null)
  })

  it('shows the accumulating tally of completed calls mid-run, with no verb', function () {
    render(
      <SubresultGroup
        items={[
          finished('read_file', { path: 'main.tex' }),
          running('read_file', { path: 'other.tex' }),
        ]}
        isLive
        onDecision={() => {}}
      />
    )

    const header = screen.getByRole('button')
    expect(header.textContent).to.contain('Read 1 file')
    expect(header.textContent).to.not.contain('Reading')
  })
})
