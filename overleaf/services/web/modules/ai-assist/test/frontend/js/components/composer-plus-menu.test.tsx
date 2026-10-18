import React from 'react'
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import {
  ComposerPlusMenu,
  ComposerPlusMenuProps,
} from '../../../../frontend/js/features/ai-assist/components/agent/composer-plus-menu'
import {
  readDisabledConnectors,
  setConnectorEnabledForChat,
} from '../../../../frontend/js/features/ai-assist/connectors/chat-selection'
import { ConnectorView } from '../../../../frontend/js/features/ai-assist/connectors/types'

const CHAT_ID = 'chat-1'
const CONNECTOR_IDS = ['conn-1', 'conn-2']

// Connectors are part of the assistant: on whenever it is.
function setMeta({ enabled = true } = {}) {
  window.metaAttributesCache = window.metaAttributesCache || new Map()
  window.metaAttributesCache.set('ol-aiAssistEnabled', enabled)
  document.head.innerHTML =
    '<meta name="ol-csrfToken" content="csrf-token-123">' +
    (enabled
      ? '<meta name="ol-aiAssistEnabled" data-type="boolean" content="">'
      : '')
}

function makeConnector(
  id: string,
  name: string,
  status: 'connected' | 'needs_auth' = 'connected'
): ConnectorView {
  return {
    id,
    name,
    url: `https://${id}.example.com/mcp`,
    enabled: true,
    status,
    tools: [],
  } as unknown as ConnectorView
}

function mockConnectors(connectors: ConnectorView[]) {
  fetchMock.get('/ai-assist/connectors', {
    connectors,
    meta: { redirectUri: 'https://overleaf.example.com/cb', clientMetadataUrl: null },
  })
}

