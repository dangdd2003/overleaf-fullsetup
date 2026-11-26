import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsSection } from '@/features/ide-settings/context/types'
import { isWritingToolsAvailable } from '../writing-tools/availability'

type SectionModule = typeof import('../components/inline-suggestion/ai-assistance-section')

export default function useAiAssistanceSection(): SettingsSection | null {
  const { t } = useTranslation()
  const enabled = isWritingToolsAvailable()
  const [mod, setMod] = useState<SectionModule | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void import(
      /* webpackChunkName: "ai-assist-settings-inline" */ '../components/inline-suggestion/ai-assistance-section'
    )
      .then(loaded => {
        if (cancelled) return
        unsubscribe = loaded.subscribeInlineSuggestions(() =>
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
  return mod.buildAiAssistanceSection(t)
}
