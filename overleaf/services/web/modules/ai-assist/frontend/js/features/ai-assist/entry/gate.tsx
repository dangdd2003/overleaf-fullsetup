import { Component, ComponentType, ReactNode, Suspense, lazy } from 'react'
import getMeta from '@/utils/meta'

// Core registers these slots through importOverleafModules, which statically
// imports every entry file. The entry files therefore must not import the AI
// implementation statically: they gate on the runtime meta and load the real
// code with import(), so a disabled instance never fetches the module chunks.
// The meta is rendered in the page head before the editor bundle runs.
export const aiAssistEnabled = (): boolean =>
  Boolean(getMeta('ol-aiAssistEnabled'))

class AiAssistErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(): void {
    // AI assist slots degrade silently so chunk/render failures never break core UI.
  }

  render(): ReactNode {
    if (this.state.hasError) return null
    return this.props.children
  }
}

/**
 * A component that renders nothing when disabled, else the lazily loaded one.
 * Props are passed through untyped: core renders these slots without props
 * contracts of their own.
 */
export function lazyComponent(
  load: () => Promise<{ default: ComponentType<any> }>
): ComponentType<any> {
  const Impl = lazy(load)
  function GatedComponent(props: Record<string, unknown>) {
    if (!aiAssistEnabled()) return null
    return (
      <AiAssistErrorBoundary>
        <Suspense fallback={null}>
          <Impl {...props} />
        </Suspense>
      </AiAssistErrorBoundary>
    )
  }
  GatedComponent.displayName = 'AiAssistGatedComponent'
  return GatedComponent
}

/**
 * For slots that must answer synchronously (generators, diagnostic actions).
 * The import starts only when enabled; the getter returns null until the chunk
 * has loaded and resets pending state if loading fails so a later call retries.
 */
export function preloaded<T>(load: () => Promise<T>): () => T | null {
  let value: T | null = null
  let pending: Promise<void> | null = null
  const ensureLoaded = () => {
    if (value !== null || pending || !aiAssistEnabled()) return
    pending = load()
      .then(loaded => {
        value = loaded
      })
      .catch(() => {
        pending = null
      })
  }
  ensureLoaded()
  return () => {
    if (value === null) ensureLoaded()
    return aiAssistEnabled() ? value : null
  }
}
