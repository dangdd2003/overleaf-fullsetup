import { ButtonHTMLAttributes, KeyboardEvent, ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import { GENERATORS, GeneratorId } from '../../texgpt/generators'

export const GENERATOR_ICONS: Record<GeneratorId, string> = {
  title: 'password',
  abstract: 'text_snippet',
  keywords: 'rotate_auto',
}

/** Menu items and result titles, with the official Overleaf wording. */
export function useGeneratorLabel() {
  const { t } = useTranslation()
  return useCallback(
    (id: GeneratorId): string => {
      switch (id) {
        case 'title':
          return t('ai_assist_texgpt_title_generator', 'Title Generator')
        case 'abstract':
          return t('ai_assist_texgpt_abstract_generator', 'Abstract Generator')
        case 'keywords':
          return t('ai_assist_texgpt_keywords_generator', 'Keywords Generator')
      }
    },
    [t]
  )
}

/** The two-star sparkle, drawn in the text colour. */
export function TexGptSparkleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M15.1108 11.7579C10.1332 10.6339 9.36218 9.86286 8.23838 4.88542C8.18689 4.65792 7.9844 4.49588 7.75041 4.49588C7.51643 4.49588 7.31393 4.65791 7.26245 4.88542C6.1379 9.86306 5.36744 10.6341 0.390003 11.7579C0.162041 11.8099 0 12.0119 0 12.2458C0 12.4798 0.162033 12.6819 0.390003 12.7338C5.36764 13.8583 6.13804 14.6293 7.26245 19.6062C7.31393 19.8337 7.51643 19.9958 7.75041 19.9958C7.9844 19.9958 8.1869 19.8338 8.23838 19.6062C9.36292 14.6292 10.1334 13.8582 15.1108 12.7338C15.3388 12.6818 15.5004 12.4798 15.5004 12.2458C15.5004 12.0119 15.3383 11.8098 15.1108 11.7579Z" />
      <path d="M19.6103 4.00841C16.9642 3.41091 16.5926 3.03942 15.9952 0.393785C15.9432 0.165823 15.7412 0.00424194 15.5073 0.00424194C15.2733 0.00424194 15.0712 0.165727 15.0193 0.393785C14.4218 3.0392 14.0503 3.41081 11.4047 4.00841C11.1767 4.06044 11.0151 4.26239 11.0151 4.49637C11.0151 4.73035 11.1766 4.9324 11.4047 4.98434C14.0501 5.58184 14.4217 5.95332 15.0193 8.59936C15.0713 8.82686 15.2733 8.9889 15.5073 8.9889C15.7412 8.9889 15.9433 8.82687 15.9952 8.59936C16.5927 5.95334 16.9642 5.58174 19.6103 4.98434C19.8378 4.9323 19.9998 4.73035 19.9998 4.49637C19.9998 4.26239 19.8378 4.06035 19.6103 4.00841Z" />
    </svg>
  )
}

/** One row of a TeXGPT menu: icon, label, and the Enter hint while focused. */
export function TexGptMenuItem({
  icon,
  label,
  onClick,
  trailing,
  ...rest
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  /** Replaces the Enter hint, e.g. the Translate caret. */
  trailing?: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button
      type="button"
      role="menuitem"
      {...rest}
      className={classNames('ai-texgpt-menu-item', rest.className)}
      onClick={onClick}
    >
      <span className="ai-texgpt-menu-item-icon">{icon}</span>
      <span className="ai-texgpt-menu-item-label">{label}</span>
      {trailing ?? (
        <MaterialIcon type="turn_left" className="ai-texgpt-menu-item-action" />
      )}
    </button>
  )
}

/** Up/Down walk the items, wrapping around. */
function walk(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ]
  if (items.length === 0) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  items[(at + step + items.length) % items.length].focus()
}

/** The list under the prompt bar when nothing is selected. */
export function GeneratorMenu({
  onChoose,
  onCustomPrompt,
}: {
  onChoose: (id: GeneratorId) => void
  /** Opens the AI chat. */
  onCustomPrompt?: () => void
}) {
  const { t } = useTranslation()
  const label = useGeneratorLabel()
  return (
    <div
      className="ai-texgpt-menu"
      role="menu"
      aria-label={t('ai_assist_texgpt_generators', 'Generators')}
      onKeyDown={walk}
    >
      <div className="ai-texgpt-menu-group" role="group">
        {GENERATORS.map(id => (
          <TexGptMenuItem
            key={id}
            icon={<MaterialIcon type={GENERATOR_ICONS[id]} />}
            label={label(id)}
            onClick={() => onChoose(id)}
          />
        ))}
      </div>
      {onCustomPrompt && (
        <>
          <hr className="ai-texgpt-menu-divider" />
          <div className="ai-texgpt-menu-group" role="group">
            <TexGptMenuItem
              icon={<TexGptSparkleIcon />}
              label={t('ai_assist_texgpt_custom_prompt', 'Custom prompt')}
              onClick={onCustomPrompt}
            />
          </div>
        </>
      )}
    </div>
  )
}
