import { useState, useRef } from 'react'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLTable from '@/shared/components/ol/ol-table'
import OLBadge from '@/shared/components/ol/ol-badge'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import Notification from '@/shared/components/notification'
import MaterialIcon from '@/shared/components/material-icon'
import { postJSON } from '@/infrastructure/fetch-json'
import { copyTextToClipboard } from '../utils/clipboard'

export interface CreateUsersModalProps {
  show: boolean
  onHide: () => void
  onSuccess: (msg?: string) => void
}

interface BulkUserRow {
  id: string
  email: string
  first_name: string
  last_name: string
  password: string
  isAdmin: boolean
}

interface BulkCreateResult {
  success: boolean
  summary: {
    total: number
    createdCount: number
    skippedCount: number
    failedCount: number
  }
  created: Array<{
    _id: string
    email: string
    first_name?: string
    last_name?: string
    isAdmin?: boolean
    passwordSet?: boolean
    setupUrl?: string | null
  }>
  skipped: Array<{
    email: string
    reason: string
  }>
  failed: Array<{
    email: string
    reason: string
  }>
}

function createEmptyRow(): BulkUserRow {
  return {
    id: Math.random().toString(36).substring(2, 9),
    email: '',
    first_name: '',
    last_name: '',
    password: '',
    isAdmin: false,
  }
}

