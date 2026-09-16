import { OpenAiClient } from './providers/openai'
import { AnthropicClient } from './providers/anthropic'
import { OllamaClient } from './providers/ollama'
import { GoogleClient } from './providers/google'
import {
  ProviderClient,
  ProviderError,
  ProviderModel,
  ProviderSettings,
} from './providers/types'
import { readSettings } from './provider-store'

function clientFor(settings: ProviderSettings): ProviderClient {
  switch (settings.type) {
    case 'anthropic':
      return new AnthropicClient(settings)
    case 'ollama':
      return new OllamaClient(settings)
    case 'google':
      return new GoogleClient(settings)
    case 'openai':
    default:
      return new OpenAiClient(settings)
  }
}

/**
 * The assistant, as a browser-side object.
 *
 * This is the same shape Overleaf's own AI takes: a client that lives in the
 * page and calls the AI service directly. Overleaf's server has no part in it —
 * there is no route to proxy inference, and nothing here is sent to it.
 */
export class AiAssistant {
  readonly settings: ProviderSettings
  readonly client: ProviderClient

  constructor(settings: ProviderSettings) {
    this.settings = settings
    this.client = clientFor(settings)
  }

  /** Builds an assistant from the provider saved in this browser, if any. */
  static fromStoredSettings(): AiAssistant | null {
    const settings = readSettings()
    if (!settings?.type || !settings.model) return null
    return new AiAssistant(settings)
  }

  listModels(options?: { signal?: AbortSignal }): Promise<ProviderModel[]> {
    return this.client.listModels(options)
  }

  /**
   * Sends one token to prove the key, endpoint and model all work together.
   */
  async test(): Promise<{ latencyMs: number }> {
    const startedAt = Date.now()
    for await (const chunk of this.client.streamChat({
      system: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ok' }],
      maxTokens: 1,
    })) {
      if (chunk.type === 'done') break
    }
    return { latencyMs: Date.now() - startedAt }
  }
}

export { ProviderError }
