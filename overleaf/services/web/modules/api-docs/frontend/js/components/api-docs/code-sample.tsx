import { KeyboardEvent, useId, useState } from 'react'
import classNames from 'classnames'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import { SAMPLE_LANGUAGES, SampleLanguage, Samples } from './samples'

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const id = useId()
  return (
    <div className="api-docs-code">
      <div className="api-docs-code-toolbar">
        <span className="api-docs-code-label">{label}</span>
        <CopyToClipboard
          content={code}
          tooltipId={`${id}-copy`}
          kind="icon"
        />
      </div>
      {/* Scrollable code must be keyboard reachable */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className="api-docs-code-body" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function CodeSamples({
  samples,
  title,
}: {
  samples: Samples
  title?: string
}) {
  const [active, setActive] = useState<SampleLanguage>('curl')
  const id = useId()
  const tabId = (language: SampleLanguage) => `${id}-tab-${language}`
  const panelId = `${id}-panel`

  // Roving tabindex: arrow keys and Home/End move between the tabs
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const count = SAMPLE_LANGUAGES.length
    const index = SAMPLE_LANGUAGES.findIndex(
      (language) => language.id === active
    )
    let next: number | null = null
    if (event.key === 'ArrowRight') {
      next = (index + 1) % count
    } else if (event.key === 'ArrowLeft') {
      next = (index - 1 + count) % count
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = count - 1
    }
    if (next !== null) {
      event.preventDefault()
      const language = SAMPLE_LANGUAGES[next].id
      setActive(language)
      document.getElementById(tabId(language))?.focus()
    }
  }

  return (
    <div className="api-docs-code api-docs-samples">
      <div className="api-docs-code-toolbar">
        {title && <span className="api-docs-code-label">{title}</span>}
        <div
          role="tablist"
          aria-label="Code sample language"
          className="api-docs-tablist"
        >
          {SAMPLE_LANGUAGES.map((language) => {
            const selected = language.id === active
            return (
              <button
                key={language.id}
                type="button"
                role="tab"
                id={tabId(language.id)}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={classNames('api-docs-tab', {
                  'is-active': selected,
                })}
                onClick={() => setActive(language.id)}
                onKeyDown={onKeyDown}
              >
                {language.label}
              </button>
            )
          })}
        </div>
        <CopyToClipboard
          content={samples[active]}
          tooltipId={`${id}-copy`}
          kind="icon"
        />
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users scroll the sample */}
      <pre
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className="api-docs-code-body"
      >
        <code>{samples[active]}</code>
      </pre>
    </div>
  )
}
