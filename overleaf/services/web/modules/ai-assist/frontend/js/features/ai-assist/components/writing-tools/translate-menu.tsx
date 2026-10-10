import { KeyboardEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import { orderLanguages } from '../../writing-tools/languages'
import { readWritingToolsPreferences } from '../../writing-tools/preferences'

/**
 * The Translate flyout beside the Writing tools menu, in the same card:
 * recent languages first, then A–Z, with the search box at the bottom.
 */
export function TranslateMenu({
  onChoose,
  onMouseEnter,
  onMouseLeave,
  onBack,
}: {
  onChoose: (language: string) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  /** Left arrow: back to the Translate row. */
  onBack?: () => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [recentLanguages] = useState(
    () => readWritingToolsPreferences().recentLanguages
  )
  const { recent, others } = useMemo(
    () => orderLanguages(recentLanguages, query),
    [recentLanguages, query]
  )

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = recent[0] ?? others[0]
      if (first) onChoose(first)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      event.stopPropagation()
      onBack?.()
    }
  }

  const row = (language: string, isRecent: boolean) => (
    <button
      key={`${isRecent ? 'recent-' : ''}${language}`}
      type="button"
      role="menuitem"
      className="ai-texgpt-menu-item ai-texgpt-language"
      onClick={() => onChoose(language)}
    >
      <span className="ai-texgpt-menu-item-label">{language}</span>
      {isRecent && (
        <MaterialIcon type="history" className="ai-texgpt-menu-item-caret" />
      )}
    </button>
  )

  return (
    <div
      className="ai-texgpt-menu ai-texgpt-submenu"
      role="menu"
      aria-label={t('ai_assist_writing_tools_translate', 'Translate')}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={onKeyDown}
    >
      <div className="ai-texgpt-language-list">
        {recent.length > 0 && (
          <>
            <div className="ai-texgpt-menu-group">
              {recent.map(language => row(language, true))}
            </div>
            {others.length > 0 && <hr className="ai-texgpt-menu-divider" />}
          </>
        )}
        <div className="ai-texgpt-menu-group">
          {others.map(language => row(language, false))}
          {recent.length === 0 && others.length === 0 && (
            <div className="ai-texgpt-menu-empty">
              {t('ai_assist_writing_tools_no_languages', 'No languages found')}
            </div>
          )}
        </div>
      </div>
      <hr className="ai-texgpt-menu-divider" />
      <label className="ai-texgpt-search">
        <MaterialIcon type="search" />
        <input
          type="text"
          value={query}
          placeholder={t('ai_assist_writing_tools_search', 'Search…')}
          aria-label={t(
            'ai_assist_writing_tools_search_languages',
            'Search languages'
          )}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </label>
    </div>
  )
}
