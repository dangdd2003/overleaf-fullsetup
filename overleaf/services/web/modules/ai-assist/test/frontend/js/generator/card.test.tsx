import { expect } from 'chai'
import sinon from 'sinon'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  GeneratorCard,
  GeneratorCardProps,
  GeneratorCardText,
} from '../../../../frontend/js/features/ai-assist/components/generator/generator-card'

const TEXT: GeneratorCardText = {
  kind: 'Thing',
  label: 'Generated thing',
  noProvider: 'No provider.',
  cannot: 'Cannot help.',
  imageUnsupported: 'No images.',
  repairing: 'Fixing…',
  followUpPlaceholder: 'Ask',
  retry: 'Regenerate',
}

function props(overrides: Partial<GeneratorCardProps> = {}): GeneratorCardProps {
  return {
    text: TEXT,
    title: 'my request',
    imageAttached: false,
    phase: { name: 'ready' },
    versionCount: 1,
    index: 0,
    onIndex: () => {},
    copyText: 'CODE',
    notes: 'line one\nline two',
    warnings: [{ message: 'Watch out' }],
    packages: [],
    canAddPackages: false,
    addPackages: true,
    onAddPackages: () => {},
    stale: false,
    followUp: '',
    onFollowUp: () => {},
    onSendFollowUp: () => {},
    onStop: () => {},
    onRetry: () => {},
    onEditPrompt: () => {},
    onDiscard: () => {},
    onInsert: () => {},
    onConsent: () => {},
    ...overrides,
  }
}

describe('generator: card', function () {
  afterEach(function () {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows the version with its notes and warnings, and names Retry as told', function () {
    const onRetry = sinon.spy()
    render(
      <GeneratorCard {...props({ onRetry })}>
        <p>THE RESULT</p>
      </GeneratorCard>
    )
    expect(screen.getByRole('dialog', { name: 'Generated thing' })).to.exist
    expect(screen.getByText('THE RESULT')).to.exist
    expect(screen.getByText(/line one/)).to.exist
    expect(screen.getByText('Watch out')).to.exist
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }))
    expect(onRetry.calledOnce).to.equal(true)
  })

  it('shows the streaming preview instead of the status line', function () {
    render(
      <GeneratorCard
        {...props({
          phase: { name: 'streaming', reply: null, repairing: true },
          copyText: null,
          streamingPreview: <p>ROWS SO FAR</p>,
        })}
      />
    )
    expect(screen.getByText('ROWS SO FAR')).to.exist
    expect(screen.queryByText('Writing…')).to.equal(null)
    expect(screen.getByText('Fixing…')).to.exist
  })

  it("uses the generator's own words for its notices", function () {
    const { rerender } = render(
      <GeneratorCard {...props({ phase: { name: 'cannot', reason: '' }, copyText: null })} />
    )
    expect(screen.getByText('Cannot help.')).to.exist
    rerender(<GeneratorCard {...props({ phase: { name: 'noProvider' }, copyText: null })} />)
    expect(screen.getByText('No provider.')).to.exist
  })
})
