import { ProviderError, ProviderSettings } from '../providers/types'
import { documentClassOf, maskComments, matchingBrace } from '../texgpt/latex-text'
import { documentHints } from '../writing-tools/prompt'
import { cacheKey, CacheEntry, SuggestionCache, suggestionCache } from './cache'
import { checkBatch, CheckTarget } from './check-batch'
import type { MaskedEdit } from './edits'
import type { KeyContext, ResolvedModel } from './model-choice'
import type { EnglishVariant } from './preferences'
import type { PromptParagraph, PromptRequest, PromptSentence } from './prompt'
import { contextFingerprint, contextHolds, moveEdits } from './semantic'
import { LOOKUP_CHUNK, SharedEntry, SharedResults, STORE_CHUNK } from './shared'
import type { CheckStatus, UnitSuggestions } from './state'
import type { TabShare } from './tab-share'
import { buildUnits, Unit, wordCount } from './units'

/**
 * When the model is asked, decided by what changed in the text, never by a
 * clock:
 * - the whole file is checked once, what is in view first; results are kept
 *   in this browser (cache.ts), so it is not checked again on a reload;
 * - after that, a sentence is checked again only when what the model reads
 *   changed (semantic.ts): its own words or punctuation, or its neighbours
 *   by enough to change its meaning. Spacing, line breaks, quotes and the
 *   LaTeX behind math, citations and commands do not count;
 * - a sentence someone is editing waits until they are done with it: the
 *   author's cursor leaves it, or they end it with `.` `?` `!` or `:`; a
 *   collaborator moves on to edit elsewhere, or ends it the same way;
 * - ghost-text completion on the same server goes first (holdFor);
 * - a failed request is not retried on a timer, only after the next edit.
 */

/** Edits arrive in bursts: the text is scanned once they stop for this long. */
const HEADING = /\\(?:part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\]\s*)?\{/g
const MAX_SECTION_CHARS = 80

/** The document's headings, in order: where each starts and its title on one line. */
export function headingsOf(doc: string): Array<{ at: number; title: string }> {
  const masked = maskComments(doc)
  const headings: Array<{ at: number; title: string }> = []
  for (const match of masked.matchAll(HEADING)) {
    const open = match.index! + match[0].length - 1
    const close = matchingBrace(masked, open)
    if (close === -1) continue
    const title = doc.slice(open + 1, close).replace(/\s+/g, ' ').trim()
    if (title) headings.push({ at: match.index!, title: title.slice(0, MAX_SECTION_CHARS) })
  }
  return headings
}

const TITLE = /\\title\s*(?:\[[^\]]*\]\s*)?\{/
/** Sentences of context on each side of a target when style is checked too. */
export const STYLE_CONTEXT_SENTENCES = 2

/** The document's `\title{…}` on one line, if it has one. */
export function titleOf(doc: string): string | undefined {
  const masked = maskComments(doc)
  const match = TITLE.exec(masked)
  if (!match) return undefined
  const open = match.index + match[0].length - 1
  const close = matchingBrace(masked, open)
  if (close === -1) return undefined
  const title = doc.slice(open + 1, close).replace(/\\\\/g, ' ').replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, MAX_SECTION_CHARS * 2) : undefined
}

/** The title of the last heading before `pos`; undefined above the first. */
export function sectionAt(headings: Array<{ at: number; title: string }>, pos: number): string | undefined {
  let title: string | undefined
  for (const heading of headings) {
    if (heading.at > pos) break
    title = heading.title
  }
  return title
}

export const DEBOUNCE_MS = 800
export const MAX_BATCH_SENTENCES = 10
export const MAX_BATCH_WORDS = 1200
/** Ollama's OpenAI-compatible endpoint runs with the model's default context. */
export const MAX_BATCH_WORDS_OLLAMA = 600

/** The places a repeated sentence keeps a context for. */
const MAX_CONTEXTS = 4
const CONCURRENCY: Record<'fast' | 'main', number> = { fast: 2, main: 1 }
const SENTENCE_END = /[.?!:]$/

type Resolved = { model: ResolvedModel; variant: EnglishVariant; style: boolean }

/** Where the last edits were made, kept in step with the text by the editor. */
export type EditPositions = {
  /** Just after the author's own last edit. */
  local: number | null
  /** Just after a collaborator's last edit. */
  remote: number | null
}

