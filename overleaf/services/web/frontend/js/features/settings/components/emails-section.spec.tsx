/* eslint-disable @typescript-eslint/no-unused-expressions */
import { render, screen, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import fetchMock from 'fetch-mock'
import * as MetaUtil from '../../../utils/meta'
import EmailsSection from './emails-section'

describe('EmailsSection feature gating', () => {
  afterEach(() => {
    sinon.restore()
    fetchMock.removeRoutes().clearHistory()
  })

  it('returns null when both affiliations and adminUserManagement are disabled', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false, hasAdminUserManagement: false }
      }
      if (key === 'ol-adminUserManagementEnabled') return false
      return null
    })

    const { container } = render(<EmailsSection />)
    expect(container.firstChild).to.be.null
  })

  it('renders simplified emails interface when adminUserManagement is enabled and affiliations is disabled', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false, hasAdminUserManagement: true }
      }
      if (key === 'ol-adminUserManagementEnabled') return true
      return null
    })

    render(<EmailsSection />)
    expect(screen.getByText('Emails')).to.exist
    expect(screen.queryByText('Emails and affiliations')).to.not.exist
  })

  it('renders simplified emails interface when adminUserManagement is enabled via ol-adminUserManagementEnabled only', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false }
      }
      if (key === 'ol-adminUserManagementEnabled') return true
      return null
    })

    render(<EmailsSection />)
    expect(screen.getByText('Emails')).to.exist
    expect(screen.queryByText('Emails and affiliations')).to.not.exist
  })

  it('renders standard affiliations interface when affiliations is enabled even if adminUserManagement is enabled', () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: true, hasAdminUserManagement: true }
      }
      if (key === 'ol-adminUserManagementEnabled') return true
      return null
    })

    render(<EmailsSection />)
    expect(screen.getByText('Emails and affiliations')).to.exist
  })

  it('renders SimpleEmailsHeader and SimpleAddEmailForm in simplified mode', async () => {
    sinon.stub(MetaUtil, 'default').callsFake((key: string) => {
      if (key === 'ol-ExposedSettings') {
        return { hasAffiliationsFeature: false, hasAdminUserManagement: true }
      }
      if (key === 'ol-adminUserManagementEnabled') return true
      return null
    })

    fetchMock.get('/user/emails?ensureAffiliation=true', [
      {
        email: 'user@example.com',
        default: true,
        confirmedAt: new Date().toISOString(),
      },
    ])

    render(<EmailsSection />)

    // SimpleEmailsHeader has Email and Actions, but not Institution and role
    expect(screen.getByText('Email')).to.exist
    expect(screen.getByText('Actions')).to.exist
    expect(screen.queryByText('Institution and role')).to.not.exist

    // After loading, SimpleAddEmailForm shows "+ Add another email"
    await waitFor(() => {
      expect(screen.getByText('user@example.com')).to.exist
      expect(screen.getByText('Add another email')).to.exist
    })
  })
})
