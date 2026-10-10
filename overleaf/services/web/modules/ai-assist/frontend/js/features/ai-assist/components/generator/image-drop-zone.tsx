import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import { X } from '@phosphor-icons/react'
import {
  ACCEPTED_IMAGE_TYPES,
  formatBytes,
  GeneratorImage,
  ImageError,
} from '../../generator/image'

/** The right half of a generator dialog: drop, paste (handled by the dialog) or browse an image. */
export function ImageDropZone({
  image,
  error,
  reading,
  disabled,
  dropText,
  imageAlt,
  onFile,
  onRemove,
}: {
  image: GeneratorImage | null
  error: ImageError | null
  reading: boolean
  disabled: boolean
  /** "Drop an image of the equation here". */
  dropText: string
  imageAlt: string
  onFile: (file: File) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const errorText =
    error === 'type'
      ? t('ai_assist_generator_image_type', 'Use a PNG, JPEG, WebP or GIF image')
      : error === 'size'
        ? t('ai_assist_generator_image_size', "Images over 20 MB can't be used")
        : error === 'read'
          ? t('ai_assist_generator_image_read', "This image couldn't be read")
          : null

  return (
    <div className="ai-generator-image-column">
      {image ? (
        <div className="ai-generator-image has-image">
          <img src={`data:${image.mediaType};base64,${image.data}`} alt={imageAlt} />
          <div className="ai-generator-image-meta">
            <span className="ai-generator-image-name" title={image.name}>
              {image.name}
            </span>
            <span>{formatBytes(image.size)}</span>
          </div>
          <button
            type="button"
            className="ai-generator-image-remove"
            aria-label={t('ai_assist_generator_remove_image', 'Remove image')}
            onClick={onRemove}
          >
            <X aria-hidden="true" size={14} weight="bold" />
          </button>
        </div>
      ) : (
        <div
          className={classNames('ai-generator-image', {
            'is-over': over,
            'is-disabled': disabled,
          })}
          aria-disabled={disabled}
          title={disabled ? t('ai_assist_generator_images_soon', 'Images are coming soon') : undefined}
          onDragOver={event => {
            if (disabled) return
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={event => {
            event.preventDefault()
            setOver(false)
            if (disabled) return
            const file = event.dataTransfer?.files?.[0]
            if (file) onFile(file)
          }}
        >
          <p>
            {reading ? t('ai_assist_generator_reading_image', 'Reading the image…') : dropText}
          </p>
          <p className="ai-generator-image-alternatives">
            {t('ai_assist_generator_or_paste', 'or paste')}
            {' · '}
            <button
              type="button"
              className="btn-link ai-generator-image-browse"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              {t('ai_assist_generator_browse', 'browse')}
            </button>
          </p>
          <input
            ref={inputRef}
            type="file"
            hidden
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file && !disabled) onFile(file)
            }}
          />
        </div>
      )}
      {errorText && (
        <p className="ai-generator-image-error" role="alert">
          {errorText}
        </p>
      )}
    </div>
  )
}
