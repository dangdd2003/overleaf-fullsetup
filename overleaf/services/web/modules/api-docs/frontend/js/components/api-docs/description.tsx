import { Fragment } from 'react'
import classNames from 'classnames'

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }

// Blank lines separate paragraphs; a paragraph made only of "- " lines is a list
function parseBlocks(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph): Block => {
      const lines = paragraph.split('\n')
      if (lines.every((line) => /^\s*[-*]\s/.test(line))) {
        return {
          type: 'list',
          items: lines.map((line) => line.replace(/^\s*[-*]\s/, '')),
        }
      }
      return { type: 'paragraph', text: paragraph }
    })
}

/** Renders `inline code` spans; the text is otherwise plain */
function InlineText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/`([^`\n]+)`/)
        .map((part, index) =>
          index % 2 === 1 ? (
            <code key={index}>{part}</code>
          ) : (
            <Fragment key={index}>{part}</Fragment>
          )
        )}
    </>
  )
}

export default function Description({
  text,
  className,
}: {
  text?: string
  className?: string
}) {
  if (!text?.trim()) {
    return null
  }
  return (
    <div className={classNames('api-docs-prose', className)}>
      {parseBlocks(text).map((block, index) =>
        block.type === 'list' ? (
          <ul key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <InlineText text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={index}>
            <InlineText text={block.text} />
          </p>
        )
      )}
    </div>
  )
}
