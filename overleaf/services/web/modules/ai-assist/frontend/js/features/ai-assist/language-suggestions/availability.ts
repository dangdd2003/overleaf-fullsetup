import { isWritingToolsAvailable } from '../writing-tools/availability'

/**
 * Language suggestions are part of the AI feature, not a feature of their
 * own: they exist exactly when the instance enables AI (AI_ASSIST_ENABLED)
 * and this user has not turned AI off. Each user still turns them on in the
 * editor settings.
 */
export function isLanguageSuggestionsAvailable(): boolean {
  return isWritingToolsAvailable()
}
