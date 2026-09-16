import { MouseEvent, useCallback, useContext, useState } from 'react'
import getMeta from '@/utils/meta'
import type { LogEntry } from '@/features/pdf-preview/util/types'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import OLButton from '@/shared/components/ol/ol-button'
import useEventListener from '@/shared/hooks/use-event-listener'
import { ProjectContext } from '@/shared/context/project-context'
import { isFixRunning } from '../agent/fix-store'

/**
 * Rendered into the compile log entry header.
 *
 * The `data-action="suggest-fix"` attribute is load-bearing: the editor finds
 * this button by that exact selector when it asks the log pane for a fix
 * (use-log-events.ts:46). Renaming it silently breaks the editor-initiated path
 * while manual clicks keep working.
 */
export default function SuggestFixButton({
  logEntry,
  id,
}: {
  // Partial, because the pane hands over whatever it has: some entries carry no
  // `key`, and callers in tests and other panes pass a bare subset.
  logEntry?: Partial<LogEntry> & { id?: string }
  id?: string
}) {
  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) &&
    getMeta('ol-showAiFeatures') !== false

  const projectContext = useContext(ProjectContext)
  const projectId = projectContext?.projectId || 'default'

  // A LogEntry identifies itself with `key`, not `id` (pdf-preview/util/types.ts).
  // The pane passes that same value as the `id` prop, so either source works;
  // reading only `logEntry.id` renders nothing at all.
  const entryId = id ?? logEntry?.key ?? logEntry?.id
  const [loading, setLoading] = useState(() =>
    Boolean(entryId && isFixRunning(projectId, entryId))
  )

  const onSuggestFix = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string }>).detail ?? {}
      if (detail.entryId === entryId) {
        setLoading(true)
      }
    },
    [entryId]
  )

  const onSuggestDone = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<{ entryId?: string }>).detail ?? {}
      if (detail.entryId === entryId) {
        setLoading(false)
      }
    },
    [entryId]
  )

  useEventListener('aiAssist:suggestFix', onSuggestFix)
  useEventListener('aiAssist:suggestDone', onSuggestDone)

  const onClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // The panel that renders the suggestion lives in this entry's content,
      // which the pane keeps mounted but hidden while the entry is collapsed.
      // Only the first entry auto-expands, so expand ourselves first — the same
      // way the editor-initiated path does (use-log-events.ts:38) — or the
      // stream arrives somewhere the user cannot see.
      const toggle = event.currentTarget
        .closest('.log-entry')
        ?.querySelector<HTMLElement>('[data-action="expand-collapse"]')
      if (toggle?.dataset.collapsed === 'true') {
        toggle.click()
      }

      window.dispatchEvent(
        new CustomEvent('aiAssist:suggestFix', {
          detail: { entryId },
        })
      )
    },
    [entryId]
  )

  // Info/typesetting/success/raw entries are not actionable errors — offering
  // to "fix" one is misleading, so the button only shows for errors and
  // warnings.
  const isFixable = logEntry?.level === 'error' || logEntry?.level === 'warning'

  if (!enabled || !entryId || !isFixable) return null

  return (
    <OLTooltip
      id={`suggest-fix-${entryId}`}
      description="Suggest fix"
      overlayProps={{ placement: 'bottom' }}
    >
      <OLButton
        type="button"
        variant="ghost"
        className={`icon-button ai-suggest-fix-button ${loading ? 'is-loading' : ''}`}
        data-action="suggest-fix"
        aria-label="Suggest fix"
        onClick={onClick}
      >
        <span className="button-content">
          <svg
            className="ai-suggest-fix-icon"
            viewBox="0 0 20 21"
            width="18"
            height="18"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M14.87 12.18c-4.74-1.07-5.48-1.8-6.55-6.54a.48.48 0 0 0-.93 0c-1.07 4.74-1.8 5.47-6.54 6.54a.48.48 0 0 0 0 .93c4.74 1.08 5.47 1.8 6.54 6.55a.48.48 0 0 0 .93 0c1.07-4.74 1.8-5.47 6.55-6.55a.48.48 0 0 0 0-.93Zm4.28-7.38c-2.52-.56-2.87-.92-3.44-3.44a.48.48 0 0 0-.93 0c-.57 2.52-.92 2.88-3.44 3.44a.48.48 0 0 0 0 .93c2.52.57 2.87.93 3.44 3.45a.48.48 0 0 0 .93 0c.57-2.52.92-2.88 3.44-3.45a.48.48 0 0 0 0-.93Z" />
          </svg>
        </span>
      </OLButton>
    </OLTooltip>
  )
}
