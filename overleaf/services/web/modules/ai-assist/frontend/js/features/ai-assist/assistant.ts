import { ServerProviderClient } from './providers/server-client'
import {
  ProviderError,
  ProviderModel,
  ProviderSettings,
} from './providers/types'
import { readSettings } from './provider-store'

/**
 * The assistant as seen from the page. Provider requests are relayed by the
 * Overleaf server, which can reach providers on the internal network that a
 * browser on a public domain cannot.
 */
export class AiAssistant {
  readonly settings: ProviderSettings
  readonly client: ServerProviderClient

  constructor(settings: ProviderSettings) {
    this.settings = settings
    this.client = new ServerProviderClient(settings)
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
  test(): Promise<{ latencyMs: number }> {
    return this.client.test()
  }
}

export { ProviderError }
