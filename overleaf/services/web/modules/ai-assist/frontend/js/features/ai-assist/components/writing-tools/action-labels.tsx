import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowsClockwise,
  ArrowsInSimple,
  ArrowsMerge,
  BookOpenText,
  Flask,
  Icon,
  Scissors,
  Translate,
} from '@phosphor-icons/react'
import { WritingActionId } from '../../writing-tools/actions'

export const ACTION_ICONS: Record<WritingActionId, Icon> = {
  rephrase: ArrowsClockwise,
  shorten: ArrowsInSimple,
  scientific: Flask,
  split: Scissors,
  join: ArrowsMerge,
  synonyms: BookOpenText,
  translate: Translate,
}

/** Menu and card titles, with the official Overleaf wording. */
export function useActionLabel() {
  const { t } = useTranslation()
  return useCallback(
    (action: WritingActionId): string => {
      switch (action) {
        case 'rephrase':
          return t('ai_assist_writing_tools_rephrase', 'Rephrase')
        case 'shorten':
          return t('ai_assist_writing_tools_shorten', 'Shorten')
        case 'scientific':
          return t('ai_assist_writing_tools_scientific', 'More scientific')
        case 'split':
          return t('ai_assist_writing_tools_split', 'Split long sentences')
        case 'join':
          return t('ai_assist_writing_tools_join', 'Join short sentences')
        case 'synonyms':
          return t('ai_assist_writing_tools_synonyms', 'Synonyms')
        case 'translate':
          return t('ai_assist_writing_tools_translate', 'Translate')
      }
    },
    [t]
  )
}
