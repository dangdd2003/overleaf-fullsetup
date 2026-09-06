import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import GitLogoOrange from '@/shared/svgs/git-logo-orange'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'

interface TokenRecord {
  _id: string
  name: string
  tokenPrefix: string
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  scopes?: string[]
}

function formatOrdinalDate(dateInput?: string | Date): string {
  if (!dateInput) return 'N/A'
  const date = new Date(dateInput)
  if (isNaN(date.getTime())) return 'N/A'

  const day = date.getDate()
  const suffix = ['th', 'st', 'nd', 'rd'][
    day % 10 > 3 || Math.floor((day % 100) / 10) === 1 ? 0 : day % 10
  ]
  const month = date.toLocaleString('en-US', { month: 'short' })
  const year = date.getFullYear()

  return `${day}${suffix} ${month} ${year}`
}

function calculateExpiryDate(dateInput: string | Date): string {
  const date = new Date(dateInput)
  if (isNaN(date.getTime())) return 'N/A'
  date.setFullYear(date.getFullYear() + 1)
  return formatOrdinalDate(date)
}

function copyTextToClipboard(text: string): boolean {
  if (!text) return false

  let copied = false

  // 1. Direct copy event listener: writes directly to OS clipboard buffer and bypasses FocusTrap / DOM selection issues
  const onCopy = (e: ClipboardEvent) => {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.clipboardData) {
      e.clipboardData.clearData()
      e.clipboardData.setData('text/plain', text)
      copied = true
    }
  }

  try {
    document.addEventListener('copy', onCopy, { capture: true, once: true })
    const result = document.execCommand('copy')
    document.removeEventListener('copy', onCopy, { capture: true })
    if (result && copied) {
      return true
    }
  } catch {
    document.removeEventListener('copy', onCopy, { capture: true })
  }

  // 2. Modern navigator.clipboard API if supported
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  // 3. Fallback textarea appended inside active container
  try {
    const parent = document.querySelector('.modal-body') || document.body
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.top = '0'
    textArea.style.left = '0'
    textArea.style.width = '1px'
    textArea.style.height = '1px'
    textArea.style.padding = '0'
    textArea.style.border = 'none'
    textArea.style.outline = 'none'
    textArea.style.background = 'transparent'
    parent.appendChild(textArea)
    textArea.focus()
    textArea.select()
    textArea.setSelectionRange(0, text.length)
    const result = document.execCommand('copy')
    parent.removeChild(textArea)
    if (result) return true
  } catch {
    // ignore
  }

  return true
}

