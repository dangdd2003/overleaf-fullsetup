import { ProviderSettings, ReasoningEffort } from '../providers/types'

const FAST_OPENAI_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low']

/**
 * The chat's provider and model, tuned for a quick edit: thinking off. OpenAI
 * has effort levels only, so a chosen level is capped at `low`, and Auto
 * (no level) stays Auto rather than guessing one the model may reject.
 */
export function writingToolsSettings(
  base: ProviderSettings,
  chosenEffort?: ReasoningEffort
): ProviderSettings {
  const settings: ProviderSettings = { ...base }
  delete settings.reasoningEffort
  delete settings.thinking
  if (base.type === 'openai') {
    if (chosenEffort) {
      settings.reasoningEffort = FAST_OPENAI_EFFORTS.includes(chosenEffort)
        ? chosenEffort
        : 'low'
    }
    return settings
  }
  settings.thinking = false
  return settings
}
