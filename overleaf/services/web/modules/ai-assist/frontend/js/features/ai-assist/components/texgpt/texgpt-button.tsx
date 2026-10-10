import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import { closeTexGpt, openTexGpt, texGptField } from '../../texgpt/target'
import { TexGptPopup } from './texgpt-popup'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Registered in `sourceEditorToolbarStartButtons`, which upstream renders at
 * the far left of the toolbar, before undo/redo, for editable documents only.
 */
export default function TexGptButton() {
  if (!isWritingToolsAvailable()) return null
  return <TexGptToolbarButton />
}

function TexGptToolbarButton() {
  const { t } = useTranslation()
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const open = Boolean(state.field(texGptField, false))
  const groupRef = useRef<HTMLDivElement>(null)

  const toggle = useCallback(() => {
    if (view.state.field(texGptField, false)) {
      view.dispatch({ effects: closeTexGpt.of(null) })
      return
    }
    const { from, to } = view.state.selection.main
    view.dispatch({ effects: openTexGpt.of({ from, to }) })
  }, [view])

  const label = t('ai_assist_texgpt', 'TeXGPT')
  const tooltipText = t(
    'ai_assist_texgpt_tooltip',
    'The AI that has done LaTex writing for you and more'
  )
  return (
    <div ref={groupRef} className="ol-editor-toolbar-button-group">
      <OLTooltip
        id="toolbar-texgpt"
        description={tooltipText}
        overlayProps={{ placement: 'bottom' }}
      >
        <button
          type="button"
          className={classNames('ol-cm-toolbar-button', 'ai-texgpt-toolbar-button', {
            active: open,
          })}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          // Keep the editor's selection: it is what TeXGPT works on
          onMouseDown={event => event.preventDefault()}
          onClick={toggle}
        >
          <MaterialIcon type="smart_toy" unfilled />
        </button>
      </OLTooltip>
      {open && <TexGptPopup anchorRef={groupRef} />}
    </div>
  )
}
