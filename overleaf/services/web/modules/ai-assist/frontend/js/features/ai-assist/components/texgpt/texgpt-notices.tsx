import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'

/**
 * A message shown in place of a TeXGPT result. The inline AI popup (empty-line
 * prompt, sentence completion) shows the same ones.
 */
export type TexGptNotice =
  | { name: 'consent' }
  | { name: 'noProvider' }
  | { name: 'error'; message: string; hint?: string }
  | { name: 'cannot'; reason: string }
  | { name: 'empty' }

export function InlineNotice({
  notice,
  onConsent,
}: {
  notice: TexGptNotice
  onConsent?: () => void
}) {
  const { t } = useTranslation()
  switch (notice.name) {
    case 'consent':
      return (
        <div className="ai-texgpt-notice">
          <p>
            {t(
              'ai_assist_consent_prompt',
              'Using the assistant will send project contents and queries to your configured AI provider.'
            )}
          </p>
          <OLButton variant="primary" size="sm" onClick={onConsent}>
            {t('allow_and_continue', 'Allow and continue')}
          </OLButton>
        </div>
      )
    case 'noProvider':
      return (
        <div className="ai-texgpt-notice">
          <p>
            {t(
              'ai_assist_texgpt_no_provider',
              'TeXGPT uses your AI provider. Set one up in your account settings.'
            )}
          </p>
          <a href="/user/settings" target="_blank" rel="noopener noreferrer">
            {t('ai_assist_writing_tools_set_up_provider', 'Set up an AI provider')}
          </a>
        </div>
      )
    case 'cannot':
      return (
        <p className="ai-texgpt-notice">
          {notice.reason ||
            t('ai_assist_texgpt_cannot', 'TeXGPT cannot help with this request.')}
        </p>
      )
    case 'empty':
      return (
        <p className="ai-texgpt-notice">
          {t('ai_assist_writing_tools_empty', 'The model returned no text.')}
        </p>
      )
    case 'error':
      return (
        <div className="ai-texgpt-notice is-error" role="alert">
          <p>{notice.message}</p>
          {notice.hint && <p>{notice.hint}</p>}
        </div>
      )
  }
}
