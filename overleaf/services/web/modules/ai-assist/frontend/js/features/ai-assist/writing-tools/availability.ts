import getMeta from '@/utils/meta'

/**
 * Writing tools are part of the AI feature, not a feature of their own: they
 * exist exactly when the instance enables AI (AI_ASSIST_ENABLED) and this user
 * has not turned AI off.
 */
export function isWritingToolsAvailable(): boolean {
  return (
    (Boolean(getMeta('ol-aiAssistEnabled')) ||
      Boolean(getMeta('ol-writefullEnabled'))) &&
    getMeta('ol-showAiFeatures') !== false &&
    !getMeta('ol-cannot-use-ai')
  )
}
