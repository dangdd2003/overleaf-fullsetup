import { KeyboardEvent, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, CaretUp } from '@phosphor-icons/react'
import {
  OLDropdown,
  OLDropdownDivider,
  OLDropdownMenu,
  OLDropdownToggle,
  OLDropdownItem,
} from '@/shared/components/ol/ol-dropdown-menu'
import OLFormSwitch from '@/shared/components/ol/ol-form-switch'
import { debugConsole } from '@/utils/debugging'
import {
  loadComposerPreferences,
  readReasoningEffort,
  readSettings,
  readThinking,
  writeReasoningEffort,
  writeThinking,
} from '../../provider-store'
import {
  REASONING_EFFORTS,
  ReasoningEffort,
  hasThinkingSwitch,
} from '../../providers/types'

/**
 * How hard the model reasons, from the levels the saved provider documents,
 * and whether it thinks at all where the provider has that switch. "Auto"
 * sends no level, so the provider's own default applies.
 */
export function ReasoningEffortPicker() {
  const { t } = useTranslation()
  const type = readSettings()?.type
  const [effort, setEffort] = useState(() =>
    type ? readReasoningEffort(type) : undefined
  )
  const [thinking, setThinking] = useState(() =>
    type ? readThinking(type) : false
  )
  const [open, setOpen] = useState(false)

  // The account holds the choices; this browser only keeps a copy
  useEffect(() => {
    if (!type) return
    loadComposerPreferences()
      .then(() => {
        setEffort(readReasoningEffort(type))
        setThinking(readThinking(type))
      })
      .catch(err => debugConsole.error('Loading AI preferences failed', err))
  }, [type])

  const levels = type ? REASONING_EFFORTS[type] : undefined

  const effortOptions = useMemo(
    () => (levels ? [undefined, ...levels] : []),
    [levels]
  )

  if (!type || !levels) return null

  const labels: Record<ReasoningEffort, string> = {
    none: t('ai_assist_effort_none', 'None'),
    minimal: t('ai_assist_effort_minimal', 'Minimal'),
    low: t('ai_assist_effort_low', 'Low'),
    medium: t('ai_assist_effort_medium', 'Medium'),
    high: t('ai_assist_effort_high', 'High'),
    xhigh: t('ai_assist_effort_xhigh', 'Extra'),
    max: t('ai_assist_effort_max', 'Max'),
  }
  const autoLabel = t('ai_assist_effort_auto', 'Auto')
  const thinkingLabel = t('ai_assist_thinking', 'Thinking')

  const choose = (next: ReasoningEffort | undefined) => {
    writeReasoningEffort(type, next)
    setEffort(next)
    setOpen(false)
  }

  const toggleThinking = (enabled: boolean) => {
    writeThinking(type, enabled)
    setThinking(enabled)
  }

  const onEffortMenuKeyDown = (event: KeyboardEvent) => {
    const num = parseInt(event.key, 10)
    if (!isNaN(num) && num >= 1 && num <= effortOptions.length) {
      event.preventDefault()
      choose(effortOptions[num - 1])
    }
  }

  return (
    <OLDropdown
      drop="up"
      align="end"
      className="d-inline-flex"
      show={open}
      onToggle={setOpen}
      onKeyDown={onEffortMenuKeyDown}
      autoClose="outside"
    >
      <OLDropdownToggle
        id="ai-assist-effort-toggle"
        as="button"
        className="ai-assist-mode-selector-btn"
        aria-label={t('ai_assist_reasoning_effort', 'Reasoning effort')}
        title={t('ai_assist_reasoning_effort', 'Reasoning effort')}
      >
        <span className="ai-assist-mode-icon">
          <Brain size={15} weight="bold" />
        </span>
        <span className="ai-assist-mode-label">
          {effort ? labels[effort] : autoLabel}
        </span>
        <CaretUp size={10} weight="bold" className="ai-assist-mode-caret" />
      </OLDropdownToggle>
      <OLDropdownMenu
        className="ai-assist-mode-menu is-compact"
        popperConfig={{
          modifiers: [
            {
              name: 'offset',
              options: {
                offset: [0, 6],
              },
            },
          ],
        }}
      >
        <div className="ai-assist-mode-menu-header">
          {t('ai_assist_effort', 'Effort')}
        </div>
        {effortOptions.map((level, index) => {
          const num = String(index + 1)
          const isSelected = level === effort
          return (
            <OLDropdownItem
              key={level ?? 'auto'}
              className={`ai-assist-mode-menu-row ${isSelected ? 'is-selected' : ''}`}
              onClick={() => choose(level)}
            >
              <div className="ai-assist-mode-item-text">
                <span className="ai-assist-mode-item-title">
                  {level ? labels[level] : autoLabel}
                </span>
              </div>
              <span className="ai-assist-mode-item-num">{num}</span>
            </OLDropdownItem>
          )
        })}
        {hasThinkingSwitch(type) && (
          <>
            <OLDropdownDivider />
            <div className="ai-assist-mode-menu-row ai-assist-effort-thinking">
              <label
                htmlFor="ai-assist-thinking-switch"
                className="ai-assist-mode-item-text"
              >
                <span className="ai-assist-mode-item-title">
                  {thinkingLabel}
                </span>
              </label>
              <OLFormSwitch
                id="ai-assist-thinking-switch"
                label={thinkingLabel}
                className="mb-0"
                checked={thinking}
                onChange={e => toggleThinking(e.target.checked)}
              />
            </div>
          </>
        )}
      </OLDropdownMenu>
    </OLDropdown>
  )
}
