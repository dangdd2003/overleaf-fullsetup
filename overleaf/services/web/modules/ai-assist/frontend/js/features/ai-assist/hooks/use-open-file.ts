import { useCallback, useContext } from 'react'
import { FileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import { FileTreeDataContext } from '@/shared/context/file-tree-data-context'
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { Folder } from '@ol-types/folder'

/**
 * Searches the folder hierarchy for an entity matching a target path or filename.
 */
function searchTree(
  folder: Folder,
  cleanPath: string
): { _id: string; type: 'doc' | 'fileRef' } | null {
  const filename = cleanPath.split('/').pop() || cleanPath

  function search(f: Folder): { _id: string; type: 'doc' | 'fileRef' } | null {
    for (const doc of f.docs || []) {
      if (doc.name === filename || doc.name === cleanPath) {
        return { _id: doc._id, type: 'doc' }
      }
    }
    for (const ref of f.fileRefs || []) {
      if (ref.name === filename || ref.name === cleanPath) {
        return { _id: ref._id, type: 'fileRef' }
      }
    }
    for (const sub of f.folders || []) {
      const found = search(sub)
      if (found) return found
    }
    return null
  }

  return search(folder)
}

/**
 * Resolves a file path string to an entity ID and type.
 */
function resolveEntity(
  fileTreeContext: any,
  fileTreeData: Folder | undefined,
  rawPath: string
): { _id: string; type: 'doc' | 'fileRef' } | null {
  if (!rawPath) return null
  const clean = rawPath.trim().replace(/^\.\//, '').replace(/^\/+/, '')

  // 1. Direct path lookup from path context
  const direct = fileTreeContext?.findEntityByPath?.(clean)
  if (direct?.entity?._id && (direct.type === 'doc' || direct.type === 'fileRef')) {
    return { _id: direct.entity._id, type: direct.type }
  }

  // 2. Direct path lookup without extension or leading components
  if (fileTreeData) {
    const fromTree = searchTree(fileTreeData, clean)
    if (fromTree) return fromTree
  }

  return null
}

/**
 * Hook to open a file in the Overleaf editor by path, jumping to a specified line.
 *
 * Reliably resolves both absolute and relative paths (e.g. `tex/intro.tex`, `./tex/intro.tex`,
 * `intro.tex`), navigates to the file in the editor, positions the cursor, and scrolls
 * the requested line into view.
 */
export function useOpenFileInEditor(): (path: string, line?: number) => void {
  const fileTreeContext = useContext(FileTreePathContext)
  const fileTreeDataContext = useContext(FileTreeDataContext)
  const editorManager = useContext(EditorManagerContext)

  return useCallback(
    (path: string, line?: number) => {
      if (!path) return
      try {
        const entity = resolveEntity(
          fileTreeContext,
          fileTreeDataContext?.fileTreeData,
          path
        )

        if (!entity || !editorManager) return

        const targetLine =
          typeof line === 'number' && Number.isFinite(line) && line > 0
            ? line
            : undefined

        if (entity.type === 'doc') {
          // Open doc in editor with gotoLine option
          editorManager.openDocWithId?.(entity._id, {
            gotoLine: targetLine,
          })

          if (targetLine !== undefined) {
            // Direct jump in case the document was already active
            editorManager.jumpToLine?.({ gotoLine: targetLine })

            // Dispatch direct event for CodeMirror view
            window.dispatchEvent(
              new CustomEvent('aiAssist:jumpToLine', {
                detail: { line: targetLine },
              })
            )

            // Delayed jump retry to handle mounting transitions
            window.setTimeout(() => {
              editorManager.jumpToLine?.({ gotoLine: targetLine })
              window.dispatchEvent(
                new CustomEvent('aiAssist:jumpToLine', {
                  detail: { line: targetLine },
                })
              )
            }, 60)
          }
        } else {
          // Open binary or reference file
          editorManager.openFileWithId?.(entity._id)
        }
      } catch (err) {
        // Ignored in non-editor environments
      }
    },
    [fileTreeContext, fileTreeDataContext, editorManager]
  )
}
