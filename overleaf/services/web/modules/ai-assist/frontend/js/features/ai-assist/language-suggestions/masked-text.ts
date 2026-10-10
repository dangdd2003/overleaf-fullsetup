/** What a masked character stands for in the source. */
export type CharKind =
  /** Copied from the source as it is. */
  | 'text'
  /** A run of spaces or tabs. */
  | 'space'
  /** A run of whitespace holding one line break, kept on edits. */
  | 'break'
  /** Never edited: `~`, `\,`, `\\`, an accented letter, `\ldots`. */
  | 'hard'
  /** `\%` `\&` `\#` `\_` `\$`, shown as the plain character. */
  | 'escaped'
  /** Part of a `[[M1]]`-style token. */
  | 'placeholder'

/** Math, citation, cross-reference, any other command. */
export type PlaceholderKind = 'M' | 'C' | 'R' | 'X'

export type Placeholder = {
  kind: PlaceholderKind
  token: string
  /** The source range of the LaTeX it stands for. */
  from: number
  to: number
  source: string
}

/** Prose with the LaTeX taken out, and where every character came from. */
export type MaskedText = {
  text: string
  /** Per character: the source range it stands for. */
  starts: number[]
  ends: number[]
  kinds: CharKind[]
  /** Per character: index into `placeholders`, or -1. */
  owners: number[]
  placeholders: Placeholder[]
}

export class MaskedBuilder {
  private text = ''
  private starts: number[] = []
  private ends: number[] = []
  private kinds: CharKind[] = []
  private owners: number[] = []
  private placeholders: Placeholder[] = []
  private counts: Record<PlaceholderKind, number> = { M: 0, C: 0, R: 0, X: 0 }

  get length(): number {
    return this.text.length
  }

  /** Appends `chars`, every one of them standing for source [from, to). */
  push(chars: string, from: number, to: number, kind: CharKind, owner = -1) {
    for (let i = 0; i < chars.length; i++) {
      this.text += chars[i]
      this.starts.push(from)
      this.ends.push(to)
      this.kinds.push(kind)
      this.owners.push(owner)
    }
  }

  /**
   * Appends whitespace as one space. A soft space is dropped at the start,
   * and merged into a soft space just before it when the two touch in the
   * source (never across hidden LaTeX). A hard space is always kept.
   */
  pushSpace(from: number, to: number, kind: 'space' | 'break' | 'hard') {
    if (kind !== 'hard') {
      if (this.text.length === 0) return
      const last = this.text.length - 1
      if (this.kinds[last] === 'space' || this.kinds[last] === 'break') {
        if (this.ends[last] === from) {
          this.ends[last] = to
          if (kind === 'break') this.kinds[last] = 'break'
        }
        return
      }
    }
    this.push(' ', from, to, kind)
  }

  /** Appends the next `[[K<n>]]` token, numbered per kind from 1. */
  pushPlaceholder(
    kind: PlaceholderKind,
    from: number,
    to: number,
    source: string
  ) {
    this.counts[kind]++
    const token = `[[${kind}${this.counts[kind]}]]`
    this.placeholders.push({ kind, token, from, to, source })
    this.push(token, from, to, 'placeholder', this.placeholders.length - 1)
  }

  /** The text so far, trailing soft spaces dropped. */
  build(): MaskedText {
    let end = this.text.length
    while (
      end > 0 &&
      (this.kinds[end - 1] === 'space' || this.kinds[end - 1] === 'break')
    ) {
      end--
    }
    return {
      text: this.text.slice(0, end),
      starts: this.starts.slice(0, end),
      ends: this.ends.slice(0, end),
      kinds: this.kinds.slice(0, end),
      owners: this.owners.slice(0, end),
      placeholders: [...this.placeholders],
    }
  }
}

/** `masked[from, to)` as a masked text of its own, placeholders numbered from 1. */
export function sliceMasked(
  masked: MaskedText,
  from: number,
  to: number
): MaskedText {
  const builder = new MaskedBuilder()
  let i = from
  while (i < to) {
    const owner = masked.owners[i]
    if (owner >= 0) {
      const placeholder = masked.placeholders[owner]
      builder.pushPlaceholder(
        placeholder.kind,
        placeholder.from,
        placeholder.to,
        placeholder.source
      )
      while (i < to && masked.owners[i] === owner) i++
    } else {
      builder.push(masked.text[i], masked.starts[i], masked.ends[i], masked.kinds[i])
      i++
    }
  }
  return builder.build()
}

/** Plain text as a masked text: every character stands for itself. */
export function plainMasked(text: string): MaskedText {
  const builder = new MaskedBuilder()
  for (let i = 0; i < text.length; i++) builder.push(text[i], i, i + 1, 'text')
  return builder.build()
}
