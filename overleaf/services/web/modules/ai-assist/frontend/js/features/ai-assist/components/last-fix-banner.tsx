import { useContext, useEffect, useMemo, useState } from 'react'
import getMeta from '@/utils/meta'
import useEventListener from '@/shared/hooks/use-event-listener'
import { ProjectContext } from '@/shared/context/project-context'
import { useDetachCompileContext } from '@/shared/context/detach-compile-context'
import { getLastCompletedFix, LastFixSummary, buildLogEntryFingerprint } from '../agent/fix-store'
import SuggestFixPanel from './suggest-fix-panel'
import '../../../../stylesheets/ai-assist.scss'

/**
 * Keeps the last suggested fix reachable after its log entry is gone.
 *
 * Fixing an error and recompiling routinely makes that error's log entry
 * disappear entirely, which unmounts the `SuggestFixPanel` living inside it —
 * taking the only way to look back at what the assistant did with it. This
 * renders once at the top of the whole log list (see `pdfLogEntriesComponents`
 * in settings.defaults.js), independent of any single entry, and reuses
 * `SuggestFixPanel` itself with a stand-in `logEntry` built from the
 * project+fingerprint the real one already stored its fix under — so it comes
 * up folded exactly like the "Last suggested fix" summary already does, with
 * the same Re-open button.
 */
export default function LastFixBanner() {
  const enabled =
    Boolean(getMeta('ol-aiAssistEnabled')) && getMeta('ol-showAiFeatures') !== false

  const projectContext = useContext(ProjectContext)
  const projectId = projectContext?.projectId || 'default'
  const { logEntries } = useDetachCompileContext()

  const [summary, setSummary] = useState<LastFixSummary | null>(null)

  const refresh = () => setSummary(getLastCompletedFix(projectId))

  useEventListener('aiAssist:suggestDone', refresh)

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // The fingerprint (file+line+message) is still present in the current
  // compile log, meaning the error it was for hasn't actually gone away —
  // its own inline panel is still mounted under it and already shows this
  // exact fix. Showing the summary again here would just duplicate it.
  const stillLive = useMemo(() => {
    if (!summary || !logEntries?.all) return false
    return logEntries.all.some(
      entry => buildLogEntryFingerprint(entry) === summary.fingerprint
    )
  }, [summary, logEntries])

  if (!enabled || !summary || stillLive) return null

  return (
    <SuggestFixPanel
      forceCollapsed
      logEntry={{
        key: summary.entryId,
        file: summary.file,
        line: summary.line,
        message: summary.message,
        level: summary.level,
      }}
    />
  )
}