export function GitTokensWidget() {
  const { t } = useTranslation()
  const [tokens, setTokens] = useState<TokenRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [showGenerateModal, setShowGenerateModal] = useState<boolean>(false)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [tokenCopied, setTokenCopied] = useState<boolean>(false)
  const [tokenToDelete, setTokenToDelete] = useState<TokenRecord | null>(null)
  const mcpEnabled = Boolean(getMeta('ol-mcpEnabled'))
  const [scopeGitBridge, setScopeGitBridge] = useState<boolean>(true)
  const [scopeMcp, setScopeMcp] = useState<boolean>(false)

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch('/user/personal-access-tokens')
      if (res.ok) {
        const data = await res.json()
        setTokens(Array.isArray(data) ? data : [])
      }
    } catch {
      setTokens([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTokens()
  }, [fetchTokens])

  const handleGenerate = async () => {
    try {
      const scopes: string[] = []
      if (scopeGitBridge) scopes.push('git_bridge')
      if (mcpEnabled && scopeMcp) scopes.push('mcp')
      if (scopes.length === 0) scopes.push('git_bridge')
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''
      const res = await fetch('/user/personal-access-tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
        body: JSON.stringify({ name: 'Git Token', scopes }),
      })
      if (res.ok) {
        const data = await res.json()
        setGeneratedToken(data.token)
        setShowGenerateModal(true)
        fetchTokens()
      }
    } catch (err) {
      console.error('Failed to generate token', err)
    }
  }

  const handleDelete = async () => {
    if (!tokenToDelete) return
    try {
      const csrfToken =
        (typeof window !== 'undefined' && (window as any).csrfToken) ||
        getMeta('ol-csrfToken') ||
        ''
      const response = await fetch(
        `/user/personal-access-tokens/${tokenToDelete._id}`,
        {
          method: 'DELETE',
          headers: {
            'X-Csrf-Token': csrfToken,
          },
        }
      )
      if (!response.ok) {
        console.error('Failed to delete token', response.status)
        return
      }
      setTokenToDelete(null)
      fetchTokens()
    } catch (err) {
      console.error('Failed to delete token', err)
    }
  }

  const copyToken = () => {
    if (generatedToken) {
      copyTextToClipboard(generatedToken)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    }
  }

  const hasTokens = tokens.length > 0

  return (
    <div className="linking-git-bridge mb-5">
      <div className="d-flex align-items-start gap-3 mb-3">
        <div className="linking-icon-fixed-position pt-1">
          <GitLogoOrange size={38} />
        </div>
        <div className="flex-grow-1 linking-git-bridge-content">
          <h3 className="h4 font-weight-bold mb-2" id="git-integration-heading">
            {t('git_integration', 'Git integration')}
          </h3>
          <p
            className="git-tokens-instruction-text mb-4"
            style={{ fontSize: '15px', lineHeight: '1.5' }}
          >
            {t(
              'git_integration_description_prefix',
              'With Git integration, you can clone your Overleaf projects with Git. For full instructions on how to do this,'
            )}{' '}
            <a
              href="https://www.overleaf.com/learn/how-to/Git_integration"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(
                'git_integration_help_link',
                'read our Git Integration help page'
              )}
            </a>
            .
          </p>

          <div className="git-tokens-header-row d-flex align-items-center justify-content-between mb-2">
            <h4 className="h5 font-weight-bold mb-0">
              {t('your_git_auth_tokens', 'Your Git authentication tokens')}
            </h4>
            {!hasTokens && !loading && (
              <OLButton
                variant="secondary"
                onClick={handleGenerate}
                aria-label={`${t('git_integration', 'Git integration')} ${t('generate_token', 'Generate token')}`}
              >
                {t('generate_token', 'Generate token')}
              </OLButton>
            )}
          </div>

          <p
            className="git-tokens-instruction-text mb-2"
            style={{ fontSize: '15px' }}
          >
            {t(
              'your_git_auth_tokens_instructions',
              'Your Git authentication tokens should be entered whenever you’re prompted for a password.'
            )}
          </p>

          {mcpEnabled && (
            <div className="git-token-scopes mb-3">
              <p className="fw-bold mb-1" style={{ fontSize: '14px' }}>
                {t('personal_access_token_scopes', 'Token permissions')}
              </p>
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="git-token-scope-git-bridge"
                  checked={scopeGitBridge}
                  onChange={e => setScopeGitBridge(e.target.checked)}
                />
                <label
                  className="form-check-label"
                  htmlFor="git-token-scope-git-bridge"
                >
                  {t(
                    'personal_access_token_scope_git_bridge',
                    'Git integration'
                  )}
                </label>
              </div>
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="git-token-scope-mcp"
                  checked={scopeMcp}
                  onChange={e => setScopeMcp(e.target.checked)}
                />
                <label
                  className="form-check-label"
                  htmlFor="git-token-scope-mcp"
                >
                  {t('personal_access_token_scope_mcp', 'AI assistant (MCP)')}
                </label>
              </div>
            </div>
          )}

          {!hasTokens ? (
            <ul
              className="git-tokens-instruction-text mb-4 ps-3"
              style={{ fontSize: '15px', lineHeight: '1.6' }}
            >
              <li>
                {t(
                  'git_tokens_empty_hint_1_prefix',
                  'You can generate a token using the'
                )}{' '}
                <strong>{t('generate_token', 'Generate token')}</strong>{' '}
                {t('git_tokens_empty_hint_1_suffix', 'button.')}
              </li>
              <li>
                {t(
                  'git_tokens_empty_hint_2',
                  "You won't be able to view the full token after the first time you generate it. Please copy it and keep it safe"
                )}
              </li>
              <li>
                {t(
                  'git_tokens_empty_hint_3',
                  'Previously generated tokens will be shown here.'
                )}
              </li>
            </ul>
          ) : (
            <ul
              className="git-tokens-instruction-text mb-4 ps-3"
              style={{ fontSize: '15px', lineHeight: '1.6' }}
            >
              <li>
                {t(
                  'git_tokens_unlimited',
                  'You are free to generate as many tokens as possible.'
                )}
              </li>
            </ul>
          )}

          {hasTokens && (
            <div
              className="git-tokens-table-container rounded"
              style={{ border: '1px solid var(--border-divider, #e2e8f0)' }}
            >
              <table className="table table-borderless align-middle mb-0">
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--border-divider, #e2e8f0)',
                      fontSize: '14px',
                      background: 'var(--bg-light-primary, #ffffff)',
                    }}
                  >
                    <th className="py-2 px-3 fw-bold" style={{ width: '22%' }}>
                      {t('token', 'Token')}
                    </th>
                    <th className="py-2 px-3 fw-bold" style={{ width: '17%' }}>
                      {t('personal_access_token_scopes', 'Token permissions')}
                    </th>
                    <th className="py-2 px-3 fw-bold" style={{ width: '17%' }}>
                      {t('created', 'Created')}
                    </th>
                    <th className="py-2 px-3 fw-bold" style={{ width: '19%' }}>
                      {t('last_used', 'Last used')}
                    </th>
                    <th className="py-2 px-3 fw-bold" style={{ width: '20%' }}>
                      {t('expires', 'Expires')}
                    </th>
                    <th
                      className="py-2 px-3 text-end"
                      style={{ width: '5%' }}
                    ></th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map(token => (
                    <tr
                      key={token._id}
                      style={{
                        borderBottom:
                          '1px solid var(--border-divider, #e2e8f0)',
                        fontSize: '14px',
                      }}
                    >
                      <td className="py-3 px-3 font-monospace token-text">
                        {token.tokenPrefix || 'olp_4LEj'}
                        {'*'.repeat(12)}
                      </td>
                      <td className="py-3 px-3">
                        {(token.scopes && token.scopes.length
                          ? token.scopes
                          : ['git_bridge']
                        ).map(scope => (
                          <span
                            key={scope}
                            className="badge badge-bs3 badge-info me-1"
                          >
                            {scope === 'mcp'
                              ? t(
                                  'personal_access_token_scope_mcp',
                                  'AI assistant (MCP)'
                                )
                              : t(
                                  'personal_access_token_scope_git_bridge',
                                  'Git integration'
                                )}
                          </span>
                        ))}
                      </td>
                      <td className="py-3 px-3 date-text">
                        {formatOrdinalDate(token.createdAt)}
                      </td>
                      <td className="py-3 px-3 date-text">
                        {token.lastUsedAt
                          ? formatOrdinalDate(token.lastUsedAt)
                          : 'N/A'}
                      </td>
                      <td className="py-3 px-3 date-text">
                        {token.expiresAt
                          ? formatOrdinalDate(token.expiresAt)
                          : calculateExpiryDate(token.createdAt)}
                      </td>
                      <td className="py-3 px-3 text-end">
                        <button
                          type="button"
                          className="git-token-delete-btn"
                          onClick={() => setTokenToDelete(token)}
                          aria-label="Remove"
                          title={t('delete_token', 'Delete token')}
                        >
                          <MaterialIcon type="delete" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="git-tokens-table-footer">
                <OLButton
                  variant="link"
                  className="btn-inline-link"
                  onClick={handleGenerate}
                  aria-label={t('add_another_token', 'Add another token')}
                >
                  {t('add_another_token', 'Add another token')}
                </OLButton>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Generated Token Modal Matching Screenshot */}
      <OLModal
        show={showGenerateModal}
        onHide={() => {
          setShowGenerateModal(false)
          setGeneratedToken(null)
        }}
        animation={true}
        className="git-bridge-modal"
        aria-labelledby="generated-token-title"
      >
        <OLModalHeader closeButton>
          <OLModalTitle id="generated-token-title" as="h2">
            {t('git_auth_token', 'Git authentication token')}
          </OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <p className="git-bridge-secondary-text mb-2" style={{ fontSize: '15px' }}>
            {t(
              'git_token_info_subtitle',
              'This is your Git authentication token. You should enter this when prompted for a password.'
            )}
          </p>
          <div className="git-bridge-copy">
            <code
              id="modal-git-auth-token"
              aria-label="Git authentication token"
            >
              {generatedToken || ''}
            </code>
            <button
              type="button"
              className="git-copy-pill-btn"
              onClick={copyToken}
              aria-label={
                tokenCopied ? t('copied', 'Copied') : t('copy', 'Copy')
              }
            >
              {tokenCopied ? t('copied', 'Copied') : t('copy', 'Copy')}
            </button>
          </div>
          <p
            className="git-bridge-secondary-text small mt-3 mb-0"
            style={{ lineHeight: '1.5' }}
          >
            <strong>
              {t(
                'git_token_created_warning_bold',
                'You will only see this authentication token once so please copy it and keep it safe.'
              )}
            </strong>{' '}
            {t(
              'git_token_instructions_prefix',
              'For full instructions on using authentication tokens, visit our'
            )}{' '}
            <a
              href="https://www.overleaf.com/learn/how-to/Git_integration"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('help_page', 'help page')}
            </a>
            .
          </p>
        </OLModalBody>
        <OLModalFooter>
          <button
            type="button"
            className="btn btn-primary rounded-pill px-4"
            onClick={() => {
              setShowGenerateModal(false)
              setGeneratedToken(null)
            }}
            aria-label="Close dialog"
          >
            {t('close', 'Close')}
          </button>
        </OLModalFooter>
      </OLModal>

      {/* Confirm Delete Modal */}
      <OLModal
        show={Boolean(tokenToDelete)}
        onHide={() => setTokenToDelete(null)}
        animation={true}
        className="git-bridge-modal"
        aria-labelledby="delete-token-title"
      >
        <OLModalHeader closeButton>
          <OLModalTitle id="delete-token-title" as="h2">
            {t('delete_token', 'Delete token')}
          </OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <p className="git-bridge-secondary-text">
            {t(
              'delete_token_confirm',
              'Are you sure you want to delete this Git token? Any Git repositories configured with this token will lose access.'
            )}
          </p>
        </OLModalBody>
        <OLModalFooter>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setTokenToDelete(null)}
          >
            {t('cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleDelete}
            aria-label="Delete token"
          >
            {t('delete_token', 'Delete token')}
          </button>
        </OLModalFooter>
      </OLModal>
    </div>
  )
}

export default GitTokensWidget
