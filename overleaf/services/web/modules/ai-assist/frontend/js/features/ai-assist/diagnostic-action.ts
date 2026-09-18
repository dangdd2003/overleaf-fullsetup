import getMeta from '@/utils/meta'
import type { DiagnosticAction } from '@/features/source-editor/extensions/annotations'
import { isFixableLogEntry } from './log-entry-levels'
import '../../../stylesheets/ai-assist.scss'

const SPARKLE_PATH =
  'M14.87 12.18c-4.74-1.07-5.48-1.8-6.55-6.54a.48.48 0 0 0-.93 0c-1.07 4.74-1.8 5.47-6.54 6.54a.48.48 0 0 0 0 .93c4.74 1.08 5.47 1.8 6.54 6.55a.48.48 0 0 0 .93 0c1.07-4.74 1.8-5.47 6.55-6.55a.48.48 0 0 0 0-.93Zm4.28-7.38c-2.52-.56-2.87-.92-3.44-3.44a.48.48 0 0 0-.93 0c-.57 2.52-.92 2.88-3.44 3.44a.48.48 0 0 0 0 .93c2.52.57 2.87.93 3.44 3.45a.48.48 0 0 0 .93 0c.57-2.52.92-2.88 3.44-3.45a.48.48 0 0 0 0-.93Z'

// The logs pane may not be mounted yet when the tooltip button is clicked, so
// wait a bounded time for the entry's own suggest-fix button to appear.
const WAIT_FOR_BUTTON_MS = 3000

function clickLogEntrySuggestFix(id: string) {
  const deadline = Date.now() + WAIT_FOR_BUTTON_MS
  const attempt = () => {
    const button = document.querySelector<HTMLButtonElement>(
      `.log-entry[data-log-entry-id="${id}"] button[data-action="suggest-fix"]`
    )
    if (button) {
      // The log-entry button expands its entry and starts the fix run.
      button.click()
    } else if (Date.now() < deadline) {
      window.setTimeout(attempt, 50)
    }
  }
  attempt()
}

/**
 * Inline "Suggest fix" in the editor's lint-gutter tooltip. Opens the compile
 * log entry for this diagnostic and triggers the same suggest-fix flow as the
 * button in the error panel.
 */
const suggestFixDiagnosticAction: DiagnosticAction = diagnostic => {
  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  const { id, compile } = diagnostic
  // Only where the logs pane itself offers "Suggest fix": the entry's real level
  // must be error or warning. The diagnostic's severity is not enough — info
  // entries also reach the editor as 'warning'.
  if (!enabled || !compile || !id || !isFixableLogEntry(id)) return null

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-primary btn-sm ai-diagnostic-suggest-fix'
  button.setAttribute('data-action', 'diagnostic-suggest-fix')

  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('viewBox', '0 0 20 21')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svgNS, 'path')
  path.setAttribute('d', SPARKLE_PATH)
  svg.append(path)

  button.append(svg, document.createTextNode('Suggest fix'))

  button.addEventListener('click', event => {
    event.preventDefault()
    // Deliberately not passing `suggestFix: true`: the native handler gates
    // that on hosted AI usage quota and would show the paywall in CE.
    window.dispatchEvent(
      new CustomEvent('editor:view-compile-log-entry', { detail: { id } })
    )
    clickLogEntrySuggestFix(id)
  })

  return button
}

export default suggestFixDiagnosticAction
