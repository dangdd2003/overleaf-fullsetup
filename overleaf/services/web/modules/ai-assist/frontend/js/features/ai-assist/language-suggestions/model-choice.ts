import {
  readFastSettings,
  readReasoningEffort,
  readSettings,
} from '../provider-store'
import {
  PROVIDER_TYPE_LABELS,
  ProviderSettings,
  ProviderType,
} from '../providers/types'
import { writingToolsSettings } from '../writing-tools/model-settings'
import {
  wantsStyle,
  type EnglishVariant,
  type LanguageSuggestionsPreferences,
  type ModelSlot,
} from './preferences'

/** A slot's saved provider, when it names a model. */
export function slotSettings(slot: ModelSlot): ProviderSettings | null {
  const settings = slot === 'main' ? readSettings() : readFastSettings()
  return settings?.model ? settings : null
}

/** The slot that runs: the preferred one when it is set up, else the other. */
export function effectiveSlot(preferred: ModelSlot | null): ModelSlot | null {
  const order: ModelSlot[] =
    preferred === 'main' ? ['main', 'fast'] : ['fast', 'main']
  return order.find(slot => slotSettings(slot)) ?? null
}

export type ResolvedModel = {
  slot: ModelSlot
  /** The model id, for the cache key. */
  model: string
  /** The provider type as saved. */
  storedType: ProviderType
  /** What requests are sent with. */
  settings: ProviderSettings
}

/** Resolves a specific slot independently without falling back to the other slot. */
export function resolveSlotModel(slot: ModelSlot): ResolvedModel | null {
  const stored = slotSettings(slot)
  if (!stored) return null
  const settings = writingToolsSettings(stored, readReasoningEffort(stored.type))
  return {
    slot,
    model: stored.model,
    storedType: stored.type,
    settings,
  }
}

/** The model a check runs on, with thinking off; null when no slot is set up. */
export function resolveModel(
  preferred: ModelSlot | null
): ResolvedModel | null {
  const slot = effectiveSlot(preferred)
  if (!slot) return null
  return resolveSlotModel(slot)
}

/** The host a slot's requests go to, as the consent prompts name it. */
export function providerHost(settings: ProviderSettings): string {
  try {
    return new URL(settings.baseUrl).host
  } catch {
    return settings.baseUrl
  }
}

export type ModelItem = {
  slot: ModelSlot
  title: string
  /** The model and its provider, then the trade-off, in one short line. */
  description: string
  disabled: boolean
}

const TITLES: Record<ModelSlot, string> = {
  main: 'Main model',
  fast: 'Fast model',
}

const TRADE_OFFS: Record<ModelSlot, string> = {
  main: 'More thorough, but slower and costlier.',
  fast: 'Quick and low-cost.',
}

export const NOT_SET_UP = 'Not set up. Add it in Account settings.'

/** The Model dropdown: exactly two items, main then fast. */
export function modelItems(): ModelItem[] {
  return (['main', 'fast'] as ModelSlot[]).map(slot => {
    const settings = slotSettings(slot)
    if (!settings) {
      return { slot, title: TITLES[slot], description: NOT_SET_UP, disabled: true }
    }
    const model = settings.modelName || settings.model
    const provider = PROVIDER_TYPE_LABELS[settings.type] ?? settings.type
    return {
      slot,
      title: TITLES[slot],
      description: `${model} (${provider}). ${TRADE_OFFS[slot]}`,
      disabled: false,
    }
  })
}

/** What a cached result depends on besides the sentence itself. */
export type KeyContext = {
  slot: ModelSlot
  model: string
  variant: EnglishVariant
  /** Style rewording asked for too: a result without it is a different one. */
  style: boolean
}

export function keyContext(
  preferences: LanguageSuggestionsPreferences
): KeyContext | null {
  const resolved = resolveModel(preferences.model)
  return resolved
    ? {
        slot: resolved.slot,
        model: resolved.model,
        variant: preferences.englishVariant,
        style: wantsStyle(preferences),
      }
    : null
}
