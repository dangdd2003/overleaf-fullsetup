import { useCallback, useContext } from 'react'
import { ProjectContext } from '@/shared/context/project-context'
import { FileTreeDataContext } from '@/shared/context/file-tree-data-context'
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { pathInFolder } from '@/features/file-tree/util/path'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { ProjectSource } from './project-text'

/** How long a request waits for the project files before going on without them. */
const SNAPSHOT_TIMEOUT_MS = 4000
/** The open file's key when its path is unknown (outside the editor). */
const UNKNOWN_OPEN_PATH = 'open-file.tex'

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Reads the project for one request: every editable doc from the project
 * snapshot (refreshed first, as the assistant's read tools do), with the
 * open file's live text. The contexts are read without their throwing hooks:
 * outside the editor, or when the snapshot cannot be read in time, only the
 * open file is known and `complete` is false.
 */
export function useProjectSource(): () => Promise<ProjectSource> {
  const view = useCodeMirrorViewContext()
  const project = useContext(ProjectContext)
  const fileTree = useContext(FileTreeDataContext)
  const editorManager = useContext(EditorManagerContext)

  return useCallback(async () => {
    const tree = fileTree?.fileTreeData
    const openId = editorManager?.getCurrentDocumentId() ?? null
    const openPath =
      (tree && openId && pathInFolder(tree, openId)) || UNKNOWN_OPEN_PATH
    const rootId = project?.project?.rootDocId
    const rootPath = (tree && rootId && pathInFolder(tree, rootId)) || null

    const docs: Record<string, string> = {}
    let complete = false
    const snapshot = project?.projectSnapshot
    if (snapshot) {
      try {
        await withTimeout(snapshot.refresh(), SNAPSHOT_TIMEOUT_MS)
        for (const path of snapshot.getDocPaths()) {
          const content = snapshot.getDocContents(path)
          if (typeof content === 'string') {
            docs[path.replace(/^\//, '')] = content
          }
        }
        complete = true
      } catch {
        // Only the open file, below
      }
    }
    docs[openPath] = view.state.doc.toString()
    return { docs, rootPath, openPath, complete }
  }, [view, project, fileTree, editorManager])
}
