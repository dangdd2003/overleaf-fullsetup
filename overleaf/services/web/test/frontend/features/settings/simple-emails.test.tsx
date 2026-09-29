import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect } from 'chai'
import sinon from 'sinon'
import * as FetchJson from '@/infrastructure/fetch-json'
import SimpleEmailsHeader from '@/features/settings/components/emails/simple-emails-header'
import SimpleEmailsRow from '@/features/settings/components/emails/simple-emails-row'
import SimpleAddEmailForm from '@/features/settings/components/emails/simple-add-email-form'
import { UserEmailsContext } from '@/features/settings/context/user-email-context'
import { UserEmailData } from '../../../../types/user-email'

const mockContextValue = (overrides = {}) => ({
  state: {
    isLoading: false,
    data: {
      byId: {},
      emailCount: 2,
      linkedInstitutionIds: [],
      emailAffiliationBeingEdited: null,
    },
  },
  isInitializing: false,
  isInitializingSuccess: true,
  isInitializingError: false,
  getEmails: sinon.stub(),
  setLoading: sinon.stub(),
  makePrimary: sinon.stub(),
  deleteEmail: sinon.stub(),
  ...overrides,
})

describe('SimpleEmailsHeader', function () {
  it('renders Email and Actions columns without institution_and_role', function () {
    render(<SimpleEmailsHeader />)
    expect(screen.getByText('Email')).to.exist
    expect(screen.getByText('Actions')).to.exist
    expect(screen.queryByText('Institution and role')).to.not.exist
  })
})

describe('SimpleEmailsRow', function () {
  const primaryEmail: UserEmailData = {
    email: 'primary@example.com',
    default: true,
    confirmedAt: new Date().toISOString(),
  }

  const secondaryEmail: UserEmailData = {
    email: 'secondary@example.com',
    default: false,
    confirmedAt: new Date().toISOString(),
  }

  const unconfirmedEmail: UserEmailData = {
    email: 'unconfirmed@example.com',
    default: false,
  }

  it('renders primary email with Primary badge and disabled delete button', function () {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleEmailsRow userEmailData={primaryEmail} primary={primaryEmail} />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('primary@example.com')).to.exist
    expect(screen.getByText('Primary')).to.exist
    expect(screen.queryByText('Make primary')).to.not.exist

    const deleteBtn = screen.getByRole('button', { name: 'Remove' })
    expect(deleteBtn).to.exist
    expect((deleteBtn as HTMLButtonElement).disabled).to.be.true
  })

  it('renders secondary email with Make primary button and enabled delete button', function () {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleEmailsRow userEmailData={secondaryEmail} primary={primaryEmail} />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('secondary@example.com')).to.exist
    expect(screen.getByText('Make primary')).to.exist

    const deleteBtn = screen.getByRole('button', { name: 'Remove' })
    expect(deleteBtn).to.exist
    expect((deleteBtn as HTMLButtonElement).disabled).to.be.false
  })

  it('renders unconfirmed secondary email with Unconfirmed text', function () {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleEmailsRow userEmailData={unconfirmedEmail} primary={primaryEmail} />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('unconfirmed@example.com')).to.exist
    expect(screen.getByText('(Unconfirmed)')).to.exist
  })
})

describe('SimpleAddEmailForm', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('shows "+ Add another email" button initially', function () {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    expect(screen.getByText('Add another email')).to.exist
  })

  it('shows limit reached message when email count >= limit', function () {
    const ctx = mockContextValue({
      state: {
        isLoading: false,
        data: {
          byId: {},
          emailCount: 10,
          linkedInstitutionIds: [],
          emailAffiliationBeingEdited: null,
        },
      },
    })
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    expect(screen.queryByText('Add another email')).to.not.exist
    expect(screen.getByText(/maximum of/i)).to.exist
    expect(screen.getByText(/10 email addresses/i)).to.exist
  })

  it('expands form on click and cancels when Cancel is clicked', function () {
    const ctx = mockContextValue()
    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))
    expect(screen.getByPlaceholderText('name@example.com')).to.exist

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('name@example.com')).to.not.exist
    expect(screen.getByText('Add another email')).to.exist
  })

  it('shows error when submitting invalid email and does not call postJSON', async function () {
    const postJsonStub = sinon.stub(FetchJson, 'postJSON')
    const ctx = mockContextValue()

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))
    const input = screen.getByPlaceholderText('name@example.com')

    fireEvent.change(input, { target: { value: 'invalid-email' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    expect(screen.getByText('Please enter a valid email address.')).to.exist
    expect(postJsonStub.called).to.be.false
  })

  it('expands form on click and submits to /user/emails/secondary', async function () {
    const postJsonStub = sinon.stub(FetchJson, 'postJSON').resolves({
      success: true,
      email: 'new@example.com',
    })
    const getEmailsStub = sinon.stub()
    const ctx = mockContextValue({ getEmails: getEmailsStub })

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))

    const input = screen.getByPlaceholderText('name@example.com')
    expect(input).to.exist

    fireEvent.change(input, { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await waitFor(() => {
      expect(
        postJsonStub.calledWith('/user/emails/secondary', {
          body: { email: 'new@example.com' },
        })
      ).to.be.true
      expect(getEmailsStub.calledOnce).to.be.true
    })

    expect(screen.getByText('Secondary email added successfully.')).to.exist
    expect(screen.queryByPlaceholderText('name@example.com')).to.not.exist
  })

  it('handles email_already_registered error', async function () {
    sinon.stub(FetchJson, 'postJSON').rejects({
      data: { error: 'email_already_registered' },
    })
    const ctx = mockContextValue()

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))
    const input = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(input, { target: { value: 'existing@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          /already (associated with a different Overleaf account|registered)/i
        )
      ).to.exist
    })
  })

  it('handles email_limit_exceeded error', async function () {
    sinon.stub(FetchJson, 'postJSON').rejects({
      data: { error: 'email_limit_exceeded' },
    })
    const ctx = mockContextValue()

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))
    const input = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(input, { target: { value: 'limit@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await waitFor(() => {
      expect(
        screen.getByText(/maximum of.*email addresses|limit reached/i)
      ).to.exist
    })
  })

  it('handles generic error', async function () {
    sinon.stub(FetchJson, 'postJSON').rejects({
      data: { error: 'unknown_error' },
    })
    const ctx = mockContextValue()

    render(
      <UserEmailsContext.Provider value={ctx as any}>
        <SimpleAddEmailForm />
      </UserEmailsContext.Provider>
    )

    fireEvent.click(screen.getByText('Add another email'))
    const input = screen.getByPlaceholderText('name@example.com')
    fireEvent.change(input, { target: { value: 'error@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          /An error (has occurred while performing your request|occurred while adding email)/i
        )
      ).to.exist
    })
  })
})
