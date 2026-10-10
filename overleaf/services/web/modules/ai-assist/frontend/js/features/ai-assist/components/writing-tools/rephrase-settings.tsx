import { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import {
  RephraseLength,
  RephraseLevel,
  RephraseStyle,
} from '../../writing-tools/prompt'
import { WritingToolsPreferences } from '../../writing-tools/preferences'

type Rephrase = WritingToolsPreferences['rephrase']

const LEVELS: RephraseLevel[] = ['low', 'medium', 'high']
const STYLES: RephraseStyle[] = ['scientific', 'concise', 'punchy']
const LENGTHS: RephraseLength[] = ['shorten', 'lengthen']

/**
 * "Choose your settings" for Rephrase. Level always has a value; Style and
 * Length toggle off when clicked again. The prompt runs on Enter and, while
 * non-empty, replaces the presets.
 */
export function RephraseSettingsPanel({
  settings,
  prompt,
  onChange,
  onPromptChange,
  onSubmitPrompt,
}: {
  settings: Rephrase
  prompt: string
  onChange: (settings: Rephrase) => void
  onPromptChange: (prompt: string) => void
  onSubmitPrompt: () => void
}) {
  const { t } = useTranslation()

  const chip = (selected: boolean, text: string, onClick: () => void) => (
    <OLButton
      key={text}
      variant="secondary"
      size="sm"
      active={selected}
      leadingIcon={selected ? 'check' : undefined}
      onClick={onClick}
    >
      {text}
    </OLButton>
  )

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (prompt.trim()) onSubmitPrompt()
    }
  }

  return (
    <div className="ai-writing-tools-settings">
      <div className="ai-writing-tools-settings-title">
        {t('ai_assist_writing_tools_choose_settings', 'Choose your settings:')}
      </div>
      <div className="ai-writing-tools-settings-label">
        {t('ai_assist_writing_tools_level', 'Level:')}
      </div>
      <div className="ai-writing-tools-chips">
        {LEVELS.map(level =>
          chip(settings.level === level, level, () =>
            onChange({ ...settings, level })
          )
        )}
      </div>
      <div className="ai-writing-tools-settings-label">
        {t('ai_assist_writing_tools_style', 'Style:')}
      </div>
      <div className="ai-writing-tools-chips">
        {STYLES.map(style =>
          chip(settings.style === style, style, () =>
            onChange({
              ...settings,
              style: settings.style === style ? null : style,
            })
          )
        )}
      </div>
      <div className="ai-writing-tools-settings-label">
        {t('ai_assist_writing_tools_length', 'Length:')}
      </div>
      <div className="ai-writing-tools-chips">
        {LENGTHS.map(length =>
          chip(settings.length === length, length, () =>
            onChange({
              ...settings,
              length: settings.length === length ? null : length,
            })
          )
        )}
      </div>
      <label className="ai-writing-tools-settings-label">
        {t('ai_assist_writing_tools_prompt', 'Or, enter your prompt:')}
        <textarea
          className="ai-writing-tools-prompt"
          rows={4}
          value={prompt}
          placeholder={t(
            'ai_assist_writing_tools_prompt_placeholder',
            'e.g. Paraphrase the following making sure to keep the following terms intact: lung infection, little attention'
          )}
          onChange={event => onPromptChange(event.target.value)}
          onKeyDown={onPromptKeyDown}
        />
      </label>
    </div>
  )
}
