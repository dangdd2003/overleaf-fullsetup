import { useState } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import { postJSON } from '@/infrastructure/fetch-json'

export interface EmailEntry {
  email: string
  confirmedAt?: string | Date
  default?: boolean
}

export interface AdminUserEmailsCardProps {
  userId: string
  primaryEmail: string
  emails?: EmailEntry[]
  onUserUpdated: (user: any) => void
  onError: (err: string) => void
  onSuccess: (msg: string) => void
}

export default function AdminUserEmailsCard({
  userId,
  primaryEmail,
  emails = [],
  onUserUpdated,
  onError,
  onSuccess,
}: AdminUserEmailsCardProps) {
  const [newEmail, setNewEmail] = useState('')
  const [isAdding, setIsAdding] = useState(false)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const primaryItem = emails.find(
    e => e.email === primaryEmail || Boolean(e.default)
  )
  const isPrimaryConfirmed = Boolean(primaryItem?.confirmedAt)

  const secondaryEmails = emails.filter(
    e => e.email !== primaryEmail && !e.default
  )

  async function handleAddEmail(e: React.FormEvent) {
    e.preventDefault()
    const trimmedEmail = newEmail.trim()
    if (!trimmedEmail) return

    setIsAdding(true)
    try {
      const res = await postJSON<{
        success: boolean
        user: any
        error?: string
      }>(`/admin/users/api/users/${userId}/emails/add`, {
        body: { email: trimmedEmail },
      })
      if (res.error) {
        onError(res.error)
      } else {
        setNewEmail('')
        onUserUpdated(res.user)
        onSuccess(`Added secondary email ${trimmedEmail} successfully.`)
      }
    } catch (err: any) {
      onError(err?.message || 'Failed to add secondary email')
    } finally {
      setIsAdding(false)
    }
  }

  async function handleSetPrimary(email: string) {
    setActionInProgress(`primary-${email}`)
    try {
      const res = await postJSON<{
        success: boolean
        user: any
        error?: string
      }>(`/admin/users/api/users/${userId}/emails/set-primary`, {
        body: { email },
      })
      if (res.error) {
        onError(res.error)
      } else {
        onUserUpdated(res.user)
        onSuccess(`Set ${email} as primary email successfully.`)
      }
    } catch (err: any) {
      onError(err?.message || 'Failed to set primary email')
    } finally {
      setActionInProgress(null)
    }
  }

  async function handleRemove(email: string) {
    setActionInProgress(`remove-${email}`)
    try {
      const res = await postJSON<{
        success: boolean
        user: any
        error?: string
      }>(`/admin/users/api/users/${userId}/emails/remove`, {
        body: { email },
      })
      if (res.error) {
        onError(res.error)
      } else {
        onUserUpdated(res.user)
        onSuccess(`Removed email ${email} successfully.`)
      }
    } catch (err: any) {
      onError(err?.message || 'Failed to remove email')
    } finally {
      setActionInProgress(null)
    }
  }

  return (
    <div className="admin-user-emails-section">
      <span className="form-label d-block mb-2 fw-bold">
        Registered Email Addresses
      </span>
      <ul className="list-group list-group-flush border rounded mb-3">
        <li className="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <strong>{primaryEmail}</strong>
            <OLBadge bg="primary">Primary</OLBadge>
            {isPrimaryConfirmed ? (
              <OLBadge bg="success">Confirmed</OLBadge>
            ) : (
              <OLBadge bg="warning">Unconfirmed</OLBadge>
            )}
          </div>
        </li>
        {secondaryEmails.map(e => (
          <li
            key={e.email}
            className="list-group-item d-flex justify-content-between align-items-center flex-wrap gap-2"
          >
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <span>{e.email}</span>
              {e.confirmedAt ? (
                <OLBadge bg="success">Confirmed</OLBadge>
              ) : (
                <OLBadge bg="warning">Unconfirmed</OLBadge>
              )}
            </div>
            <div className="d-flex align-items-center gap-2">
              <OLButton
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => handleSetPrimary(e.email)}
                disabled={isAdding || actionInProgress !== null}
                isLoading={actionInProgress === `primary-${e.email}`}
                loadingLabel="Setting..."
              >
                Make Primary
              </OLButton>
              <OLButton
                type="button"
                size="sm"
                variant="danger"
                onClick={() => handleRemove(e.email)}
                disabled={isAdding || actionInProgress !== null}
                isLoading={actionInProgress === `remove-${e.email}`}
                loadingLabel="Removing..."
              >
                Remove
              </OLButton>
            </div>
          </li>
        ))}
      </ul>
      <OLForm onSubmit={handleAddEmail} className="d-flex gap-2">
        <OLFormControl
          type="email"
          placeholder="Add secondary email address..."
          value={newEmail}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setNewEmail(e.target.value)
          }
          disabled={isAdding || actionInProgress !== null}
        />
        <OLButton
          type="submit"
          variant="primary"
          isLoading={isAdding}
          loadingLabel="Adding..."
          disabled={!newEmail.trim() || isAdding || actionInProgress !== null}
          className="text-nowrap"
        >
          Add Email
        </OLButton>
      </OLForm>
    </div>
  )
}
