import { useTranslation } from 'react-i18next'
import { GeneratorDialog, GeneratorDialogProps } from '../generator/generator-dialog'
import { spreadsheetText } from '../../generator/clipboard'

export type TableDialogProps = Omit<
  GeneratorDialogProps,
  'text' | 'className' | 'note' | 'canGenerateEmpty' | 'pasteText'
> & {
  /** Lines of the selection the table replaces; 0 without one. */
  selectionLines: number
}

/** "Generate table": the prompt on the left, the image on the right. Pasted cells are text. */
export function TableDialog({ selectionLines, ...props }: TableDialogProps) {
  const { t } = useTranslation()
  const note =
    selectionLines === 0
      ? null
      : selectionLines === 1
        ? t('ai_assist_table_uses_selection_one', 'Uses the selected text (1 line)')
        : t('ai_assist_table_uses_selection', 'Uses the selected text (__count__ lines)', {
            count: selectionLines,
          })
  return (
    <GeneratorDialog
      {...props}
      className="ai-table-dialog"
      text={{
        title: t('ai_assist_table_title', 'Generate table'),
        lead: t(
          'ai_assist_table_lead',
          'Enter your prompt or paste an image with the table:'
        ),
        placeholder: t(
          'ai_assist_table_placeholder',
          'Example: create a table with 6 rows and 6 columns, centered, with a horizontal line after the heading'
        ),
        promptLabel: t('ai_assist_table_prompt', 'Describe the table'),
        dropText: t('ai_assist_table_drop', 'Drop an image of the table here'),
        imageAlt: t('ai_assist_table_image_alt', 'The table image'),
      }}
      note={note}
      canGenerateEmpty={selectionLines > 0}
      pasteText={spreadsheetText}
    />
  )
}
