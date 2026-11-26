import { forwardRef } from 'react'
import RailTab from '@/features/ide-react/components/rail/rail-tab'
import { AiRailIcon } from './components/ai-rail-icon'
import getMeta from '@/utils/meta'
import { useAiDock } from './hooks/use-ai-dock'
import { aiAssistEnabled, lazyComponent } from './entry/gate'

const AgentPanel = lazyComponent(() =>
  import(
    /* webpackChunkName: "ai-assist-agent-panel" */ './components/agent/agent-panel'
  ).then(m => ({ default: m.AgentPanel }))
)

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

function EnabledLeftRailAgentPanel() {
  const { dock } = useAiDock()
  if (dock === 'right') {
    return null
  }
  return <AgentPanel dock="left" />
}

function LeftRailAgentPanel() {
  if (!aiAssistEnabled() || getMeta('ol-showAiFeatures') === false) {
    return null
  }
  return <EnabledLeftRailAgentPanel />
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
