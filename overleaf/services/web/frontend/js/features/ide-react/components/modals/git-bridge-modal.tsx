import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import { useProjectContext } from '@/shared/context/project-context'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import getMeta from '@/utils/meta'

type GitBridgeModalProps = {
  show: boolean
  onHide?: () => void
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

export default function GitBridgeModal({ show, onHide }: GitBridgeModalProps) {
  const { t } = useTranslation()
  const { project } = useProjectContext()
  const { setActiveModal } = useRailContext()
  const [token, setToken] = useState<string | null>(null)
  const [hasExistingTokens, setHasExistingTokens] = useState<boolean>(false)
  const [copied, setCopied] = useState<boolean>(false)
  const [tokenCopied, setTokenCopied] = useState<boolean>(false)
  const [loading, setLoading] = useState<boolean>(false)

  const handleClose = useCallback(() => {
    if (token) {
      setHasExistingTokens(true)
      setToken(null)
      setTokenCopied(false)
    }
    setCopied(false)
    if (onHide) {
      onHide()
    } else {
      setActiveModal(null)
    }
  }, [onHide, setActiveModal, token])

  const projectId = project?._id || ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const gitUrl = `${origin.replace(/^(https?:\/\/)/, '$1git@')}/git/${projectId}`
  const cloneCommand = `git clone ${gitUrl}`

  // Check if user has existing tokens and clear ephemeral state when modal opens
  useEffect(() => {
    if (!show) {
      setToken(null)
      setTokenCopied(false)
      setCopied(false)
      return
    }
    fetch('/user/personal-access-tokens')
      .then(res => (res.ok ? res.json() : []))
      .then(tokens => {
        if (Array.isArray(tokens) && tokens.length > 0) {
          setHasExistingTokens(true)
        } else {
          setHasExistingTokens(false)
        }
      })
      .catch(() => {})
  }, [show])

  const handleGenerateToken = useCallback(async () => {
    setLoading(true)
    try {
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
        body: JSON.stringify({
          name: `Token for project ${project?.name || ''}`,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setToken(data.token)
      }
    } finally {
      setLoading(false)
    }
  }, [project?.name])

  const copyCloneCommand = useCallback(() => {
    copyTextToClipboard(cloneCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [cloneCommand])

  const copyToken = useCallback(() => {
    if (token) {
      copyTextToClipboard(token)
      setTokenCopied(true)
      setTimeout(() => setTokenCopied(false), 2000)
    }
  }, [token])

  return (
    <OLModal
      show={show}
      onHide={handleClose}
      className="git-bridge-modal"
      animation={true}
      data-testid="git-bridge-modal"
      aria-labelledby="git-bridge-modal-title"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="git-bridge-modal-title" as="h2">
          {t('clone_with_git', 'Clone with Git')}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="git-bridge-secondary-text mb-2">
          {t(
            'git_bridge_description',
            'You can work on this project locally using Git.'
          )}
        </p>

        <div className="git-bridge-copy">
          <code aria-label="Git clone project command">{cloneCommand}</code>
          <button
            type="button"
            className="git-copy-pill-btn"
            onClick={copyCloneCommand}
            aria-label="Git clone project command"
          >
            {copied ? t('copied', 'Copied') : t('copy', 'Copy')}
          </button>
        </div>

        <div className="mt-4">
          <h5>{t('credentials', 'Credentials')}</h5>
          <p className="git-bridge-secondary-text small mb-2">
            {t(
              'git_credentials_instructions',
              'Username is git, password is a Git Personal Access Token'
            )}
          </p>
          <ul className="mb-3">
            <li>
              <strong>{t('username', 'Username')}:</strong> <code>git</code>
            </li>
            <li>
              <strong>{t('password', 'Password')}:</strong>{' '}
              {t(
                'git_token_credential_explanation',
                'Git Personal Access Token'
              )}
            </li>
          </ul>
        </div>

        {!token && !hasExistingTokens && (
          <div className="mt-3">
            <button
              type="button"
              className="btn btn-primary rounded-pill px-4"
              onClick={handleGenerateToken}
              disabled={loading}
              aria-label="Generate token"
            >
              {loading
                ? t('generating', 'Generating...')
                : t('generate_token', 'Generate token')}
            </button>
          </div>
        )}

        {token && (
          <div className="git-bridge-optional-tokens mt-4">
            <h5 className="git-bridge-optional-tokens-header">
              {t('git_auth_token_heading', 'Git authentication token')}
            </h5>
            <p className="git-bridge-secondary-text small mb-2">
              {t(
                'git_token_info_subtitle',
                'This is your Git authentication token. You should enter this when prompted for a password.'
              )}
            </p>
            <div className="git-bridge-copy">
              <code aria-label="Git authentication token">{token}</code>
              <button
                type="button"
                className="git-copy-pill-btn"
                onClick={copyToken}
                aria-label="Copy authentication token"
              >
                {tokenCopied ? t('copied', 'Copied') : t('copy', 'Copy')}
              </button>
            </div>
            <p className="git-bridge-secondary-text small mt-2 mb-0">
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
          </div>
        )}

        {!token && hasExistingTokens && (
          <div className="mt-3 git-bridge-secondary-text small">
            <p className="mb-1">
              {t(
                'git_token_already_exists',
                'You have generated a token. If you need a new one, you can generate a new one in Account settings.'
              )}
            </p>
            <a
              href="/user/settings"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-link px-0"
              aria-label="Go to settings"
            >
              {t('go_to_settings', 'Go to settings')} &rarr;
            </a>
          </div>
        )}
      </OLModalBody>
      <OLModalFooter>
        <button
          type="button"
          className="btn btn-primary rounded-pill px-4"
          onClick={handleClose}
          aria-label="Close dialog"
        >
          {t('close', 'Close')}
        </button>
      </OLModalFooter>
    </OLModal>
  )
}
