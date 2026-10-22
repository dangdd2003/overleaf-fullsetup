import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TextT } from '@phosphor-icons/react'
import { ContextChip } from '../components/agent/context-chip'
import {
  removePdfArea,
  removePdfSelection,
  usePdfTurnContext,
} from './turn-context'

const MAX_SNIPPET = 40
const MAX_TOOLTIP = 300

function flat(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function snippet(text: string, max = MAX_SNIPPET) {
  const line = flat(text)
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * The PDF items waiting for the next message: every text selection and area
 * the user added, then any capture still running. Rendered in the composer's
 * chip row with the same chip as editor code, files and images.
 */
export function PdfContextChips() {
  const { t } = useTranslation()
  const { selections, areas, pendingAreas } = usePdfTurnContext()
  const removeLabel = t('ai_assist_pdf_remove_context', {
    defaultValue: 'Remove',
  })
  const page = (number: number) =>
    t('ai_assist_pdf_page_chip', { defaultValue: 'PDF p.__page__', page: number })

  const thumbnails = useMemo(() => {
    return areas.map(area =>
      area.image ? `data:${area.image.mediaType};base64,${area.image.data}` : undefined
    )
  }, [areas])

  return (
    <>
      {selections.map((selection, index) => (
        <ContextChip
          key={`pdf-text-${index}-${selection.page}`}
          className="ai-assist-pdf-text-chip"
          icon={<TextT size={12} weight="bold" />}
          source={page(selection.page)}
          detail={`"${snippet(selection.text)}"`}
          title={`${page(selection.page)}: "${snippet(selection.text, MAX_TOOLTIP)}"`}
          removeLabel={removeLabel}
          onRemove={() => removePdfSelection(index)}
        />
      ))}
      {areas.map((area, index) => {
        const source = area.source
          ? t('ai_assist_pdf_area_source', {
              defaultValue: '__path__:__line__-__endLine__',
              path: area.source.path,
              line: area.source.line,
              endLine: area.source.endLine,
            })
          : undefined
        const label = t('ai_assist_pdf_area_chip', {
          defaultValue: 'PDF p.__page__ area',
          page: area.page,
        })
        return (
          <ContextChip
            key={area.id || `pdf-area-${index}-${area.page}`}
            className="ai-assist-pdf-area-chip"
            thumbnail={thumbnails[index]}
            icon={<CropMark />}
            source={label}
            detail={source}
            removeLabel={removeLabel}
            onRemove={() => removePdfArea(index)}
          />
        )
      })}
      {Array.from({ length: pendingAreas }, (_, index) => (
        <ContextChip
          key={`pdf-pending-${index}`}
          className="ai-assist-pdf-pending-chip"
          icon={<span className="ai-assist-pdf-pending-spinner" />}
          source={t('ai_assist_pdf_area_pending_source', {
            defaultValue: 'PDF area',
          })}
          detail={t('ai_assist_pdf_area_pending', {
            defaultValue: 'capturing…',
          })}
        />
      ))}
    </>
  )
}

/** Stands in for a crop whose picture could not be read. */
function CropMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" strokeDasharray="2.5 2" />
    </svg>
  )
}
