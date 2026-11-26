import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import { isLanguageSuggestionsAvailable } from '../language-suggestions/availability'

type SectionModule = typeof import('../components/language-suggestions/language-suggestions-section')

export default function useLanguageSuggestionsSection(): SettingsSection | null {
  const { t } = useTranslation()
  const enabled = isLanguageSuggestionsAvailable()
  const [mod, setMod] = useState<SectionModule | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void import(
      /* webpackChunkName: "ai-assist-settings-language" */ '../components/language-suggestions/language-suggestions-section'
    )
      .then(loaded => {
        if (cancelled) return
        unsubscribe = loaded.subscribeLanguageSuggestions(() =>
          setTick(v => v + 1)
        )
        setMod(loaded)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [enabled])

  if (!enabled || !mod) return null
  return mod.buildLanguageSuggestionsSection(t)
}
