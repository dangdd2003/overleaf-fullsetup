import { ReactNode, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import { Select } from '@/shared/components/select'
import Setting from '@/features/ide-settings/components/setting'
import ToggleSetting from '@/features/ide-settings/components/toggle-setting'
import ButtonSetting from '@/features/ide-settings/components/button-setting'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import { hasConsented, recordConsent } from '../../provider-store'
import { isLanguageSuggestionsAvailable } from '../../language-suggestions/availability'
import {
  effectiveSlot,
  modelItems,
  providerHost,
  resolveModel,
} from '../../language-suggestions/model-choice'
import {
  EnglishVariant,
  ModelSlot,
  OPEN_BLOCKED_SUGGESTIONS_EVENT,
  SuggestionTypes,
} from '../../language-suggestions/preferences'
import { useLanguageSuggestionsPreferences } from './use-language-suggestions-preferences'
import '../../../../../stylesheets/ai-assist.scss'

export const NO_PROVIDER_TEXT =
  'Set up an AI provider in Account settings to use language suggestions.'

type SelectItem<T> = {
  value: T
  title: string
  description?: string
  disabled?: boolean
}

const VARIANT_ITEMS: Array<SelectItem<EnglishVariant>> = [
  { value: 'en-US', title: 'English (American)' },
  { value: 'en-GB', title: 'English (British)' },
]

/** All, then corrections, then rewording: the order the card shows them in. */
const TYPE_ITEMS: Array<SelectItem<SuggestionTypes>> = [
  {
    value: 'all',
    title: 'All',
    description: 'Grammar corrections and style improvements.',
  },
  {
    value: 'grammar',
    title: 'Grammar',
    description: 'Spelling, grammar and punctuation corrections only.',
  },
  {
    value: 'style',
    title: 'Style',
    description: 'Clearer, more concise wording only.',
  },
]

/** A settings row with upstream's dropdown: title, description, check. */
function SelectSetting<T>({
  id,
  label,
  items,
  value,
  onChange,
  disabled,
}: {
  id: string
  label: string
  items: Array<SelectItem<T>>
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const selected = items.find(item => item.value === value) ?? null
  return (
    <Setting controlId={id} label={label} description={undefined}>
      <div className="ai-language-suggestions-select-wide">
        <Select<SelectItem<T>>
          id={id}
          items={items}
          itemToKey={item => String(item.value)}
          itemToString={item => item?.title ?? ''}
          itemToSubtitle={item => item?.description ?? ''}
          itemToDisabled={item => Boolean(item?.disabled)}
          selected={selected}
          defaultItem={selected}
          onSelectedItemChanged={item => item && onChange(item.value)}
          disabled={disabled}
          size="sm"
          selectedIcon
          portal
        />
      </div>
    </Setting>
  )
}

function EnabledSetting() {
  const { t } = useTranslation()
  const [preferences, update] = useLanguageSuggestionsPreferences()
  const [askingConsent, setAskingConsent] = useState(false)
  const model = resolveModel(preferences.model)

  const onChange = useCallback(
    (checked: boolean) => {
      if (checked && !hasConsented()) {
        setAskingConsent(true)
        return
      }
      setAskingConsent(false)
      update({ enabled: checked })
    },
    [update]
  )

  const allow = useCallback(() => {
    recordConsent()
    setAskingConsent(false)
    update({ enabled: true })
  }, [update])

  // Only when it cannot be turned on yet: no provider, or no consent given
  let description: ReactNode
  if (!model) {
    description = NO_PROVIDER_TEXT
  } else if (askingConsent) {
    description = (
      <span className="ai-language-suggestions-consent">
        <span>
          Language suggestions send the text of the open file to{' '}
          <strong>{providerHost(model.settings)}</strong> as you write.
        </span>
        <OLButton variant="primary" size="sm" onClick={allow}>
          {t('allow_and_continue', 'Allow and continue')}
        </OLButton>
      </span>
    )
  }

  return (
    <ToggleSetting
      id="aiLanguageSuggestions"
      label={t('ai_language_suggestions', 'AI language suggestions')}
      description={description}
      checked={Boolean(model) && preferences.enabled}
      onChange={onChange}
      disabled={!model}
    />
  )
}

function SuggestionTypesSetting() {
  const [preferences, update] = useLanguageSuggestionsPreferences()
  return (
    <SelectSetting<SuggestionTypes>
      id="aiLanguageSuggestionsTypes"
      label="Suggestion options"
      items={TYPE_ITEMS}
      value={preferences.types}
      onChange={types => update({ types })}
    />
  )
}

function EnglishVariantSetting() {
  const [preferences, update] = useLanguageSuggestionsPreferences()
  return (
    <SelectSetting<EnglishVariant>
      id="aiLanguageSuggestionsEnglish"
      label="English preference for AI suggestions"
      items={VARIANT_ITEMS}
      value={preferences.englishVariant}
      onChange={englishVariant => update({ englishVariant })}
    />
  )
}

function ModelSetting() {
  const [preferences, update] = useLanguageSuggestionsPreferences()
  const items = useMemo(
    () =>
      modelItems().map(item => ({
        value: item.slot,
        title: item.title,
        description: item.description,
        disabled: item.disabled,
      })),
    []
  )
  const slot = effectiveSlot(preferences.model)
  return (
    <SelectSetting<ModelSlot>
      id="aiLanguageSuggestionsModel"
      label="Model"
      items={items}
      value={slot}
      disabled={!slot}
      onChange={model => update({ model })}
    />
  )
}

function BlockedSetting() {
  const { t } = useTranslation()
  const onClick = useCallback(() => {
    // As the Dictionary row does: close the settings, open the list
    window.dispatchEvent(new CustomEvent('ui.toggle-settings', { detail: false }))
    window.dispatchEvent(new CustomEvent(OPEN_BLOCKED_SUGGESTIONS_EVENT))
  }, [])
  return (
    <ButtonSetting
      id="aiLanguageSuggestionsBlocked"
      label={t('blocked_language_suggestions', 'Blocked language suggestions')}
      buttonText={t('edit', 'Edit')}
      onClick={onClick}
    />
  )
}

/** Registered in `settingsModalSpellcheckSections`: the Language suggestions section. */
export default function useLanguageSuggestionsSection(): SettingsSection | null {
  const { t } = useTranslation()
  const [preferences] = useLanguageSuggestionsPreferences()
  if (!isLanguageSuggestionsAvailable()) return null
  // The rest of the section only applies while the toggle is on
  const on = preferences.enabled && Boolean(resolveModel(preferences.model))
  return {
    key: 'language-suggestions',
    title: t('language_suggestions', 'Language suggestions'),
    settings: [
      { key: 'aiLanguageSuggestions', component: <EnabledSetting /> },
      ...(on
        ? [
            { key: 'aiLanguageSuggestionsTypes', component: <SuggestionTypesSetting /> },
            { key: 'aiLanguageSuggestionsEnglish', component: <EnglishVariantSetting /> },
            { key: 'aiLanguageSuggestionsModel', component: <ModelSetting /> },
            { key: 'aiLanguageSuggestionsBlocked', component: <BlockedSetting /> },
          ]
        : []),
    ],
  }
}
