export type AgentMode = 'manual' | 'acceptEdits' | 'plan'

export const AGENT_MODES: AgentMode[] = ['manual', 'acceptEdits', 'plan']

export function nextMode(mode: AgentMode): AgentMode {
  const idx = AGENT_MODES.indexOf(mode)
  if (idx === -1) return 'manual'
  return AGENT_MODES[(idx + 1) % AGENT_MODES.length]
}
