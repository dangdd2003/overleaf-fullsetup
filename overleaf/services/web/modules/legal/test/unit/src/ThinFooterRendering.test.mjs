import { describe, it, expect } from 'vitest'
import pug from 'pug'
import path from 'path'

const thinFooterPugPath = path.resolve(
  import.meta.dirname,
  '../../../../../app/views/layout/thin-footer.pug'
)

function renderThinFooter(opts = {}) {
  return pug.renderFile(thinFooterPugPath, {
    settings: {
      nav: { hide_powered_by: opts.hidePoweredBy || false },
      i18n: { subdomainLang: opts.subdomainLang || {} },
      enableLegalPage: Boolean(opts.enableLegalPage),
    },
    nav: {
      left_footer: opts.leftFooter || [],
      right_footer: opts.rightFooter || [],
    },
    translate: key => {
      if (key === 'privacy_and_terms') return 'Privacy and Terms'
      return key
    },
  })
}

describe('thin-footer rendering', function () {
  it('renders "Powered by Overleaf | Privacy and Terms | Custom Item" when legal is enabled and custom items exist', function () {
    const html = renderThinFooter({
      enableLegalPage: true,
      leftFooter: [{ text: 'From D-Dev with love!', url: 'https://dangdd.me' }],
    })

    expect(html).to.include('Powered by Overleaf')
    expect(html).to.include('Privacy and Terms')
    expect(html).to.include('From D-Dev with love!')

    const poweredByIndex = html.indexOf('Powered by Overleaf')
    const firstSepIndex = html.indexOf('<strong class="text-muted">|</strong>', poweredByIndex)
    const legalIndex = html.indexOf('Privacy and Terms', firstSepIndex)
    const secondSepIndex = html.indexOf('<strong class="text-muted">|</strong>', legalIndex)
    const customIndex = html.indexOf('From D-Dev with love!', secondSepIndex)

    expect(firstSepIndex).to.be.greaterThan(poweredByIndex)
    expect(legalIndex).to.be.greaterThan(firstSepIndex)
    expect(secondSepIndex).to.be.greaterThan(legalIndex)
    expect(customIndex).to.be.greaterThan(secondSepIndex)
  })

  it('renders "Powered by Overleaf | Custom Item" when legal is disabled (fallback)', function () {
    const html = renderThinFooter({
      enableLegalPage: false,
      leftFooter: [{ text: 'From D-Dev with love!', url: 'https://dangdd.me' }],
    })

    expect(html).to.include('Powered by Overleaf')
    expect(html).to.not.include('Privacy and Terms')
    expect(html).to.include('From D-Dev with love!')

    const poweredByIndex = html.indexOf('Powered by Overleaf')
    const firstSepIndex = html.indexOf('<strong class="text-muted">|</strong>', poweredByIndex)
    const customIndex = html.indexOf('From D-Dev with love!', firstSepIndex)

    expect(firstSepIndex).to.be.greaterThan(poweredByIndex)
    expect(customIndex).to.be.greaterThan(firstSepIndex)
    // There should be only 1 separator
    const secondSepIndex = html.indexOf('<strong class="text-muted">|</strong>', customIndex)
    expect(secondSepIndex).to.equal(-1)
  })

  it('renders "Powered by Overleaf | Privacy and Terms" with no trailing separator when left_footer is empty', function () {
    const html = renderThinFooter({
      enableLegalPage: true,
      leftFooter: [],
    })

    expect(html).to.include('Powered by Overleaf')
    expect(html).to.include('Privacy and Terms')

    const poweredByIndex = html.indexOf('Powered by Overleaf')
    const sepIndex = html.indexOf('<strong class="text-muted">|</strong>', poweredByIndex)
    const legalIndex = html.indexOf('Privacy and Terms', sepIndex)

    expect(sepIndex).to.be.greaterThan(poweredByIndex)
    expect(legalIndex).to.be.greaterThan(sepIndex)

    const trailingSep = html.indexOf('<strong class="text-muted">|</strong>', legalIndex)
    expect(trailingSep).to.equal(-1)
  })

  it('does not duplicate legal link if left_footer already includes /legal', function () {
    const html = renderThinFooter({
      enableLegalPage: true,
      leftFooter: [
        { text: 'Custom Legal', url: '/legal' },
        { text: 'From D-Dev with love!', url: 'https://dangdd.me' },
      ],
    })

    const occurrences = (html.match(/href="\/legal"/g) || []).length
    expect(occurrences).to.equal(1)
  })
})
