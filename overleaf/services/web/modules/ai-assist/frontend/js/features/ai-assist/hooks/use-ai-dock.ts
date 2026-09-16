import { useCallback, useEffect, useState } from 'react'

export type DockPosition = 'left' | 'right'

const DOCK_STORAGE_KEY = 'ai-assist:dock-position'
const RIGHT_OPEN_STORAGE_KEY = 'ai-assist:right-open'

function readStoredDock(): DockPosition {
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
    try {
      localStorage.setItem(RIGHT_OPEN_STORAGE_KEY, String(open))
    } catch {}
    setIsRightOpenState(open)
    window.dispatchEvent(new CustomEvent('aiAssist:dockChange'))
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
