import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import DefaultNavbar from '@/shared/components/navbar/default-navbar'
import type { DefaultNavbarMetadata } from '@/shared/components/types/default-navbar-metadata'

// Shape of the item the template-gallery module injects into
// Settings.nav.header_extras, after cloneAndTranslateText on the server
const templatesItem = {
  text: 'templates',
  translatedText: 'Templates',
  url: '/latex/templates',
  class: 'subdued',
  trackingKey: 'templates',
}

const baseProps: DefaultNavbarMetadata = {
  canDisplayAdminMenu: false,
  canDisplayAdminRedirect: false,
  canDisplayProjectUrlLookup: false,
  canDisplaySplitTestMenu: false,
  canDisplaySurveyMenu: false,
  canDisplayScriptLogMenu: false,
  enableUpgradeButton: false,
  suppressNavbarRight: false,
  suppressNavContentLinks: false,
  showSubscriptionLink: false,
  showSignUpLink: true,
  currentUrl: '/project',
  items: [],
}

function openAdminMenu() {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Admin' }))
}

describe('template-gallery navbar integration', function () {
  beforeEach(function () {
    window.metaAttributesCache.set('ol-user', {})
  })

  describe('top-level Templates item', function () {
    it('renders the injected header_extras item like overleaf.com', function () {
      render(<DefaultNavbar {...baseProps} items={[templatesItem]} />)
      const link = screen.getByRole('menuitem', { name: 'Templates' })
      expect(link.getAttribute('href')).to.equal('/latex/templates')
      expect(link.classList.contains('nav-link')).to.be.true
      const li = link.closest('li')!
      expect(li.classList.contains('subdued')).to.be.true
      expect(li.getAttribute('role')).to.equal('none')
    })

    it('renders it for logged-in users too', function () {
      render(
        <DefaultNavbar
          {...baseProps}
          sessionUser={{ email: 'user@example.com' }}
          items={[templatesItem]}
        />
      )
      screen.getByRole('menuitem', { name: 'Templates' })
    })

    it('renders nothing when the module did not inject the item', function () {
      render(<DefaultNavbar {...baseProps} />)
      expect(screen.queryByRole('menuitem', { name: 'Templates' })).to.be.null
    })
  })

  describe('admin menu', function () {
    it('shows Manage Templates when canDisplayAdminTemplates is set', function () {
      render(
        <DefaultNavbar
          {...baseProps}
          sessionUser={{ email: 'admin@example.com' }}
          canDisplayAdminMenu
          canDisplayAdminTemplates
        />
      )
      openAdminMenu()
      const link = screen.getByRole('menuitem', { name: 'Manage Templates' })
      expect(link.getAttribute('href')).to.equal('/admin/templates')
    })

    it('hides Manage Templates when the feature is off', function () {
      render(
        <DefaultNavbar
          {...baseProps}
          sessionUser={{ email: 'admin@example.com' }}
          canDisplayAdminMenu
          canDisplayAdminTemplates={false}
        />
      )
      openAdminMenu()
      screen.getByRole('menuitem', { name: 'Manage Site' })
      expect(screen.queryByRole('menuitem', { name: 'Manage Templates' })).to.be
        .null
    })

    it('does not show Manage Templates to non site admins', function () {
      render(
        <DefaultNavbar
          {...baseProps}
          sessionUser={{ email: 'user@example.com' }}
          canDisplayAdminRedirect
          adminUrl="https://admin.example.com"
          canDisplayAdminTemplates
        />
      )
      openAdminMenu()
      screen.getByRole('menuitem', { name: 'Switch to Admin' })
      expect(screen.queryByRole('menuitem', { name: 'Manage Templates' })).to.be
        .null
    })
  })
})
