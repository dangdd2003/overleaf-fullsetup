import { useEffect, useMemo, useState } from 'react'
import { TranscriptEntry } from '../agent/agent-messages'
import { computeContextUsage } from '../agent/context/context-usage'
import { ContextUsageSnapshot } from '../agent/context/context-usage-types'
import { readSettings } from '../provider-store'
import { ProviderSettings, resolveLimits } from '../providers/types'

/**
 * The context usage of a transcript under the saved provider, or null when no
 * provider is configured. Re-reads the settings when they change here or in
 * another tab, so the meter follows a switch of model or window at once.
 */
export function useContextUsage(
  transcript: TranscriptEntry[]
): ContextUsageSnapshot | null {
  const [settings, setSettings] = useState<ProviderSettings | null>(() =>
    readSettings()
  )

  useEffect(() => {
    const refresh = () => setSettings(readSettings())
    window.addEventListener('aiAssist:providerChanged', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('aiAssist:providerChanged', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return useMemo(() => {
    if (!settings) return null
    return computeContextUsage({
      transcript,
      limits: resolveLimits(settings),
      model: settings.model,
    })
  }, [transcript, settings])
}
