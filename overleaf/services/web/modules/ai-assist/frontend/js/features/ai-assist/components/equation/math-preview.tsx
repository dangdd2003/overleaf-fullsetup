import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { MathProblems, renderMath } from '../../equation/math-render'

type PreviewState =
  | { status: 'rendering' }
  | { status: 'ready'; problems: MathProblems }
  | { status: 'unavailable' }

/** The math as it will look, typeset by the editor's own MathJax. */
export function MathPreview({
  tex,
  display,
  definitions,
}: {
  tex: string
  display: boolean
  definitions: string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PreviewState>({ status: 'rendering' })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let cancelled = false
    setState({ status: 'rendering' })
    renderMath(element, tex, display, definitions).then(
      problems => {
        if (!cancelled) setState({ status: 'ready', problems })
      },
      () => {
        if (!cancelled) setState({ status: 'unavailable' })
      }
    )
    return () => {
      cancelled = true
    }
  }, [tex, display, definitions])

  return (
    <div className={classNames('ai-equation-preview', { 'is-inline': !display })}>
      <div ref={ref} className="ai-equation-preview-math" role="img" aria-label={tex} />
      {state.status === 'unavailable' && (
        <p className="ai-equation-preview-note">
          {t(
            'ai_assist_equation_preview_unavailable',
            'The preview is unavailable. Check the LaTeX below.'
          )}
        </p>
      )}
      {state.status === 'ready' &&
        state.problems.errors.map(error => (
          <p key={error} className="ai-equation-preview-error">
            {error}
          </p>
        ))}
    </div>
  )
}
