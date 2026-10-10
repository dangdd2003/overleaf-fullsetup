import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import type { MaskedEdit } from './edits'

/** A result as shared: without the author's own dismissals. */
export type SharedEntry = { edits: MaskedEdit[]; text?: string; contexts?: string[] }

/** The project's results on the server, shared by its collaborators. */
export type SharedResults = {
  lookup: (keys: string[]) => Promise<Record<string, SharedEntry>>
  store: (entries: Array<{ key: string; entry: SharedEntry }>) => Promise<void>
}

/** What one lookup and one save may carry (the server's limits). */
export const LOOKUP_CHUNK = 500
export const STORE_CHUNK = 100

/** The open project's shared results; null outside a project. */
export function projectSharedResults(): SharedResults | null {
  const projectId = getMeta('ol-project_id')
  if (!projectId) return null
  const base = `/ai-assist/projects/${projectId}/language-checks`
  return {
    async lookup(keys) {
      const { entries } = await postJSON<{ entries: Record<string, SharedEntry> }>(
        `${base}/lookup`,
        { body: { keys } }
      )
      return entries ?? {}
    },
    async store(entries) {
      await postJSON(base, { body: { entries } })
    },
  }
}
