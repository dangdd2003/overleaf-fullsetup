import { useEffect, useRef, useState } from 'react'
import { AgentMessage, ProviderSettings } from '../providers/types'
import {
  hasConsented,
  readReasoningEffort,
  readSettings,
  recordConsent,
} from '../provider-store'
import { writingToolsSettings } from '../writing-tools/model-settings'
import { GeneratorImage, ImageError, ImageReadError, normalizeImage } from './image'
import {
  GeneratorPhase,
  GeneratorProgress,
  isNonResult,
  NonResult,
  Versioned,
} from './types'

export type GeneratorDraft = { prompt: string; image: GeneratorImage | null }

export type GeneratorRequest =
  | { kind: 'initial' }
  | { kind: 'followUp'; text: string }
  | { kind: 'retry' }

/** What one Generate fixed. `Extra` is the generator's own: where, positions. */
export type GeneratorRun<Facts, Extra> = {
  title: string
  prompt: string
  image: GeneratorImage | null
  extra: Extra
  /** Read once, by `prepare`, on the first request. */
  facts: Facts | null
  messages: AgentMessage[] | null
}

export type GeneratorRunOptions<Facts, Extra, Result extends { raw: string }, Reply> = {
  /** The open session's id; null while closed. A new id starts from a clean slate. */
  sessionId: number | null
  /** The prompt a new opening starts with; null keeps the draft (Edit prompt). */
  initialPrompt: () => string | null
  /** Reads and resizes a file; replaced in tests (jsdom has no canvas). */
  normalize?: (file: File) => Promise<GeneratorImage>
  /** The facts and the first message: read once per Generate. */
  prepare: (
    run: GeneratorRun<Facts, Extra>
  ) => Promise<{ facts: Facts; messages: AgentMessage[] }>
  generate: (args: {
    messages: AgentMessage[]
    facts: Facts
    settings: ProviderSettings
    signal: AbortSignal
    onProgress: (progress: GeneratorProgress<Reply>) => void
  }) => Promise<Result | NonResult>
  followUpMessage: (text: string) => string
  retryMessage: (versions: Array<Versioned<Result>>) => string
  /** A new version arrived: reset per-version choices. */
  onVersion?: () => void
  /** A phase for errors the generator explains itself; null for the generic one. */
  errorPhase?: (error: any) => GeneratorPhase<Reply> | null
  failedMessage: string
  /** Closes the session (Discard). */
  close: () => void
  /** Reopens the dialog with the draft kept (Edit prompt). */
  reopen: () => void
}

/**
 * A generator's requests, shared by the equation and table hosts: the
 * draft and its image, the versions, the phase the card shows, consent and
 * the provider check, aborting, Retry, Ask for changes and Edit prompt.
 * The session field owns positions; this hook owns everything else.
 */