export type SchedulerDeps = {
  getDoc: () => string
  getViewport: () => { from: number; to: number }
  getCursor: () => number
  /** Default: no edits made. */
  getEditPositions?: () => EditPositions
  /** Turned on, consent given, the document editable. */
  isActive: () => boolean
  /** The author is on the page; while not, nothing new is sent. Default: always. */
  isAttended?: () => boolean
  resolve: () => Resolved | null
  /** Every sentence of the current text the cache has suggestions for. */
  deliver: (units: UnitSuggestions[]) => void
  onStatus: (status: CheckStatus) => void
  check?: typeof checkBatch
  cache?: SuggestionCache
  /** The project's results shared by its collaborators (shared.ts); none: this browser only. */
  shared?: SharedResults | null
  /** This browser's other tabs (tab-share.ts). */
  tabs?: TabShare | null
  /** How long to wait before sending on these settings: 0 now, Infinity until told. Default: 0. */
  holdFor?: (settings: ProviderSettings) => number
}

type Job = { units: Unit[]; retried: boolean }

/** Decides what to send, from what changed, and keeps the cache and the view in step. */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = new Map<AbortController, Set<string>>()
  private retries: Job[] = []
  /** A request failed: nothing more is sent until the author edits or the settings change. */
  private failed: string | null = null
  private stoppedMessage: string | null = null
  private generation = 0
  private destroyed = false
  private scanned: {
    doc: string
    units: Unit[]
    contexts: Map<Unit, string>
    neighbours: Map<Unit, Unit[]>
  } | null = null
  private status: CheckStatus = { kind: 'idle' }
  /** Keys already asked of the shared results, and lookups still on their way. */
  private looked = new Set<string>()
  private lookups = 0
  /** Results to save to the shared results once their request ends. */
  private outbox: Array<{ key: string; entry: SharedEntry }> = []
  /** The sentences of the check under way, and those answered: its progress. */
  private pass: { total: Set<string>; checked: Set<string> } | null = null

  constructor(private readonly deps: SchedulerDeps) {}

  private get cache(): SuggestionCache {
    return this.deps.cache ?? suggestionCache
  }

  /** Looks at the text again after `delay` (a burst of edits or scrolling settling). */
  schedule(delay = DEBOUNCE_MS) {
    if (this.destroyed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.run()
    }, delay)
  }

  /** The text changed; the author's own edit also clears a failure. */
  noteEdit({ remote = false }: { remote?: boolean } = {}) {
    if (!remote) this.failed = null
    this.schedule()
  }

  /** The settings changed: drop what is running, forget a stop, check again. */
  reset() {
    this.generation++
    for (const controller of this.inFlight.keys()) controller.abort()
    this.inFlight.clear()
    this.retries = []
    this.failed = null
    this.stoppedMessage = null
    this.schedule(0)
  }

  destroy() {
    this.destroyed = true
    this.generation++
    this.flushOutbox()
    if (this.timer) clearTimeout(this.timer)
    for (const controller of this.inFlight.keys()) controller.abort()
    this.inFlight.clear()
  }

  private units(): Unit[] {
    const doc = this.deps.getDoc()
    if (this.scanned?.doc !== doc) {
      const units = buildUnits(doc)
      const contexts = new Map<Unit, string>()
      const neighbours = new Map<Unit, Unit[]>()
      units.forEach((unit, i) => {
        const before = units[i - 1]?.paragraph === unit.paragraph ? units[i - 1] : null
        const after = units[i + 1]?.paragraph === unit.paragraph ? units[i + 1] : null
        contexts.set(unit, contextFingerprint(before?.masked.text ?? null, after?.masked.text ?? null))
        neighbours.set(unit, [before, after].filter((u): u is Unit => u !== null))
      })
      this.scanned = { doc, units, contexts, neighbours }
    }
    return this.scanned.units
  }

  private contextOf(unit: Unit): string {
    this.units()
    return this.scanned!.contexts.get(unit) ?? '|'
  }

  private setStatus(status: CheckStatus) {
    const message = (s: CheckStatus) =>
      'message' in s
        ? s.message
        : 'progress' in s && s.progress
          ? `${s.progress.checked}/${s.progress.total}`
          : ''
    if (status.kind === this.status.kind && message(status) === message(this.status)) return
    this.status = status
    this.deps.onStatus(status)
  }

  /** The cached result for a sentence: its edits moved onto its text, or null to check it. */
  private known(context: KeyContext, unit: Unit): { entry: CacheEntry; edits: MaskedEdit[] } | null {
    const key = cacheKey(context, unit.hash)
    const entry = this.cache.get(key)
    if (!entry) return null
    if (!contextHolds(entry.contexts, this.contextOf(unit))) {
      // A neighbour still being edited is not a new context yet: keep what is known
      const neighbours = this.scanned!.neighbours.get(unit) ?? []
      if (!neighbours.some(n => this.beingEdited(n))) return null
    }
    const visible = this.cache.visible(key) ?? []
    const edits = entry.text ? moveEdits(visible, entry.text, unit.masked.text) : visible
    return edits ? { entry, edits } : null
  }

  /** Shows every sentence of the current text the cache knows, for this model. */
  private deliverKnown(context: KeyContext) {
    const known: UnitSuggestions[] = []
    for (const unit of this.units()) {
      const edits = this.known(context, unit)?.edits
      if (edits && edits.length > 0) {
        known.push({ hash: unit.hash, from: unit.from, to: unit.to, masked: unit.masked, edits })
      }
    }
    this.deps.deliver(known)
  }

  private run() {
    if (this.destroyed) return
    const resolved = this.deps.isActive() ? this.deps.resolve() : null
    if (!resolved) {
      this.deps.deliver([])
      this.setStatus({ kind: 'idle' })
      return
    }
    const context: KeyContext = {
      slot: resolved.model.slot,
      model: resolved.model.model,
      variant: resolved.variant,
      style: resolved.style,
    }
    this.deliverKnown(context)
    if (this.stoppedMessage) {
      this.setStatus({ kind: 'stopped', message: this.stoppedMessage })
      return
    }
    // Away from the page: keep what is shown, send nothing; the return looks again
    if (this.deps.isAttended && !this.deps.isAttended()) {
      this.setStatus(this.inFlight.size > 0 ? { kind: 'checking' } : { kind: 'idle' })
      return
    }
    // What collaborators' checks already answered is looked up before asking the model
    if (this.deps.shared) this.lookUp(context)
    // Another feature needs the model first: what is left waits for it
    const hold = this.deps.holdFor?.(resolved.model.settings) ?? 0
    if (hold > 0 && hold !== Infinity) this.schedule(hold)
    if (!this.failed && this.lookups === 0 && hold === 0) {
      while (this.inFlight.size < CONCURRENCY[resolved.model.slot]) {
        const job = this.nextJob(context, resolved.model)
        if (!job) break
        if (!this.send(job, context, resolved) && !job.retried) break
      }
    }
    this.setStatus(this.currentStatus(context))
  }

  /** Asks the shared results, once, for every sentence about to be checked. */
  private lookUp(context: KeyContext) {
    const shared = this.deps.shared!
    const keys = [
      ...new Set(
        this.units()
          .filter(unit => !this.known(context, unit) && !this.beingEdited(unit))
          .map(unit => cacheKey(context, unit.hash))
          .filter(key => !this.looked.has(key))
      ),
    ]
    const generation = this.generation
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const chunk = keys.slice(i, i + LOOKUP_CHUNK)
      chunk.forEach(key => this.looked.add(key))
      this.lookups++
      shared
        .lookup(chunk)
        .then(found => {
          for (const [key, entry] of Object.entries(found)) this.adopt(key, entry)
        })
        // Unreachable: the model is asked instead
        .catch(() => {})
        .finally(() => {
          this.lookups--
          if (generation === this.generation && !this.destroyed) this.schedule(0)
        })
    }
  }

  /** A result checked elsewhere (a collaborator, another tab), kept with the author's dismissals. */
  adopt(key: string, entry: SharedEntry) {
    this.cache.set(key, { ...entry, rejected: this.cache.get(key)?.rejected ?? [] })
  }

  private flushOutbox() {
    const shared = this.deps.shared
    const entries = this.outbox.splice(0)
    if (!shared) return
    for (let i = 0; i < entries.length; i += STORE_CHUNK) {
      shared.store(entries.slice(i, i + STORE_CHUNK)).catch(() => {})
    }
  }

  /** Checking (with progress through a large check), failed, or idle. */
  private currentStatus(context: KeyContext): CheckStatus {
    if (this.inFlight.size > 0) {
      const pending = new Set(
        this.units()
          .filter(unit => !this.known(context, unit) && !this.beingEdited(unit))
          .map(unit => unit.hash)
      )
      if (!this.pass) this.pass = { total: new Set(), checked: new Set() }
      pending.forEach(hash => this.pass!.total.add(hash))
      const { total, checked } = this.pass
      if (total.size <= MAX_BATCH_SENTENCES) return { kind: 'checking' }
      const done = [...total].filter(hash => checked.has(hash) || !pending.has(hash)).length
      return { kind: 'checking', progress: { checked: done, total: total.size } }
    }
    this.pass = null
    if (this.failed) return { kind: 'error', message: this.failed }
    return { kind: 'idle' }
  }

  /**
   * Whether someone is still editing the sentence: the author's last edit and
   * cursor are in it, or a collaborator's last edit is. Ending it with a
   * sentence mark at its end hands it over at once.
   */
  private beingEdited(unit: Unit): boolean {
    const { local, remote } = this.deps.getEditPositions?.() ?? { local: null, remote: null }
    const inside = (pos: number | null) => pos !== null && unit.from <= pos && pos <= unit.to
    const endedAt = (pos: number | null) => pos === unit.to && SENTENCE_END.test(unit.masked.text)
    const cursor = this.deps.getCursor()
    if (inside(local) && inside(cursor) && !endedAt(cursor)) return true
    return inside(remote) && !endedAt(remote)
  }

  private nextJob(context: KeyContext, model: ResolvedModel): Job | null {
    const retry = this.retries.shift()
    if (retry) return retry

    const units = this.units()
    const busy = new Set<string>()
    for (const hashes of this.inFlight.values()) hashes.forEach(hash => busy.add(hash))
    const tabs = this.deps.tabs
    const dirty = units.filter(
      unit =>
        !busy.has(unit.hash) &&
        !this.known(context, unit) &&
        !this.beingEdited(unit) &&
        !tabs?.isBusy(cacheKey(context, unit.hash))
    )
    if (dirty.length === 0) return null

    // What is in view first, then outwards from it
    const viewport = this.deps.getViewport()
    const distance = (unit: Unit) =>
      Math.max(0, viewport.from - unit.to, unit.from - viewport.to)
    dirty.sort((a, b) => distance(a) - distance(b) || a.from - b.from)

    const maxWords =
      model.slot === 'fast' && model.storedType === 'ollama'
        ? MAX_BATCH_WORDS_OLLAMA
        : MAX_BATCH_WORDS
    const picked: Unit[] = []
    const seen = new Set<string>()
    let words = 0
    for (const unit of dirty) {
      if (seen.has(unit.hash)) continue
      const count = wordCount(unit.masked.text)
      if (picked.length > 0 && (picked.length >= MAX_BATCH_SENTENCES || words + count > maxWords)) break
      picked.push(unit)
      seen.add(unit.hash)
      words += count
    }
    return { units: picked, retried: false }
  }

  /**
   * The request for a job, read from the current text: each target with
   * the sentence before and the one after from its paragraph as context,
   * and the heading its paragraph is under; a repeated sentence sent once.
   */
  private buildRequest(job: Job, variant: EnglishVariant, style: boolean) {
    const all = this.units()
    const doc = this.scanned!.doc
    const wanted = new Set(job.units.map(unit => unit.hash))
    const first = new Map<string, Unit>()
    for (const unit of all) {
      if (wanted.has(unit.hash) && !first.has(unit.hash)) first.set(unit.hash, unit)
    }
    const byParagraph = new Map<number, Unit[]>()
    for (const unit of first.values()) {
      const list = byParagraph.get(unit.paragraph) ?? []
      list.push(unit)
      byParagraph.set(unit.paragraph, list)
    }

    const headings = headingsOf(doc)
    const title = titleOf(doc)
    const paragraphs: PromptParagraph[] = []
    const targets: CheckTarget[] = []
    const ids = new Map<string, Unit>()
    for (const paragraph of [...byParagraph.keys()].sort((a, b) => a - b)) {
      const members = all.filter(unit => unit.paragraph === paragraph)
      const chosen = byParagraph.get(paragraph)!
      const include = new Set<number>()
      for (const target of chosen) {
        const at = members.indexOf(target)
        // Style reads more of the paragraph: its voice and terms, not only the next words
        const reach = style ? STYLE_CONTEXT_SENTENCES : 1
        for (let k = at - reach; k <= at + reach; k++) {
          if (k >= 0 && k < members.length) include.add(k)
        }
      }
      const sentences: PromptSentence[] = []
      for (const k of [...include].sort((a, b) => a - b)) {
        const member = members[k]
        if (chosen.includes(member)) {
          const id = `s${ids.size + 1}`
          ids.set(id, member)
          targets.push({ id, masked: member.masked })
          sentences.push({ id, text: member.masked.text, context: false })
        } else {
          sentences.push({ id: '', text: member.masked.text, context: true })
        }
      }
      const section = sectionAt(headings, members[0].from)
      paragraphs.push({ container: members[0].container, ...(section ? { section } : {}), sentences })
    }

    const request: PromptRequest = {
      language: documentHints(doc).language,
      docClass: documentClassOf(doc),
      variant,
      ...(title ? { title } : {}),
      style,
      paragraphs,
    }
    return { request, targets, ids }
  }

  /** Sends a job; false when none of its sentences is left in the text. */
  private send(job: Job, context: KeyContext, resolved: Resolved): boolean {
    const { request, targets, ids } = this.buildRequest(job, resolved.variant, resolved.style)
    if (targets.length === 0) return false
    const controller = new AbortController()
    this.inFlight.set(controller, new Set([...ids.values()].map(unit => unit.hash)))
    const claimed = [...new Set([...ids.values()].map(unit => cacheKey(context, unit.hash)))]
    this.deps.tabs?.claim(claimed)
    const generation = this.generation
    const reported = new Set<string>()
    const unreported = () =>
      [...ids.entries()].filter(([id]) => !reported.has(id)).map(([, unit]) => unit)
    const check = this.deps.check ?? checkBatch

    check({
      request,
      targets,
      settings: resolved.model.settings,
      signal: controller.signal,
      onResult: result => {
        if (generation !== this.generation) return
        const unit = ids.get(result.id)
        if (!unit) return
        reported.add(result.id)
        this.remember(context, unit, result.edits)
        this.pass?.checked.add(unit.hash)
        this.deliverKnown(context)
        if (this.pass) this.setStatus(this.currentStatus(context))
      },
    })
      .then(({ malformed }) => {
        if (generation !== this.generation) return
        if (malformed) this.retryOrGiveUp({ units: unreported(), retried: job.retried }, context)
      })
      .catch(error => {
        if (generation !== this.generation) return
        this.handleError(error, { units: unreported(), retried: job.retried }, context)
      })
      .finally(() => {
        this.inFlight.delete(controller)
        this.deps.tabs?.release(claimed)
        this.flushOutbox()
        if (generation === this.generation && !this.destroyed) this.schedule(0)
      })
    return true
  }

  /**
   * A sentence's result, with the text it was checked in and the contexts of
   * every place it stands now (a repeated sentence is sent once).
   */
  private remember(
    context: KeyContext,
    unit: Unit,
    edits: MaskedEdit[],
    { share = true }: { share?: boolean } = {}
  ) {
    const key = cacheKey(context, unit.hash)
    const contexts = [
      ...new Set(
        this.units()
          .filter(other => other.hash === unit.hash)
          .map(other => this.contextOf(other))
      ),
    ].slice(0, MAX_CONTEXTS)
    this.cache.set(key, {
      edits,
      rejected: this.cache.get(key)?.rejected ?? [],
      text: unit.masked.text,
      contexts: contexts.length > 0 ? contexts : [this.contextOf(unit)],
    })
    if (!share) return
    const { rejected: _rejected, ...entry } = this.cache.get(key)!
    this.outbox.push({ key, entry })
    this.deps.tabs?.publish(key, entry)
  }

  /** Once more in halves; after that the sentences count as clean until they change. */
  private retryOrGiveUp(job: Job, context: KeyContext) {
    if (job.units.length === 0) return
    if (job.retried) {
      // Unanswered, not found clean: kept here, never shared
      for (const unit of job.units) this.remember(context, unit, [], { share: false })
      return
    }
    const half = Math.ceil(job.units.length / 2)
    this.retries.push({ units: job.units.slice(0, half), retried: true })
    if (job.units.length > half) {
      this.retries.push({ units: job.units.slice(half), retried: true })
    }
  }

  private handleError(error: unknown, rest: Job, context: KeyContext) {
    const code = error instanceof ProviderError ? error.code : undefined
    if (code === 'aborted') return
    if (code === 'outputTruncated') {
      this.retryOrGiveUp(rest, context)
      return
    }
    const message =
      (error instanceof Error && error.message) || 'The language check failed.'
    if (code === 'providerAuth' || code === 'modelsUnsupported') {
      this.stoppedMessage = message
      this.setStatus({ kind: 'stopped', message })
      return
    }
    // No retry on a timer: the next edit tries again
    this.failed = `${message} Checking again after your next edit.`
    this.setStatus({ kind: 'error', message: this.failed })
  }
}
