import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import { InlineNotice } from '../../../../frontend/js/features/ai-assist/components/texgpt/texgpt-notices'

describe('texgpt: notices', function () {
  it('asks for consent and calls back on Allow and continue', function () {
    let allowed = 0
    render(<InlineNotice notice={{ name: 'consent' }} onConsent={() => allowed++} />)
    expect(
      screen.getByText(
        'Using the assistant will send project contents and queries to your configured AI provider.'
      )
    ).to.exist
    fireEvent.click(screen.getByRole('button', { name: 'Allow and continue' }))
    expect(allowed).to.equal(1)
  })

  it('points to the provider settings', function () {
    render(<InlineNotice notice={{ name: 'noProvider' }} />)
    expect(
      screen.getByText('TeXGPT uses your AI provider. Set one up in your account settings.')
    ).to.exist
    expect(
      screen.getByRole('link', { name: 'Set up an AI provider' }).getAttribute('href')
    ).to.equal('/user/settings')
  })

  it('shows an error with its hint as an alert', function () {
    render(<InlineNotice notice={{ name: 'error', message: 'Boom', hint: 'Check the key' }} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).to.equal('BoomCheck the key')
    expect(alert.className).to.equal('ai-texgpt-notice is-error')
  })

  it("shows the model's reason, or the default sentence, for cannot", function () {
    const { rerender } = render(<InlineNotice notice={{ name: 'cannot', reason: 'Not here.' }} />)
    expect(screen.getByText('Not here.')).to.exist
    rerender(<InlineNotice notice={{ name: 'cannot', reason: '' }} />)
    expect(screen.getByText('TeXGPT cannot help with this request.')).to.exist
  })

  it('says when the model returned nothing', function () {
    render(<InlineNotice notice={{ name: 'empty' }} />)
    expect(screen.getByText('The model returned no text.')).to.exist
  })
})
