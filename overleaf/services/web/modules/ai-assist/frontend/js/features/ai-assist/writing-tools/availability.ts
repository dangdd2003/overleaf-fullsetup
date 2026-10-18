import getMeta from '@/utils/meta'

/**
 * Writing tools are part of the AI feature, not a feature of their own: they
 * exist exactly when the instance enables AI (AI_ASSIST_ENABLED) and this user
 * has not turned AI off.
 */
export function isWritingToolsAvailable(): boolean {
  // Writefull's flag does not switch these on: with AI off the editor must not
  // run ghost text, the language suggestions scheduler or auto completion
  return (
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false &&
    !getMeta('ol-cannot-use-ai')
  )
}
