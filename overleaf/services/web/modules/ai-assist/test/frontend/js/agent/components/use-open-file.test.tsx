import { expect } from 'chai'
import sinon from 'sinon'
import React from 'react'
import { renderHook } from '@testing-library/react'
import { FileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'
import { FileTreeDataContext } from '@/shared/context/file-tree-data-context'
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useOpenFileInEditor } from '../../../../../frontend/js/features/ai-assist/hooks/use-open-file'

describe('useOpenFileInEditor', function () {
  let editorManager: any
  let fileTreeContext: any
  let fileTreeData: any

  beforeEach(function () {
    editorManager = {
      openDocWithId: sinon.stub().resolves(),
      openFileWithId: sinon.stub(),
      jumpToLine: sinon.stub(),
    }

    fileTreeData = {
      _id: 'root',
      name: 'root',
      docs: [{ _id: 'd1', name: 'main.tex' }],
      fileRefs: [{ _id: 'img1', name: 'plot.png' }],
      folders: [
        {
          _id: 'f1',
          name: 'tex',
          docs: [{ _id: 'd2', name: 'c2-materials_and_methods.tex' }],
          fileRefs: [],
          folders: [],
        },
      ],
    }

    fileTreeContext = {
      findEntityByPath: sinon.stub().callsFake((path: string) => {
        if (path === 'tex/c2-materials_and_methods.tex') {
          return { entity: { _id: 'd2' }, type: 'doc' }
        }
        if (path === 'main.tex') {
          return { entity: { _id: 'd1' }, type: 'doc' }
        }
        if (path === 'plot.png') {
          return { entity: { _id: 'img1' }, type: 'fileRef' }
        }
        return null
      }),
    }
  })

  const wrapper: React.FC<React.PropsWithChildren> = ({ children }) => (
    <FileTreeDataContext.Provider value={{ fileTreeData } as any}>
      <FileTreePathContext.Provider value={fileTreeContext}>
        <EditorManagerContext.Provider value={editorManager}>
          {children}
        </EditorManagerContext.Provider>
      </FileTreePathContext.Provider>
    </FileTreeDataContext.Provider>
  )

  it('opens a document and passes the line number', function () {
    const { result } = renderHook(() => useOpenFileInEditor(), { wrapper })
    result.current('tex/c2-materials_and_methods.tex', 16)

    expect(editorManager.openDocWithId.calledWith('d2', { gotoLine: 16 })).to.equal(true)
    expect(editorManager.jumpToLine.calledWith({ gotoLine: 16 })).to.equal(true)
  })

  it('normalizes paths with leading ./ and slashes', function () {
    const { result } = renderHook(() => useOpenFileInEditor(), { wrapper })
    result.current('./tex/c2-materials_and_methods.tex', 16)

    expect(editorManager.openDocWithId.calledWith('d2', { gotoLine: 16 })).to.equal(true)
  })

  it('falls back to finding file by name in tree when path context misses', function () {
    fileTreeContext.findEntityByPath.returns(null)

    const { result } = renderHook(() => useOpenFileInEditor(), { wrapper })
    result.current('c2-materials_and_methods.tex', 16)

    expect(editorManager.openDocWithId.calledWith('d2', { gotoLine: 16 })).to.equal(true)
  })

  it('opens binary files using openFileWithId', function () {
    const { result } = renderHook(() => useOpenFileInEditor(), { wrapper })
    result.current('plot.png')

    expect(editorManager.openFileWithId.calledWith('img1')).to.equal(true)
  })

  it('dispatches aiAssist:jumpToLine event with the line number', function () {
    const listener = sinon.stub()
    window.addEventListener('aiAssist:jumpToLine', listener)

    const { result } = renderHook(() => useOpenFileInEditor(), { wrapper })
    result.current('main.tex', 42)

    window.removeEventListener('aiAssist:jumpToLine', listener)
    expect(listener.called).to.equal(true)
    expect((listener.firstCall.args[0] as CustomEvent).detail).to.deep.equal({ line: 42 })
  })
})