export default function CreateUsersModal({
  show,
  onHide,
  onSuccess,
}: CreateUsersModalProps) {
  const [tab, setTab] = useState<'single' | 'bulk'>('single')

  // Single User State
  const [singleEmail, setSingleEmail] = useState('')
  const [singleFirstName, setSingleFirstName] = useState('')
  const [singleLastName, setSingleLastName] = useState('')
  const [singlePassword, setSinglePassword] = useState('')
  const [singleIsAdmin, setSingleIsAdmin] = useState(false)

  // Bulk State
  const [bulkRows, setBulkRows] = useState<BulkUserRow[]>([createEmptyRow()])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Submission & Result State
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BulkCreateResult | null>(null)
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({})

  function handleReset() {
    setTab('single')
    setSingleEmail('')
    setSingleFirstName('')
    setSingleLastName('')
    setSinglePassword('')
    setSingleIsAdmin(false)
    setBulkRows([createEmptyRow()])
    setIsSubmitting(false)
    setError(null)
    setResult(null)
    setCopiedMap({})
  }

  function handleClose() {
    handleReset()
    onHide()
  }

  function handleDone() {
    const createdCount = result?.summary?.createdCount ?? 0
    const msg =
      createdCount > 0
        ? `Successfully created ${createdCount} user account(s).`
        : undefined
    handleReset()
    onSuccess(msg)
  }

  // Row management for bulk mode
  function handleAddRow() {
    setBulkRows(prev => [...prev, createEmptyRow()])
  }

  function handleDeleteRow(id: string) {
    setBulkRows(prev => (prev.length > 1 ? prev.filter(r => r.id !== id) : prev))
  }

  function handleUpdateRow(
    id: string,
    field: keyof BulkUserRow,
    value: string | boolean
  ) {
    setBulkRows(prev =>
      prev.map(row => (row.id === id ? { ...row, [field]: value } : row))
    )
  }

  // CSV parsing
  function parseCSV(text: string): BulkUserRow[] {
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
    if (lines.length === 0) return []

    function splitCSVLine(line: string): string[] {
      const parts: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"'
            i++
          } else {
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          parts.push(cur.trim())
          cur = ''
        } else {
          cur += char
        }
      }
      parts.push(cur.trim())
      return parts
    }

    const firstRow = splitCSVLine(lines[0])
    const lowerFirstRow = firstRow.map(h =>
      h.toLowerCase().replace(/[\s_-]/g, '')
    )

    let hasHeader = false
    let emailIdx = -1
    let firstIdx = -1
    let lastIdx = -1
    let passIdx = -1
    let adminIdx = -1

    if (lowerFirstRow.some(h => h.includes('email'))) {
      hasHeader = true
      lowerFirstRow.forEach((h, idx) => {
        if (h === 'email' || h.includes('email')) emailIdx = idx
        else if (h === 'firstname' || h === 'first') firstIdx = idx
        else if (h === 'lastname' || h === 'last') lastIdx = idx
        else if (h === 'password' || h === 'pass') passIdx = idx
        else if (h === 'isadmin' || h === 'admin') adminIdx = idx
      })
    }

    const dataLines = hasHeader ? lines.slice(1) : lines
    const parsed: BulkUserRow[] = []

    for (const line of dataLines) {
      const cols = splitCSVLine(line)
      if (cols.every(c => !c)) continue

      let email = ''
      let firstName = ''
      let lastName = ''
      let password = ''
      let isAdmin = false

      if (hasHeader) {
        if (emailIdx !== -1 && cols[emailIdx]) email = cols[emailIdx]
        if (firstIdx !== -1 && cols[firstIdx]) firstName = cols[firstIdx]
        if (lastIdx !== -1 && cols[lastIdx]) lastName = cols[lastIdx]
        if (passIdx !== -1 && cols[passIdx]) password = cols[passIdx]
        if (adminIdx !== -1 && cols[adminIdx]) {
          const val = cols[adminIdx].toLowerCase()
          isAdmin =
            val === 'true' || val === '1' || val === 'yes' || val === 'y'
        }
      } else {
        email = cols[0] || ''
        firstName = cols[1] || ''
        lastName = cols[2] || ''
        password = cols[3] || ''
        if (cols[4]) {
          const val = cols[4].toLowerCase()
          isAdmin =
            val === 'true' || val === '1' || val === 'yes' || val === 'y'
        }
      }

      if (email || firstName || lastName) {
        parsed.push({
          id: Math.random().toString(36).substring(2, 9),
          email,
          first_name: firstName,
          last_name: lastName,
          password,
          isAdmin,
        })
      }
    }

    return parsed
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = evt => {
      const text = (evt.target?.result as string) || ''
      const rows = parseCSV(text)
      if (rows.length > 0) {
        setBulkRows(prev =>
          prev.length === 1 && !prev[0].email.trim() ? rows : [...prev, ...rows]
        )
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  // Submit Handler
  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault()
    setError(null)

    let usersToSubmit: Array<{
      email: string
      first_name?: string
      last_name?: string
      password?: string
      isAdmin?: boolean
    }> = []

    if (tab === 'single') {
      const emailTrimmed = singleEmail.trim()
      if (!emailTrimmed) {
        setError('Please provide a valid email address.')
        return
      }
      usersToSubmit = [
        {
          email: emailTrimmed,
          first_name: singleFirstName.trim(),
          last_name: singleLastName.trim(),
          password: singlePassword.trim(),
          isAdmin: singleIsAdmin,
        },
      ]
    } else {
      const validRows = bulkRows
        .map(r => ({
          email: r.email.trim(),
          first_name: r.first_name.trim(),
          last_name: r.last_name.trim(),
          password: r.password.trim(),
          isAdmin: Boolean(r.isAdmin),
        }))
        .filter(r => r.email.length > 0)

      if (validRows.length === 0) {
        setError('Please enter at least one user with a valid email address.')
        return
      }
      usersToSubmit = validRows
    }

    setIsSubmitting(true)

    try {
      const res = await postJSON<BulkCreateResult & { error?: string }>(
        '/admin/users/api/users/bulk-create',
        {
          body: { users: usersToSubmit },
        }
      )

      if (res.error) {
        setError(res.error)
      } else {
        setResult(res)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to create users')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Copy Link Handler
  function handleCopySetupUrl(url: string, key: string) {
    copyTextToClipboard(url)
    setCopiedMap(prev => ({ ...prev, [key]: true }))
    setTimeout(() => {
      setCopiedMap(prev => ({ ...prev, [key]: false }))
    }, 3000)
  }

  // Export Results as CSV
  function handleExportResultsCSV() {
    if (!result) return

    const rows: string[][] = [
      ['Email', 'First Name', 'Last Name', 'Admin', 'Status', 'Setup URL'],
    ]

    for (const u of result.created) {
      rows.push([
        u.email,
        u.first_name || '',
        u.last_name || '',
        u.isAdmin ? 'true' : 'false',
        'Created',
        u.setupUrl || 'Password Set',
      ])
    }

    for (const s of result.skipped) {
      rows.push([s.email, '', '', 'false', `Skipped (${s.reason})`, ''])
    }

    for (const f of result.failed) {
      rows.push([f.email, '', '', 'false', `Failed (${f.reason})`, ''])
    }

    const csvContent =
      '\uFEFF' +
      rows
        .map(row =>
          row
            .map(val => {
              const str = val === undefined || val === null ? '' : String(val)
              const escaped = str.replace(/"/g, '""')
              return `"${escaped}"`
            })
            .join(',')
        )
        .join('\r\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute(
      'download',
      `created_users_${new Date().toISOString().slice(0, 10)}.csv`
    )
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <OLModal show={show} onHide={handleClose} size="lg">
      <OLModalHeader closeButton>
        <OLModalTitle>
          {result ? 'User Creation Summary' : 'Add New Users'}
        </OLModalTitle>
      </OLModalHeader>

      <OLModalBody>
        {error ? (
          <Notification type="error" content={error} className="mb-3" />
        ) : null}

        {result ? (
          /* ================= Summary / Result View ================= */
          <div>
            <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
              <OLBadge bg="success">
                Created: {result.summary.createdCount}
              </OLBadge>
              <OLBadge bg="warning">
                Skipped (Already exists): {result.summary.skippedCount}
              </OLBadge>
              {result.summary.failedCount > 0 ? (
                <OLBadge bg="danger">
                  Failed: {result.summary.failedCount}
                </OLBadge>
              ) : null}
            </div>

            {result.created.length > 0 ? (
              <div className="mb-4">
                <h6 className="fw-bold mb-2">Created Accounts</h6>
                <div
                  className="table-responsive border rounded"
                  style={{ maxHeight: '320px', overflowY: 'auto' }}
                >
                  <OLTable
                    className="table-hover mb-0 align-middle"
                    style={{ tableLayout: 'fixed', width: '100%' }}
                  >
                    <thead className="table-light sticky-top">
                      <tr>
                        <th style={{ width: '32%' }}>Email</th>
                        <th style={{ width: '22%' }}>Name</th>
                        <th style={{ width: '12%' }}>Role</th>
                        <th style={{ width: '34%' }}>Status / Setup URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.created.map(u => {
                        const fullName = [u.first_name, u.last_name]
                          .filter(Boolean)
                          .join(' ')
                        const itemKey = u._id || u.email
                        const isCopied = Boolean(copiedMap[itemKey])

                        return (
                          <tr key={itemKey}>
                            <td
                              className="fw-bold text-truncate"
                              title={u.email}
                            >
                              {u.email}
                            </td>
                            <td className="text-truncate" title={fullName}>
                              {fullName || (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td>
                              {u.isAdmin ? (
                                <OLBadge bg="primary">Admin</OLBadge>
                              ) : (
                                <OLBadge
                                  bg="light"
                                  text="dark"
                                  className="border"
                                >
                                  User
                                </OLBadge>
                              )}
                            </td>
                            <td>
                              {u.setupUrl ? (
                                <div
                                  className="git-bridge-copy my-1 d-flex align-items-center justify-content-between"
                                  style={{ margin: 0, padding: '4px 8px' }}
                                >
                                  <code
                                    className="small text-truncate"
                                    style={{
                                      minWidth: 0,
                                      flex: '1 1 auto',
                                      display: 'inline-block',
                                    }}
                                    title={u.setupUrl}
                                  >
                                    {u.setupUrl}
                                  </code>
                                  <button
                                    type="button"
                                    className="git-copy-pill-btn"
                                    style={{
                                      minWidth: '78px',
                                      width: '78px',
                                      flexShrink: 0,
                                      textAlign: 'center',
                                      padding: '2px 8px',
                                    }}
                                    onClick={() =>
                                      handleCopySetupUrl(u.setupUrl!, itemKey)
                                    }
                                    aria-label={isCopied ? 'Copied' : 'Copy'}
                                  >
                                    {isCopied ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                              ) : (
                                <OLBadge bg="success">
                                  Password Configured
                                </OLBadge>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </OLTable>
                </div>
              </div>
            ) : null}

            {result.skipped.length > 0 ? (
              <div className="mb-3">
                <h6 className="fw-bold mb-2 text-warning">
                  Skipped Accounts (Already exist)
                </h6>
                <ul className="list-group list-group-flush border rounded mb-0">
                  {result.skipped.map((s, idx) => (
                    <li
                      key={idx}
                      className="list-group-item d-flex justify-content-between align-items-center py-2"
                    >
                      <span className="fw-semibold">{s.email}</span>
                      <small className="text-muted">{s.reason}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.failed.length > 0 ? (
              <div className="mb-3">
                <h6 className="fw-bold mb-2 text-danger">Failed Accounts</h6>
                <ul className="list-group list-group-flush border rounded mb-0">
                  {result.failed.map((f, idx) => (
                    <li
                      key={idx}
                      className="list-group-item d-flex justify-content-between align-items-center py-2 text-danger"
                    >
                      <span>{f.email}</span>
                      <small>{f.reason}</small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          /* ================= Input Form View ================= */
          <div>
            <div className="ol-tabs mb-3">
              <div className="nav-tabs-container">
                <ul className="nav nav-tabs align-left" role="tablist">
                  <li role="presentation">
                    <button
                      type="button"
                      role="tab"
                      className={`nav-link ${tab === 'single' ? 'active' : ''} d-inline-flex align-items-center gap-2`}
                      aria-selected={tab === 'single'}
                      onClick={() => setTab('single')}
                    >
                      <MaterialIcon type="person" />
                      <span>Single User</span>
                    </button>
                  </li>
                  <li role="presentation">
                    <button
                      type="button"
                      role="tab"
                      className={`nav-link ${tab === 'bulk' ? 'active' : ''} d-inline-flex align-items-center gap-2`}
                      aria-selected={tab === 'bulk'}
                      onClick={() => setTab('bulk')}
                    >
                      <MaterialIcon type="group" />
                      <span>Bulk &amp; CSV Import</span>
                    </button>
                  </li>
                </ul>
              </div>
            </div>

            {tab === 'single' ? (
              <OLForm onSubmit={handleSubmit}>
                <OLFormGroup className="mb-3">
                  <OLFormLabel htmlFor="single-user-email">
                    Email Address <span className="text-danger">*</span>
                  </OLFormLabel>
                  <OLFormControl
                    id="single-user-email"
                    type="email"
                    placeholder="user@example.com"
                    value={singleEmail}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSingleEmail(e.target.value)
                    }
                    required
                  />
                </OLFormGroup>

                <OLRow className="g-3 mb-3">
                  <OLCol md={6}>
                    <OLFormGroup>
                      <OLFormLabel htmlFor="single-first-name">
                        First Name
                      </OLFormLabel>
                      <OLFormControl
                        id="single-first-name"
                        type="text"
                        placeholder="First name"
                        value={singleFirstName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setSingleFirstName(e.target.value)
                        }
                      />
                    </OLFormGroup>
                  </OLCol>
                  <OLCol md={6}>
                    <OLFormGroup>
                      <OLFormLabel htmlFor="single-last-name">
                        Last Name
                      </OLFormLabel>
                      <OLFormControl
                        id="single-last-name"
                        type="text"
                        placeholder="Last name"
                        value={singleLastName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setSingleLastName(e.target.value)
                        }
                      />
                    </OLFormGroup>
                  </OLCol>
                </OLRow>

                <OLFormGroup className="mb-3">
                  <OLFormLabel htmlFor="single-password">
                    Password (Optional)
                  </OLFormLabel>
                  <OLFormControl
                    id="single-password"
                    type="password"
                    placeholder="Leave blank to generate a 7-day password setup link"
                    value={singlePassword}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSinglePassword(e.target.value)
                    }
                  />
                  <small className="form-text text-muted d-block mt-1">
                    If password is provided, user can log in immediately. If
                    left blank, a 7-day password setup link is generated.
                  </small>
                </OLFormGroup>

                <div className="mb-3">
                  <OLFormCheckbox
                    id="single-is-admin"
                    type="checkbox"
                    label="Grant Site Administrator Privileges"
                    checked={singleIsAdmin}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSingleIsAdmin(e.target.checked)
                    }
                  />
                  <small className="text-muted d-block mt-1">
                    Site administrators have complete administrative control
                    over all projects and users.
                  </small>
                </div>
              </OLForm>
            ) : (
              <div>
                <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                  <div>
                    <p className="text-muted small mb-0">
                      Enter users below or import a <code>.csv</code> file (headers:{' '}
                      <code>email, first_name, last_name, password, isAdmin</code>).
                    </p>
                  </div>
                  <div className="d-flex align-items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="d-none"
                      onChange={handleFileUpload}
                    />
                    <OLButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      leadingIcon="upload"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Import CSV
                    </OLButton>
                    <OLButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      leadingIcon="add"
                      onClick={handleAddRow}
                    >
                      Add Row
                    </OLButton>
                  </div>
                </div>

                <div
                  className="table-responsive border rounded mb-3"
                  style={{ maxHeight: '350px', overflowY: 'auto' }}
                >
                  <OLTable className="table-hover mb-0 align-middle">
                    <thead className="table-light sticky-top">
                      <tr>
                        <th style={{ minWidth: '180px' }}>
                          Email <span className="text-danger">*</span>
                        </th>
                        <th style={{ minWidth: '120px' }}>First Name</th>
                        <th style={{ minWidth: '120px' }}>Last Name</th>
                        <th style={{ minWidth: '130px' }}>Password</th>
                        <th style={{ width: '70px' }} className="text-center">
                          Admin
                        </th>
                        <th style={{ width: '40px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkRows.map((row, idx) => (
                        <tr key={row.id}>
                          <td>
                            <OLFormControl
                              size="sm"
                              type="email"
                              placeholder="user@example.com"
                              value={row.email}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>
                              ) =>
                                handleUpdateRow(
                                  row.id,
                                  'email',
                                  e.target.value
                                )
                              }
                              required={idx === 0}
                            />
                          </td>
                          <td>
                            <OLFormControl
                              size="sm"
                              type="text"
                              placeholder="First"
                              value={row.first_name}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>
                              ) =>
                                handleUpdateRow(
                                  row.id,
                                  'first_name',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td>
                            <OLFormControl
                              size="sm"
                              type="text"
                              placeholder="Last"
                              value={row.last_name}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>
                              ) =>
                                handleUpdateRow(
                                  row.id,
                                  'last_name',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td>
                            <OLFormControl
                              size="sm"
                              type="password"
                              placeholder="Optional"
                              value={row.password}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>
                              ) =>
                                handleUpdateRow(
                                  row.id,
                                  'password',
                                  e.target.value
                                )
                              }
                            />
                          </td>
                          <td className="text-center">
                            <input
                              type="checkbox"
                              className="form-check-input"
                              checked={row.isAdmin}
                              onChange={(
                                e: React.ChangeEvent<HTMLInputElement>
                              ) =>
                                handleUpdateRow(
                                  row.id,
                                  'isAdmin',
                                  e.target.checked
                                )
                              }
                            />
                          </td>
                          <td className="text-center">
                            <button
                              type="button"
                              className="btn btn-link btn-sm text-danger p-0"
                              onClick={() => handleDeleteRow(row.id)}
                              disabled={bulkRows.length <= 1}
                              title="Delete row"
                            >
                              <MaterialIcon type="delete" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </OLTable>
                </div>
              </div>
            )}
          </div>
        )}
      </OLModalBody>

      <OLModalFooter>
        {result ? (
          <div className="d-flex justify-content-between align-items-center w-100 flex-wrap gap-2">
            <OLButton
              variant="secondary"
              leadingIcon="download"
              onClick={handleExportResultsCSV}
            >
              Export Results as CSV
            </OLButton>
            <OLButton variant="primary" onClick={handleDone}>
              Done / Close
            </OLButton>
          </div>
        ) : (
          <>
            <OLButton
              variant="secondary"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </OLButton>
            <OLButton
              variant="primary"
              onClick={() => handleSubmit()}
              isLoading={isSubmitting}
              loadingLabel="Creating..."
            >
              {tab === 'single' ? 'Create User' : 'Create Users'}
            </OLButton>
          </>
        )}
      </OLModalFooter>
    </OLModal>
  )
}