export function useGeneratorRun<Facts, Extra, Result extends { raw: string }, Reply>(
  options: GeneratorRunOptions<Facts, Extra, Result, Reply>
) {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [draft, setDraft] = useState<GeneratorDraft>({ prompt: '', image: null })
  const [imageError, setImageError] = useState<ImageError | null>(null)
  const [readingImage, setReadingImage] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [phase, setPhase] = useState<GeneratorPhase<Reply>>({
    name: 'streaming',
    reply: null,
    repairing: false,
  })
  const [versions, setVersions] = useState<Array<Versioned<Result>>>([])
  const [index, setIndex] = useState(0)
  const [followUp, setFollowUp] = useState('')
  const [pending, setPending] = useState<GeneratorRequest | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const startTimeRef = useRef<number>(Date.now())
  const runRef = useRef<GeneratorRun<Facts, Extra> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const { sessionId } = options
  // Any new opening, or closing by any route, stops the running request.
  // A new opening also starts from a clean slate; the draft survives Edit prompt.
  useEffect(() => {
    abortRef.current?.abort()
    if (sessionId === null) return
    runRef.current = null
    setVersions([])
    setIndex(0)
    setFollowUp('')
    setDurationMs(null)
    setDialogError(null)
    setImageError(null)
    setPending(null)
    const prompt = optionsRef.current.initialPrompt()
    if (prompt !== null) setDraft({ prompt, image: null })
  }, [sessionId])

  useEffect(() => () => abortRef.current?.abort(), [])

  const current: Versioned<Result> | undefined = versions[index]

  const start = async (request: GeneratorRequest) => {
    const run = runRef.current
    if (!run) return
    const { prepare, generate, followUpMessage, retryMessage, onVersion, errorPhase, failedMessage } =
      optionsRef.current
    const base = readSettings()
    if (!base?.type || !base.model) {
      setPhase({ name: 'noProvider' })
      return
    }
    if (!hasConsented()) {
      setPending(request)
      setPhase({ name: 'consent' })
      return
    }
    const previous = request.kind === 'initial' ? undefined : versions[index]
    if (request.kind !== 'initial' && !previous) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    startTimeRef.current = Date.now()
    setPhase({ name: 'streaming', reply: null, repairing: false })

    try {
      let facts = run.facts
      let first = run.messages
      if (!facts || !first) {
        const prepared = await prepare(run)
        if (controller.signal.aborted) return
        facts = run.facts = prepared.facts
        first = run.messages = prepared.messages
      }
      const messages: AgentMessage[] = previous
        ? [
            ...previous.messages,
            { role: 'assistant', content: previous.raw },
            {
              role: 'user',
              content:
                request.kind === 'followUp'
                  ? followUpMessage(request.text)
                  : retryMessage(versions),
            },
          ]
        : first
      const outcome = await generate({
        messages,
        facts,
        settings: writingToolsSettings(base, readReasoningEffort(base.type)),
        signal: controller.signal,
        onProgress: progress => {
          if (controller.signal.aborted) return
          if (progress.stage === 'repairing') {
            setPhase(shown =>
              shown.name === 'streaming' ? { ...shown, repairing: true } : shown
            )
          } else {
            setPhase({ name: 'streaming', reply: progress.reply, repairing: false })
          }
        },
      })
      if (controller.signal.aborted) return

      if (isNonResult(outcome)) {
        if (outcome.kind === 'cannot') setPhase({ name: 'cannot', reason: outcome.reason })
        else if (outcome.kind === 'imageUnsupported') setPhase({ name: 'imageUnsupported' })
        else setPhase({ name: 'empty' })
        return
      }
      const kept = previous ? versions : []
      setVersions([...kept, { ...outcome, messages }])
      setIndex(kept.length)
      setDurationMs(Date.now() - startTimeRef.current)
      onVersion?.()
      setPhase({ name: 'ready' })
    } catch (error: any) {
      if (controller.signal.aborted) return
      if (error?.code === 'imageUnsupported') {
        setPhase({ name: 'imageUnsupported' })
        return
      }
      const explained = errorPhase?.(error)
      if (explained) {
        setPhase(explained)
        return
      }
      setPhase({ name: 'error', message: error?.message || failedMessage, hint: error?.hint })
    }
  }

  /** Fixes what Generate had and sends the first request. Dispatch the review first. */
  const begin = (title: string, extra: Extra) => {
    runRef.current = {
      title,
      prompt: draft.prompt.trim(),
      image: draft.image,
      extra,
      facts: null,
      messages: null,
    }
    setVersions([])
    setIndex(0)
    setFollowUp('')
    setDialogError(null)
    start({ kind: 'initial' })
  }

  const discard = () => {
    abortRef.current?.abort()
    optionsRef.current.close()
  }

  const editPrompt = () => {
    abortRef.current?.abort()
    optionsRef.current.reopen()
  }

  const stop = () => {
    abortRef.current?.abort()
    if (versions.length > 0) setPhase({ name: 'ready' })
    else editPrompt()
  }

  /** Retry: a version unlike the earlier ones (or the first one again after a failure). */
  const regenerate = () => {
    start(current ? { kind: 'retry' } : { kind: 'initial' })
  }

  const sendFollowUp = () => {
    const text = followUp.trim()
    if (!text || phase.name === 'streaming' || !current) return
    setFollowUp('')
    start({ kind: 'followUp', text })
  }

  const allow = () => {
    recordConsent()
    const request = pending
    setPending(null)
    if (request) start(request)
  }

  const selectVersion = (next: number) => {
    setIndex(next)
    setPhase({ name: 'ready' })
  }

  const onImageFile = async (file: File) => {
    setImageError(null)
    setReadingImage(true)
    try {
      const image = await (optionsRef.current.normalize ?? normalizeImage)(file)
      setDraft(shown => ({ ...shown, image }))
    } catch (error) {
      setImageError(error instanceof ImageReadError ? error.code : 'read')
    } finally {
      setReadingImage(false)
    }
  }

  const removeImage = () => {
    setImageError(null)
    setDraft(shown => ({ ...shown, image: null }))
  }

  const setPrompt = (prompt: string) => setDraft(shown => ({ ...shown, prompt }))

  return {
    draft,
    setPrompt,
    onImageFile,
    removeImage,
    imageError,
    readingImage,
    dialogError,
    setDialogError,
    phase,
    durationMs,
    versions,
    index,
    current,
    selectVersion,
    followUp,
    setFollowUp,
    sendFollowUp,
    run: runRef.current,
    begin,
    regenerate,
    stop,
    discard,
    editPrompt,
    allow,
  }
}
