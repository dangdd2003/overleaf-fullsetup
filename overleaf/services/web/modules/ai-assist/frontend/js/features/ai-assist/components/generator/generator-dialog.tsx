import { ClipboardEvent, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { Info } from '@phosphor-icons/react'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import sparkle from '@/shared/svgs/sparkle-2-stars.svg'
import { GeneratorImage, ImageError, imageFromClipboard } from '../../generator/image'
import { ClipboardText } from '../../generator/clipboard'
import { ImageDropZone } from './image-drop-zone'

/** What one generator's dialog says; the shell is the same for all. */
export type GeneratorDialogText = {
  /** "Generate equation". */
  title: string
  /** "Enter your prompt or paste an image with the equation". */
  lead: string
  placeholder: string
  /** The prompt box's accessible name. */
  promptLabel: string
  dropText: string
  imageAlt: string
}

export type GeneratorDialogProps = {
  text: GeneratorDialogText
  /** The generator's own class on the modal, e.g. `ai-equation-dialog`. */
  className?: string
  prompt: string
  onPrompt: (value: string) => void
  image: GeneratorImage | null
  imageError: ImageError | null
  /** An image is being read and resized. */
  readingImage: boolean
  imagesEnabled: boolean
  onImageFile: (file: File) => void
  onRemoveImage: () => void
  /** Why Generate cannot run here. */
  error: string | null
  /** A line under the inputs, e.g. "Uses the selected text (3 lines)". */
  note?: string | null
  /** Generate works without words or an image (there is a selection to work on). */
  canGenerateEmpty?: boolean
  /** Text to paste instead of the clipboard's image (spreadsheet cells); null takes the image. */
  pasteText?: (clipboard: ClipboardText) => string | null
  onGenerate: () => void
  onCancel: () => void
}

/** A generator's dialog: the prompt on the left, the image on the right. */
export function GeneratorDialog(props: GeneratorDialogProps) {
  const { t } = useTranslation()
  const { text } = props
  const canGenerate =
    (props.prompt.trim() !== '' || props.image !== null || Boolean(props.canGenerateEmpty)) &&
    !props.readingImage

  const generate = () => {
    if (canGenerate) props.onGenerate()
  }

  // Paste anywhere in the dialog, the prompt box included
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const cells = props.pasteText?.(event.clipboardData) ?? null
    if (cells !== null) {
      // Copied cells are text, even when the clipboard also holds their
      // picture. The prompt box pastes text itself; anywhere else, append.
      if (event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      const prompt = props.prompt.replace(/\s+$/, '')
      props.onPrompt(prompt ? `${prompt}\n${cells}` : cells)
      return
    }
    const file = imageFromClipboard(event.clipboardData)
    if (!file || !props.imagesEnabled) return
    event.preventDefault()
    props.onImageFile(file)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      generate()
    }
  }

  return (
    <OLModal
      show
      onHide={props.onCancel}
      animation={true}
      backdrop={false}
      className={classNames('ai-generator-dialog', props.className)}
      data-testid="ai-generator-dialog"
      aria-labelledby="ai-generator-dialog-title"
    >
      <OLModalHeader closeButton>
        <OLModalTitle id="ai-generator-dialog-title" as="h2">
          {text.title}
          <img
            className="ai-generator-dialog-sparkle"
            src={sparkle}
            alt=""
            aria-hidden="true"
          />
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody onPaste={onPaste} onKeyDown={onKeyDown}>
        <label
          className="ai-generator-dialog-lead"
          htmlFor="ai-generator-prompt"
        >
          {text.lead}
        </label>
        <div className="ai-generator-dialog-inputs">
          <textarea
            id="ai-generator-prompt"
            className="form-control ai-generator-prompt"
            rows={3}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={props.prompt}
            placeholder={text.placeholder}
            aria-label={text.promptLabel}
            onChange={event => props.onPrompt(event.target.value)}
          />
          <ImageDropZone
            image={props.image}
            error={props.imageError}
            reading={props.readingImage}
            disabled={!props.imagesEnabled}
            dropText={text.dropText}
            imageAlt={text.imageAlt}
            onFile={props.onImageFile}
            onRemove={props.onRemoveImage}
          />
        </div>
        {props.note && (
          <p className="ai-generator-dialog-note">
            <Info aria-hidden="true" size={16} />
            {props.note}
          </p>
        )}
        {props.error && (
          <div className="alert alert-danger py-2 px-3 my-3" role="alert">
            {props.error}
          </div>
        )}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={props.onCancel}>
          {t('cancel', 'Cancel')}
        </OLButton>
        <OLButton
          variant="primary"
          leadingIcon="autorenew"
          disabled={!canGenerate}
          onClick={generate}
        >
          {t('ai_assist_generator_generate', 'Generate')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
