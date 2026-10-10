import { createPortal } from 'react-dom'
import { getTooltip } from '@codemirror/view'
import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from '@/features/source-editor/components/codemirror-context'
import { isWritingToolsAvailable } from '../../writing-tools/availability'
import { writingSessionField } from '../../writing-tools/extension'
import { WritingToolsPanel } from './writing-tools-panel'
import '../../../../../stylesheets/ai-assist.scss'

/**
 * Registered in `sourceEditorComponents`. Portals the result card into the
 * CodeMirror tooltip the writing session provides, so the card scrolls and
 * flips with the text like any editor tooltip.
 */
export default function WritingToolsCard() {
  if (!isWritingToolsAvailable()) return null
  return <WritingToolsCardHost />
}

function WritingToolsCardHost() {
  const view = useCodeMirrorViewContext()
  const state = useCodeMirrorStateContext()
  const session = state.field(writingSessionField, false)
  if (!session) return null
  const tooltipView = getTooltip(view, session.tooltip)
  if (!tooltipView) return null
  return createPortal(
    <WritingToolsPanel key={session.id} session={session} />,
    tooltipView.dom
  )
}
