import React from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent } from '@testing-library/react'
import { SiteIcon } from '../../../../frontend/js/features/ai-assist/components/agent/site-icon'

describe('SiteIcon', function () {
  let clock: sinon.SinonFakeTimers

  beforeEach(function () {
    clock = sinon.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(function () {
    clock.restore()
  })

  function iconImg(container: HTMLElement) {
    return container.querySelector<HTMLImageElement>('img.ai-assist-web-favicon')
  }

  it('loads the favicon of the URL by default', function () {
    const { container } = render(<SiteIcon url="https://example.com/a" />)
    expect(iconImg(container)?.getAttribute('src')).to.equal(
      '/ai-assist/favicon?origin=https%3A%2F%2Fexample.com'
    )
  })

  it('loads the given src instead of the favicon of the URL', function () {
    const { container } = render(
      <SiteIcon url="https://example.com/a" src="/ai-assist/connectors/c1/icon" />
    )
    expect(iconImg(container)?.getAttribute('src')).to.equal(
      '/ai-assist/connectors/c1/icon'
    )
  })

  it('joins the retry parameter with ? when the src has no query string', function () {
    const { container } = render(
      <SiteIcon url="https://example.com" src="/ai-assist/connectors/c1/icon" />
    )
    fireEvent.error(iconImg(container)!)
    clock.tick(3000)
    expect(iconImg(container)?.getAttribute('src')).to.equal(
      '/ai-assist/connectors/c1/icon?retry=1'
    )
  })

  it('joins the retry parameter with & when the src has a query string', function () {
    const { container } = render(
      <SiteIcon url="https://example.com" src="/ai-assist/favicon?origin=x" />
    )
    fireEvent.error(iconImg(container)!)
    clock.tick(3000)
    expect(iconImg(container)?.getAttribute('src')).to.equal(
      '/ai-assist/favicon?origin=x&retry=1'
    )
  })

  it('shows the fallback at once after an error, and retries after 3s and 12s', function () {
    const { container } = render(
      <SiteIcon url="https://example.com" fallback={<b>fallback</b>} />
    )
    fireEvent.error(iconImg(container)!)
    expect(iconImg(container)).to.be.null
    expect(screen.getByText('fallback')).to.exist

    clock.tick(2999)
    expect(iconImg(container)).to.be.null
    clock.tick(1)
    expect(iconImg(container)?.getAttribute('src')).to.match(/&retry=1$/)

    fireEvent.error(iconImg(container)!)
    expect(iconImg(container)).to.be.null
    clock.tick(12000)
    expect(iconImg(container)?.getAttribute('src')).to.match(/&retry=2$/)
  })

  it('shows the fallback without loading anything when src is null', function () {
    const { container } = render(
      <SiteIcon url="" src={null} fallback={<b>fallback</b>} />
    )
    expect(iconImg(container)).to.be.null
    expect(screen.getByText('fallback')).to.exist
  })

  it('applies the className to the image', function () {
    const { container } = render(
      <SiteIcon url="https://example.com" className="my-size" />
    )
    expect(iconImg(container)?.classList.contains('my-size')).to.be.true
    expect(iconImg(container)?.classList.contains('ai-assist-web-favicon')).to.be.true
  })
})