describe('ComposerPlusMenu', function () {
  const sandbox = sinon.createSandbox()

  beforeEach(function () {
    setMeta({ enabled: true })
    fetchMock.removeRoutes().clearHistory()
    mockConnectors([
      makeConnector('conn-1', 'GitHub Docs'),
      makeConnector('conn-2', 'Zotero'),
      makeConnector('conn-3', 'Pending One', 'needs_auth'),
    ])
  })

  afterEach(function () {
    sandbox.restore()
    fetchMock.removeRoutes().clearHistory()
    for (const id of CONNECTOR_IDS) {
      setConnectorEnabledForChat(CHAT_ID, id, true)
    }
    setMeta({ enabled: false })
  })

  function renderMenu(overrides: Partial<ComposerPlusMenuProps> = {}) {
    const onClose = sandbox.stub()
    const onAddFiles = sandbox.stub()
    const onSlashCommands = sandbox.stub()

    const utils = render(
      <ComposerPlusMenu
        isOpen={true}
        onClose={onClose}
        onAddFiles={onAddFiles}
        onSlashCommands={onSlashCommands}
        chatId={CHAT_ID}
        isMac={false}
        {...overrides}
      />
    )

    return { ...utils, onClose, onAddFiles, onSlashCommands }
  }

  function connectorsItem() {
    return screen.getByText('Connectors').closest('button')!
  }

  function openWithClick() {
    fireEvent.click(connectorsItem())
    return screen.getByRole('menu', { name: 'Connectors' })
  }

  function rowFor(name: string) {
    return screen.getByRole('menuitemcheckbox', { name: new RegExp(name) })
  }

  it('renders nothing when isOpen is false', function () {
    const { container } = renderMenu({ isOpen: false })
    expect(container.firstChild).to.be.null
    expect(screen.queryByRole('menu')).to.be.null
  })

  it('renders the three action items when connectors are enabled', function () {
    renderMenu({ isOpen: true })

    expect(screen.getByText('Add files or photos')).to.exist
    expect(screen.getByText('Slash commands')).to.exist
    expect(screen.getByText('Connectors')).to.exist

    const items = screen.getAllByRole('menuitem')
    expect(items).to.have.lengthOf(3)
    items.forEach(item => {
      expect(item.className).to.include('ai-assist-plus-menu-item')
    })
  })

  it('displays shortcut badge Ctrl+U on non-Mac platforms', function () {
    renderMenu({ isOpen: true, isMac: false })
    const shortcutBadge = screen.getByText('Ctrl+U')
    expect(shortcutBadge.className).to.include('ai-assist-plus-menu-shortcut')
  })

  it('displays shortcut badge ⌘U on Mac platform', function () {
    renderMenu({ isOpen: true, isMac: true })
    expect(screen.getByText('⌘U')).to.exist
  })

  it('hides the Connectors item when the feature is disabled', function () {
    setMeta({ enabled: false })
    renderMenu({ isOpen: true })

    expect(screen.getByText('Add files or photos')).to.exist
    expect(screen.getByText('Slash commands')).to.exist
    expect(screen.queryByText('Connectors')).to.be.null
    expect(screen.getAllByRole('menuitem')).to.have.lengthOf(2)
  })

  it('marks the Connectors item as a submenu parent', function () {
    renderMenu({ isOpen: true })

    const item = connectorsItem()
    expect(item.getAttribute('aria-haspopup')).to.equal('menu')
    expect(item.getAttribute('aria-expanded')).to.equal('false')
  })

  it('calls onAddFiles and onClose when clicking "Add files or photos"', function () {
    const { onAddFiles, onClose } = renderMenu({ isOpen: true })

    fireEvent.click(screen.getByText('Add files or photos').closest('button')!)

    expect(onAddFiles).to.have.been.calledOnce
    expect(onClose).to.have.been.calledOnce
  })

  it('calls onSlashCommands and onClose when clicking "Slash commands"', function () {
    const { onSlashCommands, onClose } = renderMenu({ isOpen: true })

    fireEvent.click(screen.getByText('Slash commands').closest('button')!)

    expect(onSlashCommands).to.have.been.calledOnce
    expect(onClose).to.have.been.calledOnce
  })

  describe('Connectors submenu', function () {
    it('opens on click and keeps the menu open', async function () {
      const { onClose } = renderMenu({ isOpen: true })

      const submenu = openWithClick()

      expect(connectorsItem().getAttribute('aria-expanded')).to.equal('true')
      expect(submenu.className).to.include('ai-assist-plus-submenu')
      expect(onClose).not.to.have.been.called
      await waitFor(() => screen.getByText('GitHub Docs'))
    })

    it('opens on ArrowRight and focuses the first submenu item', function () {
      renderMenu({ isOpen: true })

      fireEvent.keyDown(connectorsItem(), { key: 'ArrowRight' })

      expect(connectorsItem().getAttribute('aria-expanded')).to.equal('true')
      expect(
        document.activeElement?.textContent?.includes('Manage connectors')
      ).to.be.true
    })

    it('opens on Enter and focuses the first submenu item', function () {
      renderMenu({ isOpen: true })

      fireEvent.keyDown(connectorsItem(), { key: 'Enter' })

      expect(connectorsItem().getAttribute('aria-expanded')).to.equal('true')
      expect(
        document.activeElement?.textContent?.includes('Manage connectors')
      ).to.be.true
    })

    it('opens on hover after a short delay', async function () {
      renderMenu({ isOpen: true })

      fireEvent.mouseEnter(connectorsItem())

      await waitFor(() =>
        expect(connectorsItem().getAttribute('aria-expanded')).to.equal('true')
      )
    })

    it('closes on ArrowLeft and returns focus to the Connectors item', function () {
      const { onClose } = renderMenu({ isOpen: true })
      openWithClick()

      fireEvent.keyDown(screen.getByText('Manage connectors'), {
        key: 'ArrowLeft',
      })

      expect(connectorsItem().getAttribute('aria-expanded')).to.equal('false')
      expect(document.activeElement).to.equal(connectorsItem())
      expect(onClose).not.to.have.been.called
    })

    it('closes only the submenu on Escape', function () {
      const { onClose } = renderMenu({ isOpen: true })
      openWithClick()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(connectorsItem().getAttribute('aria-expanded')).to.equal('false')
      expect(onClose).not.to.have.been.called
    })

    it('closes the whole menu on Escape when the submenu is closed', function () {
      const { onClose } = renderMenu({ isOpen: true })

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(onClose).to.have.been.calledOnce
    })

    it('does not close when the pointer is pressed inside the submenu', async function () {
      const { onClose } = renderMenu({ isOpen: true })
      const submenu = openWithClick()
      await waitFor(() => screen.getByText('GitHub Docs'))

      fireEvent.mouseDown(rowFor('GitHub Docs'))
      fireEvent.mouseDown(submenu)

      expect(onClose).not.to.have.been.called
    })

    it('opens the settings page in a new tab and closes the menu for "Manage connectors"', function () {
      const open = sandbox.stub(window, 'open')
      const { onClose } = renderMenu({ isOpen: true })
      openWithClick()

      fireEvent.click(screen.getByText('Manage connectors').closest('button')!)

      expect(open).to.have.been.calledOnceWith(
        '/user/settings#ai-connectors',
        '_blank',
        'noopener'
      )
      expect(onClose).to.have.been.calledOnce
    })

    it('does not offer "Browse connectors"', async function () {
      renderMenu({ isOpen: true })
      openWithClick()
      await waitFor(() => screen.getByText('GitHub Docs'))

      expect(screen.queryByText(/Browse connectors/i)).to.be.null
    })

    it('lists only connected connectors, each as a checkbox row', async function () {
      renderMenu({ isOpen: true })
      openWithClick()

      await waitFor(() => screen.getByText('GitHub Docs'))
      const rows = screen.getAllByRole('menuitemcheckbox')
      expect(rows).to.have.lengthOf(2)
      expect(screen.queryByText('Pending One')).to.be.null
      rows.forEach(row => expect(row.getAttribute('aria-checked')).to.equal('true'))
    })

    it('toggles a connector for this chat on click without closing', async function () {
      const { onClose } = renderMenu({ isOpen: true })
      openWithClick()
      await waitFor(() => screen.getByText('GitHub Docs'))

      fireEvent.click(rowFor('GitHub Docs'))

      expect(readDisabledConnectors(CHAT_ID)).to.deep.equal(['conn-1'])
      expect(rowFor('GitHub Docs').getAttribute('aria-checked')).to.equal('false')
      expect(rowFor('Zotero').getAttribute('aria-checked')).to.equal('true')
      expect(onClose).not.to.have.been.called

      fireEvent.click(rowFor('GitHub Docs'))

      expect(readDisabledConnectors(CHAT_ID)).to.deep.equal([])
      expect(rowFor('GitHub Docs').getAttribute('aria-checked')).to.equal('true')
    })

    it('toggles a connector with the Space key', async function () {
      renderMenu({ isOpen: true })
      openWithClick()
      await waitFor(() => screen.getByText('Zotero'))

      fireEvent.keyDown(rowFor('Zotero'), { key: ' ' })

      expect(readDisabledConnectors(CHAT_ID)).to.deep.equal(['conn-2'])
      expect(rowFor('Zotero').getAttribute('aria-checked')).to.equal('false')
    })

    it('shows a muted empty state when no connector is connected', async function () {
      fetchMock.removeRoutes()
      mockConnectors([makeConnector('conn-3', 'Pending One', 'needs_auth')])
      renderMenu({ isOpen: true })
      openWithClick()

      await waitFor(() =>
        screen.getByText('No connectors configured')
      )
      expect(screen.queryAllByRole('menuitemcheckbox')).to.have.lengthOf(0)
    })

    describe('placement', function () {
      const originalRect = Element.prototype.getBoundingClientRect

      function stubRects(
        menu: { left: number; right: number },
        submenu: { width: number; right: number }
      ) {
        sandbox
          .stub(Element.prototype, 'getBoundingClientRect')
          .callsFake(function (this: Element) {
            if (this.classList.contains('ai-assist-plus-submenu')) {
              const left = submenu.right - submenu.width
              return { left, right: submenu.right, width: submenu.width } as DOMRect
            }
            if (this.classList.contains('ai-assist-plus-menu')) {
              return {
                left: menu.left,
                right: menu.right,
                width: menu.right - menu.left,
              } as DOMRect
            }
            return originalRect.call(this)
          })
      }

      it('opens to the right when there is room', function () {
        stubRects({ left: 300, right: 500 }, { width: 200, right: 704 })
        renderMenu({ isOpen: true })
        openWithClick()

        const submenu = screen.getByRole('menu', { name: 'Connectors' })
        expect(submenu.className).not.to.include('ai-assist-plus-submenu--')
      })

      it('flips to the left when the right side overflows', function () {
        stubRects({ left: 300, right: 500 }, { width: 200, right: 1100 })
        renderMenu({ isOpen: true })
        openWithClick()

        const submenu = screen.getByRole('menu', { name: 'Connectors' })
        expect(submenu.className).to.include('ai-assist-plus-submenu--left')
      })

      it('drops below when neither side fits', function () {
        stubRects({ left: 100, right: 300 }, { width: 200, right: 1100 })
        renderMenu({ isOpen: true })
        openWithClick()

        const submenu = screen.getByRole('menu', { name: 'Connectors' })
        expect(submenu.className).to.include('ai-assist-plus-submenu--below')
      })
    })
  })
})
