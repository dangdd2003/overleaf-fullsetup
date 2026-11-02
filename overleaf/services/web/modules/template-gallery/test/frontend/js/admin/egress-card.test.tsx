import { expect } from 'chai'
import i18next from 'i18next'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import enTranslations from '../../../../../../locales/en.json'
import EgressCard from '../../../../frontend/js/components/admin/settings/egress-card'
import type { EgressProxy } from '../../../../frontend/js/api/egress'

const EGRESS_API = '/admin/templates/api/egress'
const BULK_API = `${EGRESS_API}/proxies/bulk`

// Strings added with the bulk form. They are kept here so the test does not
// depend on en.json already containing them.
const bulkTranslations = {
  template_gallery_admin_egress_bulk_open: 'Add several at once',
  template_gallery_admin_egress_single_open: 'Add one proxy',
  template_gallery_admin_egress_bulk_field: 'Proxy addresses, one per line',
  template_gallery_admin_egress_bulk_placeholder:
    'http://user:pass@203.0.113.10:8080\nhttps://proxy.example.com:443\nsocks5://user:pass@198.51.100.7:1080',
  template_gallery_admin_egress_bulk_allow_private:
    'Allow private network addresses',
  template_gallery_admin_egress_bulk_submit: 'Add proxies',
  template_gallery_admin_egress_bulk_added: 'Proxies added: __count__.',
  template_gallery_admin_egress_bulk_line: 'Line __line__: __input__ — __reason__',
  template_gallery_admin_egress_bulk_error_invalid_url:
    'Not a valid proxy address.',
  template_gallery_admin_egress_bulk_error_unknown:
    'This line could not be added.',
}

function proxy(overrides: Partial<EgressProxy> = {}): EgressProxy {
  return {
    id: 'proxy-1',
    label: 'Office',
    scheme: 'socks5',
    host: '198.51.100.7',
    port: 1080,
    enabled: true,
    allowPrivate: false,
    hasAuth: true,
    health: {
      state: 'idle',
      backoffUntil: null,
      lastError: null,
      lastSuccessAt: null,
      lastStatus: null,
    },
    ...overrides,
  }
}

function lastBulkBody() {
  const call = fetchMock.callHistory.lastCall(BULK_API)!
  return JSON.parse(call.options.body as string)
}

async function renderCard(onFlash = sinon.stub()) {
  render(<EgressCard onFlash={onFlash} />)
  await screen.findByRole('heading', { name: 'Add proxy' })
  return { onFlash }
}

async function openBulkMode() {
  fireEvent.click(
    screen.getByRole('button', { name: bulkTranslations.template_gallery_admin_egress_bulk_open })
  )
  return screen.getByRole('textbox', {
    name: bulkTranslations.template_gallery_admin_egress_bulk_field,
  }) as HTMLTextAreaElement
}

describe('egress card', function () {
  before(function () {
    i18next.addResourceBundle('en', 'translation', enTranslations, true, true)
    i18next.addResourceBundle('en', 'translation', bulkTranslations, true, true)
  })

  beforeEach(function () {
    window.metaAttributesCache.set('ol-csrfToken', 'test-csrf-token')
    fetchMock.get(EGRESS_API, { proxies: [] })
  })

  afterEach(function () {
    cleanup()
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.delete('ol-csrfToken')
  })

  it('shows the single proxy form with a password field by default', async function () {
    await renderCard()

    const password = screen.getByLabelText('Password (optional)')
    expect(password.getAttribute('type')).to.equal('password')
    expect(screen.queryByRole('textbox', { name: 'Proxy addresses, one per line' })).to.be.null
  })

  it('switches to bulk mode and shows the textarea with its placeholder', async function () {
    await renderCard()

    const textarea = await openBulkMode()

    expect(textarea.tagName).to.equal('TEXTAREA')
    expect(textarea.getAttribute('placeholder')).to.contain(
      'socks5://user:pass@198.51.100.7:1080'
    )
    expect(screen.queryByLabelText('Password (optional)')).to.be.null
    screen.getByRole('button', { name: 'Add one proxy' })
  })

  it('posts the pasted text and the private network option', async function () {
    fetchMock.post(BULK_API, {
      added: [proxy()],
      errors: [],
      proxies: [proxy()],
    })
    const { onFlash } = await renderCard()
    const textarea = await openBulkMode()
    const text = 'https://proxy.example.com:443\nsocks5://198.51.100.7:1080#Office'

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByLabelText('Allow private network addresses'))
    fireEvent.click(screen.getByRole('button', { name: 'Add proxies' }))

    await waitFor(() => sinon.assert.calledOnce(onFlash))
    sinon.assert.calledWith(onFlash, {
      type: 'success',
      content: 'Proxies added: 1.',
    })
    expect(lastBulkBody()).to.deep.equal({ text, allowPrivate: true })
  })

  it('shows per-line errors and keeps only the failed lines', async function () {
    fetchMock.post(BULK_API, {
      added: [],
      errors: [
        {
          line: 2,
          position: 1,
          input: 'http://user:***@[bad',
          error: 'invalid_url',
        },
      ],
      proxies: [],
    })
    const { onFlash } = await renderCard()
    const textarea = await openBulkMode()
    const text = [
      'https://proxy.example.com:443',
      'http://user:secret@[bad',
      'socks5://198.51.100.7:1080',
    ].join('\n')

    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Add proxies' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).to.contain('Line 2: http://user:***@[bad')
    expect(alert.textContent).to.contain('Not a valid proxy address.')
    expect(alert.textContent).not.to.contain('secret')
    expect(textarea.value).to.equal('http://user:secret@[bad')
    sinon.assert.notCalled(onFlash)
  })
})
