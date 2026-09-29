import { forwardRef } from 'react'
import RailTab from '@/features/ide-react/components/rail/rail-tab'
import { AgentPanel } from './components/agent/agent-panel'
import { AiRailIcon } from './components/ai-rail-icon'
import getMeta from '@/utils/meta'
import { useAiDock } from './hooks/use-ai-dock'
import '../../../stylesheets/ai-assist.scss'

const AiRailTab = forwardRef<HTMLButtonElement, any>((props, ref) => {
  const { dock, isRightOpen, toggleRightOpen } = useAiDock()

  const handleClick = (e: React.MouseEvent) => {
    if (dock === 'right') {
      e.preventDefault()
      e.stopPropagation()
      toggleRightOpen()
      return
    }
    props.onClick?.(e)
  }

  const isActuallyOpen = dock === 'right' ? isRightOpen : props.open

  return (
    <RailTab
      {...props}
      icon={props.icon ?? AiRailIcon}
      title={props.title ?? 'AI assistant'}
      ref={ref}
      eventKey={dock === 'right' ? undefined : props.eventKey}
      open={isActuallyOpen}
      onClick={handleClick}
    />
  )
})

AiRailTab.displayName = 'AiRailTab'

function LeftRailAgentPanel() {
  const { dock } = useAiDock()
  if (dock === 'right') {
    return null
  }
  return <AgentPanel dock="left" />
}

export default {
  key: 'ai-assist',
  icon: AiRailIcon,
  title: 'AI assistant',
  tab: AiRailTab,
  component: <LeftRailAgentPanel />,
  hide: () =>
    !getMeta('ol-aiAssistEnabled') ||
    getMeta('ol-showAiFeatures') === false,
}
