import { useEffect, useRef, useState } from 'react'
import customLocalStorage from '@/infrastructure/local-storage'
import { ProjectFile, ProjectHandle } from '../project-handle'
import { AdvancedTool, deriveAdvancedTools } from './derive-advanced-tools'

const keyFor = (projectId: string) => `ai-assist:advanced-tools:${projectId}`

/**
 * Project-derived advanced tools for the empty chat state.
 *
 * Same lifecycle as the starters: cached cards paint first, the project is
 * re-read once on mount and on every new chat, and nothing reshuffles while
 * the user types.
 */
export function useAdvancedTools({
  handle,
  files,
  projectId = 'default',
  refreshSeed = 0,
}: {
  handle: ProjectHandle
  files?: ProjectFile[]
  projectId?: string
  refreshSeed?: number
}): AdvancedTool[] {
  const [tools, setTools] = useState<AdvancedTool[]>(() => {
    try {
      const cached = customLocalStorage.getItem(keyFor(projectId))
      if (Array.isArray(cached) && cached.length > 0) {
        return cached
      }
    } catch {}

    return deriveAdvancedTools({
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

  useEffect(() => {
    let mounted = true

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
        if (lastKeyRef.current === currentKey) return

        const result = deriveAdvancedTools({
          index: loadedIndex,
          files: loadedFiles,
          lastCompile: handle?.lastCompile?.() ?? null,
          openFile: handle?.openFile?.() ?? null,
        })

        if (!mounted) return
        lastKeyRef.current = currentKey
        setTools(result)
        customLocalStorage.setItem(keyFor(projectId), result)
      } catch {
        // Retain the existing cards on error
      }
    }

    computeAndSave()

    return () => {
      mounted = false
    }
  }, [handle, files, projectId, refreshSeed, compileKey])

  return tools
}
