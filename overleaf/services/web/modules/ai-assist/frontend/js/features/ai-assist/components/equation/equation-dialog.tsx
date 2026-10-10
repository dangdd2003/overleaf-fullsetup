import { useTranslation } from 'react-i18next'
import { GeneratorDialog, GeneratorDialogProps } from '../generator/generator-dialog'

export type EquationDialogProps = Omit<
  GeneratorDialogProps,
  'text' | 'className' | 'note' | 'canGenerateEmpty' | 'pasteText'
>

/** "Generate equation": the prompt on the left, the image on the right. */
export function EquationDialog(props: EquationDialogProps) {
  const { t } = useTranslation()
  return (
    <GeneratorDialog
      {...props}
      className="ai-equation-dialog"
      text={{
        title: t('ai_assist_equation_title', 'Generate equation'),
        lead: t(
          'ai_assist_equation_lead',
          'Enter your prompt or paste an image with the equation:'
        ),
        placeholder: t(
          'ai_assist_equation_placeholder',
          'Example: provide the Friedmann Equations'
        ),
        promptLabel: t('ai_assist_equation_prompt', 'Describe the equation'),
        dropText: t('ai_assist_equation_drop', 'Drop an image of the equation here'),
        imageAlt: t('ai_assist_equation_image_alt', 'The equation image'),
      }}
    />
  )
}
