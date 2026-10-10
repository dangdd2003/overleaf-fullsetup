import { useCallback, useEffect, useState } from 'react'

export type DockPosition = 'left' | 'right'

const DOCK_STORAGE_KEY = 'ai-assist:dock-position'
const RIGHT_OPEN_STORAGE_KEY = 'ai-assist:right-open'

export function readStoredDock(): DockPosition {
  try {
    const val = localStorage.getItem(DOCK_STORAGE_KEY)
    return val === 'right' ? 'right' : 'left'
  } catch {
    return 'left'
  }
}

function readStoredRightOpen(): boolean {
  try {
    const val = localStorage.getItem(RIGHT_OPEN_STORAGE_KEY)
    return val !== 'false'
  } catch {
    return true
  }
}

function writeRightOpen(open: boolean) {
  try {
    localStorage.setItem(RIGHT_OPEN_STORAGE_KEY, String(open))
  } catch {}
  window.dispatchEvent(new CustomEvent('aiAssist:dockChange'))
}

/**
 * Opens the AI chat wherever it is docked (the right column or the rail tab)
 * and puts the cursor in its message box. The editor selection stays, so the
 * chat attaches it as usual.
 */
export function openAiChat() {
  if (readStoredDock() === 'right') {
    writeRightOpen(true)
  } else {
    window.dispatchEvent(
      new CustomEvent('ui:select-rail-tab', {
        detail: { tab: 'ai-assist', open: true },
      })
    )
  }
  // After the panel has had a chance to mount: attach the selection, then
  // put the cursor in the message box
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('aiAssist:announceSelection'))
    window.dispatchEvent(new CustomEvent('aiAssist:focusComposer'))
  }, 100)
}

export function useAiDock() {
  const [dock, setDockState] = useState<DockPosition>(readStoredDock)
  const [isRightOpen, setIsRightOpenState] =
    useState<boolean>(readStoredRightOpen)

  useEffect(() => {
    const onStorage = (e?: Event) => {
      if (
        e &&
        'key' in e &&
        (e as StorageEvent).key &&
        (e as StorageEvent).key !== DOCK_STORAGE_KEY &&
        (e as StorageEvent).key !== RIGHT_OPEN_STORAGE_KEY
      ) {
        return
      }
      setDockState(readStoredDock())
      setIsRightOpenState(readStoredRightOpen())
    }
    window.addEventListener('aiAssist:dockChange', onStorage)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('aiAssist:dockChange', onStorage)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setDock = useCallback((newDock: DockPosition) => {
    try {
      localStorage.setItem(DOCK_STORAGE_KEY, newDock)
    } catch {}
    setDockState(newDock)
    window.dispatchEvent(new CustomEvent('aiAssist:dockChange'))
  }, [])

  const setIsRightOpen = useCallback((open: boolean) => {
    setIsRightOpenState(open)
    writeRightOpen(open)
  }, [])

  const toggleDock = useCallback(() => {
    setDock(dock === 'right' ? 'left' : 'right')
  }, [dock, setDock])

  const toggleRightOpen = useCallback(() => {
    setIsRightOpen(!isRightOpen)
  }, [isRightOpen, setIsRightOpen])

  return {
    dock,
    setDock,
    toggleDock,
    isRightOpen,
    setIsRightOpen,
    toggleRightOpen,
  }
}
