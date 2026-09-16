import { useEffect, useState, useRef } from 'react'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectFile, ProjectHandle } from '../project-handle'
import { deriveStarters, Starter } from './derive-starters'

const keyFor = (projectId: string) => `ai-assist:starters:${projectId}`

export function clearStartersCache(projectId: string): void {
  try {
    customLocalStorage.removeItem(keyFor(projectId))
  } catch {}
}

/**
 * Project-derived starters for the empty chat state.
 *
 * Guarantees zero-blink loading: on page reload, cached starters are returned
 * synchronously on first paint and remain static while viewing the project.
 * Clicking "New chat" refreshes the list with fresh suggestions matching the
 * latest project state and variety from the fallback pool.
 */
export function useProjectStarters({
  handle,
  files,
  projectId = 'default',
  refreshSeed = 0,
}: {
  handle: ProjectHandle
  files?: ProjectFile[]
  projectId?: string
  refreshSeed?: number
}): Starter[] {
  // Synchronous restoration from cache to prevent any flashing on reload
  const [starters, setStarters] = useState<Starter[]>(() => {
    try {
      const cached = customLocalStorage.getItem(keyFor(projectId))
      if (Array.isArray(cached) && cached.length > 0) {
        return cached
      }
    } catch {}

    // First paint fallback when no cache exists yet
    return deriveStarters({
      index: null,
      files: files ?? [],
      lastCompile: handle?.lastCompile?.() ?? null,
      openFile: handle?.openFile?.() ?? null,
    })
  })

  const lastCompile = handle?.lastCompile?.() ?? null
  const compileKey = lastCompile
    ? `${lastCompile.status}:${lastCompile.errors.length}:${lastCompile.warnings.length}`
    : 'no-compile'

  const lastKeyRef = useRef<string | null>(null)
  const lastSeedRef = useRef(refreshSeed)

  useEffect(() => {
    let mounted = true
    const isNewChatRefresh = lastSeedRef.current !== refreshSeed
    lastSeedRef.current = refreshSeed

    const computeAndSave = async () => {
      try {
        const [loadedFiles, loadedIndex] = await Promise.all([
          files && files.length > 0
            ? Promise.resolve(files)
            : handle?.listFiles?.().catch(() => []) ?? Promise.resolve([]),
          handle?.index?.().catch(() => null) ?? Promise.resolve(null),
        ])

        if (!mounted) return

        const currentKey = `${projectId}:${refreshSeed}:${compileKey}:${loadedIndex?.hash ?? ''}`
        if (lastKeyRef.current === currentKey && !isNewChatRefresh) {
          return
        }

        const result = deriveStarters(
          {
            index: loadedIndex,
            files: loadedFiles,
            lastCompile: handle?.lastCompile?.() ?? null,
            openFile: handle?.openFile?.() ?? null,
          },
          { shuffle: isNewChatRefresh }
        )

        if (!mounted) return
        lastKeyRef.current = currentKey
        setStarters(result)
        customLocalStorage.setItem(keyFor(projectId), result)
      } catch {
        // Retain existing starters on error
      }
    }

    computeAndSave()

    return () => {
      mounted = false
    }
  }, [handle, files, projectId, refreshSeed, compileKey])

  return starters
}
