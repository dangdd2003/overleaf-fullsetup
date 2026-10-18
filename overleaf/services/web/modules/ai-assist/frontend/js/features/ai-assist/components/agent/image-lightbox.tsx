import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  DownloadSimple,
  Plus,
  Minus,
  ArrowCounterClockwise,
} from '@phosphor-icons/react'
import { suggestCaptureTitle } from '../../pdf/crop'

export interface ImageLightboxProps {
  src: string
  alt?: string
  title?: string
  downloadName?: string
  isOpen: boolean
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Calculates pan boundaries to strictly constrain the image within the viewport.
 * When the image is larger than the viewport, panning is bounded so its edges
 * cannot be dragged past the screen edges.
 * When the image is smaller, it can only be moved within the screen borders.
 */
export function calculatePanBounds(
  imageWidth: number,
  imageHeight: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  const sw = imageWidth * scale
  const sh = imageHeight * scale

  const maxX =
    sw > viewportWidth
      ? (sw - viewportWidth) / 2
      : Math.max(0, (viewportWidth - sw) / 2)
  const minX = -maxX

  const maxY =
    sh > viewportHeight
      ? (sh - viewportHeight) / 2
      : Math.max(0, (viewportHeight - sh) / 2)
  const minY = -maxY

  return { minX, maxX, minY, maxY }
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  src,
  alt = 'Image preview',
  title,
  downloadName,
  isOpen,
  onClose,
  triggerRef,
}) => {
  const [isRendered, setIsRendered] = useState(isOpen)
  const [isClosing, setIsClosing] = useState(false)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const [isZoomMenuOpen, setIsZoomMenuOpen] = useState(false)
  const [zoomInputValue, setZoomInputValue] = useState('100%')

  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const zoomMenuRef = useRef<HTMLDivElement>(null)
  const zoomBadgeRef = useRef<HTMLButtonElement>(null)
  const zoomInputRef = useRef<HTMLInputElement>(null)

  const defaultFilename =
    downloadName ||
    title ||
    suggestCaptureTitle({
      mediaType: src.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
    })

  const getBounds = useCallback((currentScale: number) => {
    const img = imageRef.current
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth || 1000
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 800
    const baseW = img?.offsetWidth || img?.naturalWidth || viewportWidth * 0.8
    const baseH =
      img?.offsetHeight || img?.naturalHeight || viewportHeight * 0.7
    return calculatePanBounds(
      baseW,
      baseH,
      currentScale,
      viewportWidth,
      viewportHeight
    )
  }, [])

  // Handle open / close animation lifecycle
  useEffect(() => {
    if (isOpen) {
      setIsRendered(true)
      setIsClosing(false)
      setScale(1)
      setPan({ x: 0, y: 0 })
      setIsZoomMenuOpen(false)
    } else if (isRendered) {
      setIsClosing(true)
      const timer = setTimeout(() => {
        setIsRendered(false)
        setIsClosing(false)
        setScale(1)
        setPan({ x: 0, y: 0 })
        setIsZoomMenuOpen(false)
      }, 180)
      return () => clearTimeout(timer)
    }
  }, [isOpen, isRendered])

  const applyCustomZoom = useCallback(
    (zoomPercent: number) => {
      const nextScale = Math.min(
        Math.max(Number((zoomPercent / 100).toFixed(2)), 0.2),
        5
      )
      setScale(nextScale)
      if (nextScale === 1) {
        setPan({ x: 0, y: 0 })
      } else {
        setPan(prevPan => {
          const { minX, maxX, minY, maxY } = getBounds(nextScale)
          return {
            x: Math.min(Math.max(prevPan.x, minX), maxX),
            y: Math.min(Math.max(prevPan.y, minY), maxY),
          }
        })
      }
    },
    [getBounds]
  )

  // Mouse wheel zoom handler across full viewport
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const zoomStep = 0.25
      const delta = e.deltaY < 0 ? zoomStep : -zoomStep
      setScale(prevScale => {
        const nextScale = Math.min(
          Math.max(Number((prevScale + delta).toFixed(2)), 0.2),
          5
        )
        if (nextScale === 1) {
          setPan({ x: 0, y: 0 })
        } else {
          setPan(prevPan => {
            const { minX, maxX, minY, maxY } = getBounds(nextScale)
            return {
              x: Math.min(Math.max(prevPan.x, minX), maxX),
              y: Math.min(Math.max(prevPan.y, minY), maxY),
            }
          })
        }
        return nextScale
      })
    },
    [getBounds]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || !isRendered || isClosing) return

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', handleWheel)
    }
  }, [isRendered, isClosing, handleWheel])

  // Pointer dragging to pan image across full viewport with strict edge limits
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return
    e.preventDefault()
    e.stopPropagation()
    const dx = e.clientX - dragStartRef.current.x
    const dy = e.clientY - dragStartRef.current.y
    const targetX = dragStartRef.current.panX + dx
    const targetY = dragStartRef.current.panY + dy

    // Strictly enforce edge limits so the image cannot be dragged off screen
    const { minX, maxX, minY, maxY } = getBounds(scale)
    setPan({
      x: Math.min(Math.max(targetX, minX), maxX),
      y: Math.min(Math.max(targetY, minY), maxY),
    })
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDragging) {
      setIsDragging(false)
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      } catch {
        // Ignored
      }
    }
  }

  // Double click toggles zoom between 1x and 2x
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (scale !== 1 || pan.x !== 0 || pan.y !== 0) {
      setScale(1)
      setPan({ x: 0, y: 0 })
    } else {
      setScale(2)
    }
  }

  const handleZoomIn = () => {
    setScale(prev => {
      const next = Math.min(Number((prev + 0.25).toFixed(2)), 5)
      setPan(prevPan => {
        const { minX, maxX, minY, maxY } = getBounds(next)
        return {
          x: Math.min(Math.max(prevPan.x, minX), maxX),
          y: Math.min(Math.max(prevPan.y, minY), maxY),
        }
      })
      return next
    })
  }

  const handleZoomOut = () => {
    setScale(prev => {
      const next = Math.max(Number((prev - 0.25).toFixed(2)), 0.2)
      if (next === 1) {
        setPan({ x: 0, y: 0 })
      } else {
        setPan(prevPan => {
          const { minX, maxX, minY, maxY } = getBounds(next)
          return {
            x: Math.min(Math.max(prevPan.x, minX), maxX),
            y: Math.min(Math.max(prevPan.y, minY), maxY),
          }
        })
      }
      return next
    })
  }

  const handleResetZoom = () => {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setIsZoomMenuOpen(false)
  }

  const handleToggleZoomMenu = () => {
    setIsZoomMenuOpen(prev => {
      const next = !prev
      if (next) {
        setZoomInputValue(`${Math.round(scale * 100)}%`)
        setTimeout(() => {
          zoomInputRef.current?.focus()
          zoomInputRef.current?.select()
        }, 10)
      }
      return next
    })
  }

  const handleCommitCustomZoom = () => {
    const parsed = parseFloat(zoomInputValue.replace(/[^0-9.]/g, ''))
    if (!isNaN(parsed) && parsed > 0) {
      applyCustomZoom(parsed)
    }
    setIsZoomMenuOpen(false)
  }

  // Dismiss zoom menu when clicking outside
  useEffect(() => {
    if (!isZoomMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        zoomMenuRef.current &&
        !zoomMenuRef.current.contains(e.target as Node) &&
        zoomBadgeRef.current &&
        !zoomBadgeRef.current.contains(e.target as Node)
      ) {
        setIsZoomMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isZoomMenuOpen])

  const handleDownload = () => {
    const link = document.createElement('a')
    link.href = src
    link.download = defaultFilename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Escape key handler & focus trap
  useEffect(() => {
    if (!isRendered || isClosing) return

    closeButtonRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (typeof (e as any).stopImmediatePropagation === 'function') {
          ;(e as any).stopImmediatePropagation()
        }
        if (isZoomMenuOpen) {
          setIsZoomMenuOpen(false)
          return
        }
        onClose()
      }
    }

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', handleKeyDown, true)
      triggerRef?.current?.focus?.({ preventScroll: true })
    }
  }, [isRendered, isClosing, isZoomMenuOpen, onClose, triggerRef])

  if (!isRendered) return null

  return createPortal(
    <div
      ref={containerRef}
      className={`ai-assist-lightbox-overlay ${isClosing ? 'is-leaving' : 'is-entering'}`}
      onClick={e => {
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
      role="presentation"
    >
      {/* Full Viewport Canvas */}
      <div
        className="ai-assist-lightbox-stage ai-assist-lightbox-container"
        role="dialog"
        aria-modal="true"
        aria-label={title || alt}
        tabIndex={-1}
        onClick={e => {
          if (e.target === e.currentTarget) {
            onClose()
          }
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={title || alt}
          title={title || alt}
          className={`ai-assist-lightbox-image${isDragging ? ' is-dragging' : ''}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'zoom-in',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          draggable={false}
        />
      </div>

      {/* Unified Bottom Action Dock: Centered at bottom, matching Overleaf theme */}
      <div
        className="ai-assist-lightbox-bottom-dock"
        role="toolbar"
        aria-label="Image viewer controls"
        onClick={e => e.stopPropagation()}
      >
        {/* Floating Manual Zoom Menu Popover */}
        {isZoomMenuOpen && (
          <div
            ref={zoomMenuRef}
            className="ai-assist-lightbox-zoom-popover"
            role="menu"
            aria-label="Set custom zoom size"
          >
            <form
              className="ai-assist-lightbox-zoom-input-form"
              onSubmit={e => {
                e.preventDefault()
                handleCommitCustomZoom()
              }}
            >
              <input
                ref={zoomInputRef}
                type="text"
                className="ai-assist-lightbox-zoom-input"
                value={zoomInputValue}
                onChange={e => setZoomInputValue(e.target.value)}
                placeholder="100%"
                aria-label="Custom zoom percentage"
              />
              <button
                type="submit"
                className="btn btn-sm btn-primary ai-assist-lightbox-zoom-set-btn"
              >
                Set
              </button>
            </form>
            <div className="ai-assist-lightbox-zoom-presets-grid">
              {[50, 75, 100, 150, 200, 300, 400].map(val => (
                <button
                  key={val}
                  type="button"
                  className={`btn btn-sm btn-ghost ai-assist-lightbox-zoom-preset-btn${
                    Math.round(scale * 100) === val ? ' is-active' : ''
                  }`}
                  onClick={() => {
                    applyCustomZoom(val)
                    setIsZoomMenuOpen(false)
                  }}
                >
                  {val}%
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm ai-assist-lightbox-btn"
          onClick={handleZoomOut}
          disabled={scale <= 0.2}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Minus size={16} aria-hidden="true" />
        </button>

        {/* Percentage button opens manual size popover, does NOT auto-revert to 100% */}
        <button
          ref={zoomBadgeRef}
          type="button"
          className={`btn btn-ghost btn-sm ai-assist-lightbox-btn ai-assist-lightbox-zoom-badge ai-assist-lightbox-zoom-level${
            isZoomMenuOpen ? ' is-active' : ''
          }`}
          onClick={handleToggleZoomMenu}
          aria-expanded={isZoomMenuOpen}
          aria-label="Set zoom size"
          title="Click to manually set zoom size"
        >
          {Math.round(scale * 100)}%
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm ai-assist-lightbox-btn"
          onClick={handleZoomIn}
          disabled={scale >= 5}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Plus size={16} aria-hidden="true" />
        </button>

        <span className="ai-assist-lightbox-dock-divider" aria-hidden="true" />

        {/* Dedicated Return / Fit-to-screen button: this reverts to 100% */}
        <button
          type="button"
          className="btn btn-ghost btn-sm ai-assist-lightbox-btn ai-assist-lightbox-zoom-reset"
          onClick={handleResetZoom}
          disabled={scale === 1 && pan.x === 0 && pan.y === 0}
          aria-label="Return to 100% (Fit to screen)"
          title="Return to 100% (Fit to screen)"
        >
          <ArrowCounterClockwise size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm ai-assist-lightbox-btn ai-assist-lightbox-download-btn"
          onClick={handleDownload}
          aria-label={`Download image (${defaultFilename})`}
          title={`Download image (${defaultFilename})`}
        >
          <DownloadSimple size={16} aria-hidden="true" />
        </button>

        <span className="ai-assist-lightbox-dock-divider" aria-hidden="true" />

        <button
          ref={closeButtonRef}
          type="button"
          className="btn btn-ghost btn-sm ai-assist-lightbox-btn ai-assist-lightbox-close-btn"
          onClick={onClose}
          aria-label="Close preview (Esc)"
          title="Close (Esc)"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body
  )
}
