import { useTranslation } from 'react-i18next'
import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import {
  COMPLETION_DELAYS,
  CompletionMode,
} from '../../inline-suggestion/preferences'
import { useInlineSuggestionsPreferences } from './use-inline-suggestions-preferences'

function EmptyLineShortcutSetting() {
  const { t } = useTranslation()
  const [preferences, update] = useInlineSuggestionsPreferences()
  return (
    <ToggleSetting
      id="aiEmptyLineShortcut"
      label={t('ai_empty_line_shortcut', 'AI shortcut on empty lines')}
      description={t('ai_empty_line_shortcut_description', 'Press Space to open the AI assistant')}
      checked={preferences.emptyLineShortcut}
      onChange={checked => update({ emptyLineShortcut: checked })}
    />
  )
}

function CompletionModeSetting() {
  const { t } = useTranslation()
  const [preferences, update] = useInlineSuggestionsPreferences()
  return (
    <DropdownSetting<CompletionMode>
      id="aiCompletionMode"
      label={t('ai_code_completion', 'AI code completion')}
      description={t('ai_code_completion_description', 'Ghost text at the cursor; Tab accepts, Shift+Space asks for a new one')}
      options={[
        { value: 'disabled', label: t('ai_code_completion_disabled', 'Disabled') },
        { value: 'manual', label: t('ai_code_completion_manual', 'Manual (Shift+Space)') },
        { value: 'automatic', label: t('ai_code_completion_automatic', 'Automatic (and Shift+Space)') },
      ]}
      value={preferences.completionMode}
      onChange={completionMode => update({ completionMode })}
    />
  )
}

function CompletionDelaySetting() {
  const { t } = useTranslation()
  const [preferences, update] = useInlineSuggestionsPreferences()
  return (
    <DropdownSetting<number>
      id="aiCompletionDelay"
      label={t('ai_code_completion_delay', 'Trigger delay')}
      description={t(
        'ai_code_completion_delay_description',
        'Pause in typing before a suggestion is requested'
      )}
      options={COMPLETION_DELAYS.map(ms => ({ value: ms, label: `${ms} ms` }))}
      value={preferences.completionDelayMs}
      onChange={completionDelayMs => update({ completionDelayMs })}
    />
  )
}

/**
 * Registered in `settingsModalEditorTabSections`: upstream renders it in
 * the Editor tab, after Tools. The delay row exists only while Automatic
 * is chosen.
 */
export default function useAiAssistanceSection(): SettingsSection | null {
  const { t } = useTranslation()
  const [preferences] = useInlineSuggestionsPreferences()
  if (!isWritingToolsAvailable()) return null
  return {
    key: 'ai-assistance',
    title: t('ai_assistance', 'AI assistance'),
    settings: [
      { key: 'aiEmptyLineShortcut', component: <EmptyLineShortcutSetting /> },
      { key: 'aiCompletionMode', component: <CompletionModeSetting /> },
      ...(preferences.completionMode === 'automatic'
        ? [{ key: 'aiCompletionDelay', component: <CompletionDelaySetting /> }]
        : []),
    ],
  }
}
