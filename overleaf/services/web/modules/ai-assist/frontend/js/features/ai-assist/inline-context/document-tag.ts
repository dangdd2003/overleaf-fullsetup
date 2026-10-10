import { escapeAttribute } from '../agent/context/escape'

/** A project rarely loads more; the rest adds tokens, not information. */
export const MAX_PACKAGES_LISTED = 60

/** What every inline AI feature tells the model about the document. */
export type DocumentFacts = {
  docClass?: string | null
  language?: string
  packages?: string[]
  macros?: string[]
}

export type TagAttribute = [name: string, value: string | null | undefined]

/**
 * The `<document …/>` tag that opens every inline request: the shared facts
 * in one order, then the feature's own attributes, all escaped. Empty
 * values are left out; null when nothing is left.
 */
export function documentTag(
  facts: DocumentFacts,
  extra: TagAttribute[] = []
): string | null {
  const attributes: TagAttribute[] = [
    ['class', facts.docClass],
    ['language', facts.language],
    ['packages', facts.packages?.slice(0, MAX_PACKAGES_LISTED).join(' ')],
    ['macros', facts.macros?.join(' ')],
    ...extra,
  ]
  const written = attributes
    .filter((attribute): attribute is [string, string] => Boolean(attribute[1]))
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
  return written.length > 0 ? `<document ${written.join(' ')} />` : null
}
