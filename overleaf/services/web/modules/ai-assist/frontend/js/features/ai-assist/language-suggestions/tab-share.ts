import getMeta from '@/utils/meta'
import type { SharedEntry } from './shared'

type Message =
  | { type: 'hello'; tab: string }
  | { type: 'busy'; tab: string; keys: string[] }
  | { type: 'free'; tab: string; keys: string[] }
  | { type: 'bye'; tab: string }
  | { type: 'result'; tab: string; key: string; entry: SharedEntry }

export const TAB_CHANNEL = 'ai-assist:language-checks'

function defaultChannelName(): string {
  try {
    const projectId = typeof window !== 'undefined' ? getMeta('ol-project_id') : null
    return projectId ? `${TAB_CHANNEL}:${projectId}` : TAB_CHANNEL
  } catch {
    return TAB_CHANNEL
  }
}

/**
 * Keeps this browser's tabs from checking the same sentences twice: each tab
 * says which sentences it is checking, and hands its results to the others
 * as they arrive (each tab keeps its own copy of the cache in memory).
 * Without BroadcastChannel it does nothing.
 */
export class TabShare {
  private readonly tab = Math.random().toString(36).slice(2)
  private channel: BroadcastChannel | null = null
  /** Sentences another tab is checking, and which tab. */
  private elsewhere = new Map<string, string>()
  private mine = new Set<string>()
  private readonly onPageHide = () => this.post({ type: 'bye', tab: this.tab })

  constructor(
    /** A result from another tab; and, with no key, sentences another tab let go of. */
    private readonly listener: (key?: string, entry?: SharedEntry) => void,
    /** The browser's own; none (tests, old browsers): this tab only. */
    Channel: typeof BroadcastChannel | null | undefined = typeof window !== 'undefined'
      ? window.BroadcastChannel
      : undefined,
    channelName: string = defaultChannelName()
  ) {
    if (typeof Channel !== 'function') return
    this.channel = new Channel(channelName)
    this.channel.onmessage = event => this.receive(event.data as Message)
    window.addEventListener('pagehide', this.onPageHide)
    this.post({ type: 'hello', tab: this.tab })
  }

  private post(message: Message) {
    try {
      this.channel?.postMessage(message)
    } catch {}
  }

  private receive(message: Message) {
    if (!message || message.tab === this.tab) return
    switch (message.type) {
      case 'hello':
        // A new tab: tell it what this one is checking
        if (this.mine.size > 0) this.post({ type: 'busy', tab: this.tab, keys: [...this.mine] })
        break
      case 'busy':
        for (const key of message.keys) this.elsewhere.set(key, message.tab)
        break
      case 'free':
        for (const key of message.keys) {
          if (this.elsewhere.get(key) === message.tab) this.elsewhere.delete(key)
        }
        this.listener()
        break
      case 'bye':
        for (const [key, tab] of this.elsewhere) {
          if (tab === message.tab) this.elsewhere.delete(key)
        }
        this.listener()
        break
      case 'result':
        this.elsewhere.delete(message.key)
        this.listener(message.key, message.entry)
        break
    }
  }

  /** Another tab is checking it. */
  isBusy(key: string): boolean {
    return this.elsewhere.has(key)
  }

  claim(keys: string[]) {
    if (!this.channel || keys.length === 0) return
    keys.forEach(key => this.mine.add(key))
    this.post({ type: 'busy', tab: this.tab, keys })
  }

  release(keys: string[]) {
    if (!this.channel || keys.length === 0) return
    keys.forEach(key => this.mine.delete(key))
    this.post({ type: 'free', tab: this.tab, keys })
  }

  publish(key: string, entry: SharedEntry) {
    this.post({ type: 'result', tab: this.tab, key, entry })
  }

  close() {
    if (!this.channel) return
    this.release([...this.mine])
    window.removeEventListener('pagehide', this.onPageHide)
    this.channel.close()
    this.channel = null
  }
}
