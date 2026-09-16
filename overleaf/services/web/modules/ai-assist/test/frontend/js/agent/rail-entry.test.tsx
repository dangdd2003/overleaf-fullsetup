import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import railEntry from '../../../../frontend/js/features/ai-assist/rail-entry'

describe('ai-assist rail entry', function () {
  afterEach(function () {
    // Reset rather than delete. `getMeta` reads `window.metaAttributesCache`
    // unguarded and only creates it when utils/meta is first imported, so
    // deleting it here made every later suite in the run throw on
    // `undefined.has(...)`.
    window.metaAttributesCache = new Map()
  })

  function setMeta(enabled: boolean) {
    window.metaAttributesCache = new Map([['ol-aiAssistEnabled', enabled]])
  }

  it('uses a stable key', function () {
    expect(railEntry.key).to.equal('ai-assist')
  })

  // The outlined Material Symbols face is subsetted and has no sparkle, so the
  // icon has to be an inline SVG component rather than a Material Symbols name.
  it('renders the icon as an inline SVG, not a Material Symbols name', function () {
    expect(railEntry.icon).to.be.a('function')

    const Icon = railEntry.icon as React.FC<{ open: boolean; title: string }>
    const { container } = render(<Icon open={false} title="AI assistant" />)

    expect(container.querySelector('svg')).to.exist
    expect(container.querySelector('svg')?.getAttribute('fill')).to.equal(
      'currentColor'
    )
    expect(screen.getByText('AI assistant')).to.exist
  })

  it('is hidden when the module is disabled', function () {
    setMeta(false)
    const hide =
      typeof railEntry.hide === 'function' ? railEntry.hide() : railEntry.hide
    expect(hide).to.equal(true)
  })

  it('is shown when the module is enabled', function () {
    setMeta(true)
    const hide =
      typeof railEntry.hide === 'function' ? railEntry.hide() : railEntry.hide
    expect(hide).to.equal(false)
  })
})
