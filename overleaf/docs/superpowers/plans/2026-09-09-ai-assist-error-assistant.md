# AI Assist (Foundation + Error Assistant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a self-hostable AI assistant to Overleaf CE that explains a LaTeX compile error and proposes a fix, backed by a user-configurable LLM provider.

**Architecture:** One new web module, `services/web/modules/ai-assist/`, gated entirely behind `AI_ASSIST_ENABLED`. Two provider adapters (OpenAI wire format and Anthropic wire format) sit behind a narrow `streamChat` interface and cover five user-facing provider types. Users configure providers in Account Settings; an optional environment default backs users who have not. The error assistant streams over Server-Sent Events into the existing compile-log pane via module slots.

**Tech Stack:** Node 22 ESM, Express, Mongoose, React 18 + TypeScript, CodeMirror 6, vitest (backend unit), mocha (frontend unit), `@overleaf/access-token-encryptor`, `@overleaf/settings`, `@overleaf/logger`.

**Spec:** `overleaf/docs/superpowers/specs/2026-09-09-ai-assist-error-assistant-design.md`

## Global Constraints

- **Default disabled.** With `AI_ASSIST_ENABLED` unset, the instance must be indistinguishable from upstream Overleaf CE: no routes, no Mongo indexes, no rendered UI. Every runtime behaviour goes behind a single `isEnabled()` check in `index.mjs`.
- **Module self-containment.** The core `User` model is not modified. All persistent state lives in module-owned collections.
- **Router registration is synchronous.** `Modules.mjs` awaits `router.apply()` but not `router.applyNonCsrfRouter()`. Neither may contain `await` or dynamic `import` — route registration only.
- **Hook callbacks fire on every path**, including the disabled one, or boot blocks.
- **API keys never reach the browser.** Responses expose `hasApiKey: boolean` only.
- **Provider error bodies are never forwarded to the client.** Log server-side via `logger`; return a sanitised `{ code, message }`.
- All backend files are ESM `.mjs`. All new frontend files are `.tsx`/`.ts`.
- Test commands run from `services/web`. Backend: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run <path>`. Frontend: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js <path>`.
- Commit after each task. Do not push. Do not sign-off with co-author trailers.

## File Structure

| File | Responsibility |
|---|---|
| `modules/ai-assist/index.mjs` | Module entry: `isEnabled()` gate, router registration |
| `app/src/ModuleSettings.mjs` | Environment → `Settings.aiAssist` |
| `app/src/providers/ProviderTypes.mjs` | The five provider types, default base URLs, key requirements |
| `app/src/providers/parseSse.mjs` | Shared SSE frame parser over a web `ReadableStream` |
| `app/src/providers/OpenAiAdapter.mjs` | `openai`, `openai-compatible`, `ollama` |
| `app/src/providers/AnthropicAdapter.mjs` | `anthropic`, `anthropic-compatible` |
| `app/src/EndpointGuard.mjs` | Base-URL validation and SSRF defence |
| `app/src/models/AiAssistModels.mjs` | `AiUserProviderConfig`, `AiUserConsent` |
| `app/src/AiProviderConfigManager.mjs` | Provider-config CRUD and key encryption |
| `app/src/AiConsentManager.mjs` | Consent read/record |
| `app/src/AiProviderResolver.mjs` | User config → env default → none |
| `app/src/AiUsageRateLimiter.mjs` | Per-user daily quota |
| `app/src/ErrorAssistantPrompt.mjs` | Log entry + source context → messages |
| `app/src/AiAssistController.mjs` | Provider-config REST, consent, SSE endpoint |
| `app/src/AiAssistRouter.mjs` | Route table |
| `frontend/js/features/ai-assist/components/ai-providers-widget.tsx` | Account Settings widget |
| `frontend/js/features/ai-assist/components/suggest-fix-button.tsx` | Log-entry header action |
| `frontend/js/features/ai-assist/components/suggest-fix-panel.tsx` | Streaming suggestion panel |
| `frontend/js/features/ai-assist/hooks/use-fix-stream.ts` | SSE client |
| `frontend/js/features/ai-assist/hooks/use-apply-fix-target.ts` | CodeMirror read/replace for Apply-fix |
| `frontend/js/features/ai-assist/parse-fix-block.ts` | Splits a response into explanation and fix block |
| `app/src/DocumentContext.mjs` | Reads current document text and file name |

---

### Task 1: Module skeleton, settings, and the default-off guarantee

**Files:**
- Create: `modules/ai-assist/index.mjs`
- Create: `modules/ai-assist/app/src/ModuleSettings.mjs`
- Create: `modules/ai-assist/app/src/providers/ProviderTypes.mjs`
- Modify: `config/settings.defaults.js:1160-1169` (add `'ai-assist'` to `moduleImportSequence`)
- Test: `modules/ai-assist/test/unit/src/ModuleSettings.test.mjs`
- Test: `modules/ai-assist/test/unit/src/index.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings.aiAssist` shaped `{ enabled: boolean, tokenSecret: string, allowUserProviders: boolean, allowPrivateEndpoints: boolean, defaultProvider: { type, baseUrl, apiKey, model } | null, rateLimitPerDay: number, maxOutputTokens: number, requestTimeoutMs: number }`; `Settings.aiAssistEncryptorOptions`; `PROVIDER_TYPES`, `DEFAULT_BASE_URLS`, `REQUIRES_API_KEY`, `adapterNameForType(type)`.

- [x] **Step 1: Write the failing settings test**

Create `modules/ai-assist/test/unit/src/ModuleSettings.test.mjs`:

```js
import { expect } from 'chai'
import esmock from 'esmock'

const MODULE = '../../../app/src/ModuleSettings.mjs'

async function loadSettings(env) {
  const Settings = {}
  const originalEnv = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AI_ASSIST_')) delete process.env[key]
  }
  Object.assign(process.env, env)
  try {
    await esmock(MODULE, { '@overleaf/settings': Settings })
    return Settings
  } finally {
    process.env = originalEnv
  }
}

describe('ai-assist ModuleSettings', function () {
  it('is disabled by default', async function () {
    const settings = await loadSettings({})
    expect(settings.aiAssist.enabled).to.be.false
    expect(settings.aiAssist.defaultProvider).to.be.null
  })

  it('enables only on the exact string "true"', async function () {
    expect((await loadSettings({ AI_ASSIST_ENABLED: 'true' })).aiAssist.enabled).to.be.true
    expect((await loadSettings({ AI_ASSIST_ENABLED: '1' })).aiAssist.enabled).to.be.false
  })

  it('builds a default provider when a type is given', async function () {
    const settings = await loadSettings({
      AI_ASSIST_ENABLED: 'true',
      AI_ASSIST_DEFAULT_PROVIDER: 'openai',
      AI_ASSIST_DEFAULT_API_KEY: 'sk-test',
      AI_ASSIST_DEFAULT_MODEL: 'gpt-4o-mini',
    })
    expect(settings.aiAssist.defaultProvider).to.deep.equal({
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    })
  })

  it('defaults allowUserProviders to true and allowPrivateEndpoints to false', async function () {
    const settings = await loadSettings({ AI_ASSIST_ENABLED: 'true' })
    expect(settings.aiAssist.allowUserProviders).to.be.true
    expect(settings.aiAssist.allowPrivateEndpoints).to.be.false
  })

  it('derives encryptor options only when a token secret is present', async function () {
    const without = await loadSettings({ AI_ASSIST_ENABLED: 'true' })
    expect(without.aiAssistEncryptorOptions).to.be.undefined
    const with_ = await loadSettings({ AI_ASSIST_ENABLED: 'true', AI_ASSIST_TOKEN_SECRET: 's3cret' })
    expect(with_.aiAssistEncryptorOptions.cipherPasswords['2026.1-v1']).to.equal('s3cret')
  })

  it('parses numeric settings with defaults', async function () {
    const settings = await loadSettings({ AI_ASSIST_ENABLED: 'true', AI_ASSIST_RATE_LIMIT_PER_DAY: '25' })
    expect(settings.aiAssist.rateLimitPerDay).to.equal(25)
    expect(settings.aiAssist.maxOutputTokens).to.equal(1024)
    expect(settings.aiAssist.requestTimeoutMs).to.equal(60000)
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/ModuleSettings.test.mjs`
Expected: FAIL — cannot resolve `ModuleSettings.mjs`.

- [x] **Step 3: Write `ProviderTypes.mjs`**

```js
export const PROVIDER_TYPES = [
  'openai',
  'openai-compatible',
  'anthropic',
  'anthropic-compatible',
  'ollama',
]

export const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': '',
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': '',
  ollama: 'http://localhost:11434/v1',
}

export const REQUIRES_API_KEY = {
  openai: true,
  'openai-compatible': false,
  anthropic: true,
  'anthropic-compatible': false,
  ollama: false,
}

const ADAPTER_BY_TYPE = {
  openai: 'openai',
  'openai-compatible': 'openai',
  ollama: 'openai',
  anthropic: 'anthropic',
  'anthropic-compatible': 'anthropic',
}

/**
 * @param {string} type
 * @returns {'openai' | 'anthropic'}
 */
export function adapterNameForType(type) {
  const adapter = ADAPTER_BY_TYPE[type]
  if (!adapter) throw new Error(`unknown AI provider type: ${type}`)
  return adapter
}
```

- [x] **Step 4: Write `ModuleSettings.mjs`**

```js
import Settings from '@overleaf/settings'
import { DEFAULT_BASE_URLS } from './providers/ProviderTypes.mjs'

function _int(value, fallback) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function _bool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return value === 'true'
}

function _defaultProvider() {
  const type = process.env.AI_ASSIST_DEFAULT_PROVIDER
  if (!type) return null
  return {
    type,
    baseUrl: process.env.AI_ASSIST_DEFAULT_BASE_URL || DEFAULT_BASE_URLS[type] || '',
    apiKey: process.env.AI_ASSIST_DEFAULT_API_KEY || '',
    model: process.env.AI_ASSIST_DEFAULT_MODEL || '',
  }
}

if (Settings.aiAssist === undefined) {
  Settings.aiAssist = {
    enabled: process.env.AI_ASSIST_ENABLED === 'true',
    tokenSecret: process.env.AI_ASSIST_TOKEN_SECRET || '',
    allowUserProviders: _bool(process.env.AI_ASSIST_ALLOW_USER_PROVIDERS, true),
    allowPrivateEndpoints: _bool(process.env.AI_ASSIST_ALLOW_PRIVATE_ENDPOINTS, false),
    defaultProvider: _defaultProvider(),
    rateLimitPerDay: _int(process.env.AI_ASSIST_RATE_LIMIT_PER_DAY, 100),
    maxOutputTokens: _int(process.env.AI_ASSIST_MAX_OUTPUT_TOKENS, 1024),
    requestTimeoutMs: _int(process.env.AI_ASSIST_REQUEST_TIMEOUT_MS, 60000),
  }
}

if (
  Settings.aiAssistEncryptorOptions === undefined &&
  Settings.aiAssist.tokenSecret
) {
  Settings.aiAssistEncryptorOptions = {
    cipherLabel: '2026.1-v1',
    cipherPasswords: { '2026.1-v1': Settings.aiAssist.tokenSecret },
  }
}

export default Settings.aiAssist
```

- [x] **Step 5: Run the settings test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/ModuleSettings.test.mjs`
Expected: PASS (6 tests).

- [x] **Step 6: Write the failing module-gating test**

Create `modules/ai-assist/test/unit/src/index.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

async function loadModule(aiAssist) {
  const applyStub = sinon.stub()
  const mod = await esmock('../../../index.mjs', {
    '@overleaf/settings': { aiAssist },
    '../../../app/src/ModuleSettings.mjs': {},
    '../../../app/src/AiAssistRouter.mjs': {
      default: { apply: applyStub },
    },
  })
  return { mod, applyStub }
}

describe('ai-assist module', function () {
  it('does not reach the router when disabled', async function () {
    const { mod, applyStub } = await loadModule({ enabled: false })
    mod.default.router.apply({}, {}, {})
    expect(applyStub.called).to.be.false
  })

  it('applies the router when enabled', async function () {
    const { mod, applyStub } = await loadModule({ enabled: true })
    const webRouter = {}
    mod.default.router.apply(webRouter, {}, {})
    expect(applyStub.calledOnceWith(webRouter)).to.be.true
  })

  it('treats a missing aiAssist settings block as disabled', async function () {
    const { mod, applyStub } = await loadModule(undefined)
    mod.default.router.apply({}, {}, {})
    expect(applyStub.called).to.be.false
  })

  it('is named ai-assist', async function () {
    const { mod } = await loadModule({ enabled: false })
    expect(mod.default.name).to.equal('ai-assist')
  })
})
```

- [x] **Step 7: Write `index.mjs`**

```js
import './app/src/ModuleSettings.mjs'
import Settings from '@overleaf/settings'
import AiAssistRouter from './app/src/AiAssistRouter.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

// The module is always present in moduleImportSequence so its frontend slot
// registrations resolve at webpack build time. Everything it does at runtime is
// gated here, so an instance with AI_ASSIST_ENABLED unset behaves exactly like
// upstream Overleaf CE: no routes, no hooks, no database work.
function isEnabled() {
  return Boolean(Settings.aiAssist?.enabled)
}

/** @type {WebModule} */
const AiAssistModule = {
  name: 'ai-assist',
  router: {
    // Must stay synchronous — no await, no dynamic import. Modules.mjs does not
    // await applyNonCsrfRouter, so async registration races the server accepting
    // requests.
    apply(webRouter, privateApiRouter, publicApiRouter) {
      if (!isEnabled()) return
      AiAssistRouter.apply(webRouter)
    },
  },
}

export default AiAssistModule
```

- [x] **Step 8: Create a placeholder router so the import resolves**

Create `modules/ai-assist/app/src/AiAssistRouter.mjs`:

```js
// Route table. Populated in Task 8 (provider config, consent) and Task 10 (SSE).
export default {
  apply(webRouter) {},
}
```

- [x] **Step 9: Register the module**

In `config/settings.defaults.js`, add `'ai-assist'` as the last entry of `moduleImportSequence` (currently ending `'comment-notifications',` at line ~1168).

- [x] **Step 10: Run both tests**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/`
Expected: PASS (10 tests — 6 settings, 4 module).

- [x] **Step 11: Commit**

```bash
git add modules/ai-assist config/settings.defaults.js
git commit -m "feat(ai-assist): add module skeleton and settings"
```

---

### Task 2: Mongo models

**Files:**
- Create: `modules/ai-assist/app/src/models/AiAssistModels.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistModels.test.mjs`

**Interfaces:**
- Consumes: `PROVIDER_TYPES` from Task 1.
- Produces: `AiUserProviderConfig`, `AiUserConsent` Mongoose models. `AiUserProviderConfig` fields: `user_id, label, type, baseUrl, model, encryptedApiKey, isActive, createdAt, lastUsedAt`. `AiUserConsent` fields: `user_id, consentedAt, providerFingerprint`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/unit/src/AiAssistModels.test.mjs`:

```js
import { expect } from 'chai'
import {
  AiUserProviderConfig,
  AiUserConsent,
} from '../../../app/src/models/AiAssistModels.mjs'

describe('ai-assist models', function () {
  it('rejects an unknown provider type', function () {
    const doc = new AiUserProviderConfig({
      user_id: '000000000000000000000001',
      label: 'bad',
      type: 'not-a-provider',
      model: 'x',
    })
    const err = doc.validateSync()
    expect(err.errors.type).to.exist
  })

  it('accepts each supported provider type', function () {
    for (const type of ['openai', 'openai-compatible', 'anthropic', 'anthropic-compatible', 'ollama']) {
      const doc = new AiUserProviderConfig({
        user_id: '000000000000000000000001',
        label: `cfg-${type}`,
        type,
        model: 'x',
      })
      expect(doc.validateSync(), type).to.be.undefined
    }
  })

  it('defaults isActive to false', function () {
    const doc = new AiUserProviderConfig({
      user_id: '000000000000000000000001',
      label: 'a',
      type: 'ollama',
      model: 'llama3.1',
    })
    expect(doc.isActive).to.be.false
  })

  it('declares a partial unique index on the active config', function () {
    const indexes = AiUserProviderConfig.schema.indexes()
    const partial = indexes.find(([, options]) => options.partialFilterExpression)
    expect(partial[0]).to.deep.equal({ user_id: 1 })
    expect(partial[1].unique).to.be.true
    expect(partial[1].partialFilterExpression).to.deep.equal({ isActive: true })
  })

  it('requires consent to be unique per user', function () {
    expect(AiUserConsent.schema.path('user_id').options.unique).to.be.true
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModels.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Write the models**

```js
import mongoose from '../../../../app/src/infrastructure/Mongoose.js'
import { PROVIDER_TYPES } from '../providers/ProviderTypes.mjs'

const { Schema } = mongoose
const { ObjectId } = Schema

const AiUserProviderConfigSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    type: { type: String, required: true, enum: PROVIDER_TYPES },
    baseUrl: { type: String, default: '' },
    model: { type: String, required: true, trim: true, maxlength: 120 },
    encryptedApiKey: { type: String, default: '' },
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'aiUserProviderConfigs', minimize: false }
)

AiUserProviderConfigSchema.index({ user_id: 1, label: 1 }, { unique: true })
// At most one active config per user, enforced by the database rather than by
// application logic, so a concurrent activate cannot leave two rows active.
AiUserProviderConfigSchema.index(
  { user_id: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
)

const AiUserConsentSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, unique: true },
    consentedAt: { type: Date, default: Date.now },
    providerFingerprint: { type: String, default: '' },
  },
  { collection: 'aiUserConsents', minimize: false }
)

export const AiUserProviderConfig = mongoose.model(
  'AiUserProviderConfig',
  AiUserProviderConfigSchema
)
export const AiUserConsent = mongoose.model('AiUserConsent', AiUserConsentSchema)
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistModels.test.mjs`
Expected: PASS (5 tests).

If the `Mongoose.js` import path fails, check how `modules/github-sync/app/src/models/GithubSyncModels.mjs` imports it and match exactly.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add provider config and consent models"
```

---

### Task 3: EndpointGuard (SSRF defence)

This is the module's most security-sensitive unit. A user-supplied base URL makes an authenticated user a source of outbound requests from inside the deployment's network.

**Files:**
- Create: `modules/ai-assist/app/src/EndpointGuard.mjs`
- Test: `modules/ai-assist/test/unit/src/EndpointGuard.test.mjs`

**Interfaces:**
- Consumes: `Settings.aiAssist.allowPrivateEndpoints` from Task 1.
- Produces: `validateBaseUrl(baseUrl) -> URL` (throws `InvalidBaseUrlError`); `assertEndpointAllowed(baseUrl) -> Promise<void>` (throws `BlockedEndpointError`); `isPrivateAddress(ip) -> boolean`; error classes `InvalidBaseUrlError`, `BlockedEndpointError`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/unit/src/EndpointGuard.test.mjs`:

```js
import { expect } from 'chai'
import esmock from 'esmock'

async function load({ allowPrivateEndpoints = false, lookupResult = [{ address: '93.184.216.34', family: 4 }] } = {}) {
  return esmock('../../../app/src/EndpointGuard.mjs', {
    '@overleaf/settings': { aiAssist: { allowPrivateEndpoints } },
    'node:dns/promises': { lookup: async () => lookupResult },
  })
}

describe('EndpointGuard', function () {
  describe('validateBaseUrl', function () {
    it('accepts https and http URLs', async function () {
      const { validateBaseUrl } = await load()
      expect(validateBaseUrl('https://api.openai.com/v1').protocol).to.equal('https:')
      expect(validateBaseUrl('http://localhost:11434/v1').protocol).to.equal('http:')
    })

    it('rejects non-http schemes', async function () {
      const { validateBaseUrl, InvalidBaseUrlError } = await load()
      for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
        expect(() => validateBaseUrl(url), url).to.throw(InvalidBaseUrlError)
      }
    })

    it('rejects unparseable input', async function () {
      const { validateBaseUrl, InvalidBaseUrlError } = await load()
      expect(() => validateBaseUrl('not a url')).to.throw(InvalidBaseUrlError)
      expect(() => validateBaseUrl('')).to.throw(InvalidBaseUrlError)
    })
  })

  describe('isPrivateAddress', function () {
    it('flags private, loopback, and link-local ranges', async function () {
      const { isPrivateAddress } = await load()
      const blocked = [
        '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
        '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
        '::1', 'fc00::1', 'fe80::1',
      ]
      for (const ip of blocked) {
        expect(isPrivateAddress(ip), ip).to.be.true
      }
    })

    it('allows public addresses', async function () {
      const { isPrivateAddress } = await load()
      for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
        expect(isPrivateAddress(ip), ip).to.be.false
      }
    })
  })

  describe('assertEndpointAllowed', function () {
    it('allows a public host', async function () {
      const { assertEndpointAllowed } = await load()
      await assertEndpointAllowed('https://api.openai.com/v1')
    })

    it('blocks the cloud metadata address by default', async function () {
      const { assertEndpointAllowed, BlockedEndpointError } = await load({
        lookupResult: [{ address: '169.254.169.254', family: 4 }],
      })
      try {
        await assertEndpointAllowed('http://metadata.internal/v1')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).to.be.instanceOf(BlockedEndpointError)
      }
    })

    it('allows private addresses when explicitly permitted', async function () {
      const { assertEndpointAllowed } = await load({
        allowPrivateEndpoints: true,
        lookupResult: [{ address: '127.0.0.1', family: 4 }],
      })
      await assertEndpointAllowed('http://localhost:11434/v1')
    })

    it('blocks when any resolved address is private', async function () {
      const { assertEndpointAllowed, BlockedEndpointError } = await load({
        lookupResult: [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      })
      try {
        await assertEndpointAllowed('http://dns-rebind.example/v1')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).to.be.instanceOf(BlockedEndpointError)
      }
    })
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/EndpointGuard.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `EndpointGuard.mjs`**

```js
import dns from 'node:dns/promises'
import net from 'node:net'
import Settings from '@overleaf/settings'

export class InvalidBaseUrlError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidBaseUrlError'
  }
}

export class BlockedEndpointError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedEndpointError'
  }
}

/**
 * @param {string} baseUrl
 * @returns {URL}
 */
export function validateBaseUrl(baseUrl) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new InvalidBaseUrlError('base URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidBaseUrlError('base URL must use http or https')
  }
  return url
}

function _ipv4IsPrivate(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  return false
}

function _ipv6IsPrivate(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
  if (lower.startsWith('fe8') || lower.startsWith('fe9')) return true // link-local
  if (lower.startsWith('fea') || lower.startsWith('feb')) return true
  if (lower.startsWith('::ffff:')) return _ipv4IsPrivate(lower.slice(7))
  return false
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return _ipv4IsPrivate(ip)
  if (net.isIPv6(ip)) return _ipv6IsPrivate(ip)
  return true // unparseable: fail closed
}

/**
 * Resolves the host and rejects private, loopback, and link-local destinations
 * unless the administrator has opted in. Called both when a configuration is
 * saved and again immediately before each request, so a hostname that later
 * resolves differently cannot slip through.
 *
 * @param {string} baseUrl
 */
export async function assertEndpointAllowed(baseUrl) {
  const url = validateBaseUrl(baseUrl)
  if (Settings.aiAssist?.allowPrivateEndpoints) return

  let addresses
  try {
    addresses = await dns.lookup(url.hostname, { all: true })
  } catch {
    throw new BlockedEndpointError('could not resolve the provider host')
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedEndpointError(
        'the provider host resolves to a private address; set AI_ASSIST_ALLOW_PRIVATE_ENDPOINTS=true to allow this'
      )
    }
  }
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/EndpointGuard.test.mjs`
Expected: PASS (9 tests).

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add endpoint guard for SSRF defence"
```

---

### Task 4: SSE frame parser and the OpenAI adapter

**Files:**
- Create: `modules/ai-assist/app/src/providers/parseSse.mjs`
- Create: `modules/ai-assist/app/src/providers/OpenAiAdapter.mjs`
- Test: `modules/ai-assist/test/unit/src/parseSse.test.mjs`
- Test: `modules/ai-assist/test/unit/src/OpenAiAdapter.test.mjs`

**Interfaces:**
- Consumes: `assertEndpointAllowed` from Task 3.
- Produces: `parseSseFrames(stream) -> AsyncIterable<{ event: string|null, data: string }>`; `OpenAiAdapter` class with `constructor({ baseUrl, apiKey, model, timeoutMs })` and `async *streamChat({ system, messages, maxTokens, signal }) -> AsyncIterable<{type:'text',text} | {type:'done',usage}>`; `ProviderRequestError` with a `status` property.

- [x] **Step 1: Write the failing parser test**

Create `modules/ai-assist/test/unit/src/parseSse.test.mjs`:

```js
import { expect } from 'chai'
import { parseSseFrames } from '../../../app/src/providers/parseSse.mjs'

function streamOf(...chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream) {
  const out = []
  for await (const frame of parseSseFrames(stream)) out.push(frame)
  return out
}

describe('parseSseFrames', function () {
  it('parses simple data frames', async function () {
    const frames = await collect(streamOf('data: one\n\ndata: two\n\n'))
    expect(frames).to.deep.equal([
      { event: null, data: 'one' },
      { event: null, data: 'two' },
    ])
  })

  it('reassembles a frame split across chunks', async function () {
    const frames = await collect(streamOf('data: hel', 'lo\n\n'))
    expect(frames).to.deep.equal([{ event: null, data: 'hello' }])
  })

  it('captures named events', async function () {
    const frames = await collect(streamOf('event: content_block_delta\ndata: {"x":1}\n\n'))
    expect(frames).to.deep.equal([
      { event: 'content_block_delta', data: '{"x":1}' },
    ])
  })

  it('joins multi-line data with newlines', async function () {
    const frames = await collect(streamOf('data: a\ndata: b\n\n'))
    expect(frames).to.deep.equal([{ event: null, data: 'a\nb' }])
  })

  it('ignores comment heartbeats', async function () {
    const frames = await collect(streamOf(': keep-alive\n\ndata: real\n\n'))
    expect(frames).to.deep.equal([{ event: null, data: 'real' }])
  })

  it('handles CRLF line endings', async function () {
    const frames = await collect(streamOf('data: x\r\n\r\n'))
    expect(frames).to.deep.equal([{ event: null, data: 'x' }])
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/parseSse.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `parseSse.mjs`**

```js
/**
 * Parses a Server-Sent Events byte stream into frames. Handles frames split
 * across chunk boundaries, CRLF endings, multi-line data, and comment
 * heartbeats.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<{ event: string | null, data: string }>}
 */
export async function* parseSseFrames(stream) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        let event = null
        const dataLines = []
        for (const line of raw.split('\n')) {
          if (line === '' || line.startsWith(':')) continue
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (dataLines.length) yield { event, data: dataLines.join('\n') }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
```

- [x] **Step 4: Run the parser test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/parseSse.test.mjs`
Expected: PASS (6 tests).

- [x] **Step 5: Write the failing adapter test**

Create `modules/ai-assist/test/unit/src/OpenAiAdapter.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

function sseResponse(body, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    text: async () => body,
  }
}

async function load(fetchStub) {
  return esmock('../../../app/src/providers/OpenAiAdapter.mjs', {
    '../../../app/src/EndpointGuard.mjs': { assertEndpointAllowed: async () => {} },
    '@overleaf/logger': { default: { error: sinon.stub(), warn: sinon.stub() } },
  }, {}, { global: { fetch: fetchStub } })
}

describe('OpenAiAdapter', function () {
  let fetchStub

  beforeEach(function () {
    fetchStub = sinon.stub()
    global.fetch = fetchStub
  })

  async function drain(adapter, request = { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }) {
    const chunks = []
    for await (const chunk of adapter.streamChat(request)) chunks.push(chunk)
    return chunks
  }

  it('yields text deltas and a done chunk', async function () {
    fetchStub.resolves(sseResponse(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":7}}\n\n' +
      'data: [DONE]\n\n'
    ))
    const { default: OpenAiAdapter } = await load(fetchStub)
    const adapter = new OpenAiAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-4o-mini', timeoutMs: 1000 })
    const chunks = await drain(adapter)
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).to.equal('Hello')
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', usage: { total_tokens: 7 } })
  })

  it('posts to {baseUrl}/chat/completions with the bearer token', async function () {
    fetchStub.resolves(sseResponse('data: [DONE]\n\n'))
    const { default: OpenAiAdapter } = await load(fetchStub)
    const adapter = new OpenAiAdapter({ baseUrl: 'http://ollama:11434/v1', apiKey: '', model: 'llama3.1', timeoutMs: 1000 })
    await drain(adapter)
    const [url, options] = fetchStub.firstCall.args
    expect(url).to.equal('http://ollama:11434/v1/chat/completions')
    const body = JSON.parse(options.body)
    expect(body.model).to.equal('llama3.1')
    expect(body.stream).to.be.true
    expect(body.messages[0]).to.deep.equal({ role: 'system', content: 's' })
    expect(options.headers.Authorization).to.be.undefined
  })

  it('sends Authorization when an API key is present', async function () {
    fetchStub.resolves(sseResponse('data: [DONE]\n\n'))
    const { default: OpenAiAdapter } = await load(fetchStub)
    const adapter = new OpenAiAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-4o-mini', timeoutMs: 1000 })
    await drain(adapter)
    expect(fetchStub.firstCall.args[1].headers.Authorization).to.equal('Bearer sk-x')
  })

  it('throws ProviderRequestError carrying the status on a non-2xx response', async function () {
    fetchStub.resolves(sseResponse('{"error":{"message":"bad key","type":"invalid_request"}}', { status: 401 }))
    const { default: OpenAiAdapter, ProviderRequestError } = await load(fetchStub)
    const adapter = new OpenAiAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', model: 'gpt-4o-mini', timeoutMs: 1000 })
    try {
      await drain(adapter)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).to.be.instanceOf(ProviderRequestError)
      expect(err.status).to.equal(401)
      // The raw provider body must not travel to the client.
      expect(err.message).to.not.include('bad key')
    }
  })

  it('skips malformed JSON frames rather than aborting the stream', async function () {
    fetchStub.resolves(sseResponse(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
      'data: {not json\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n' +
      'data: [DONE]\n\n'
    ))
    const { default: OpenAiAdapter } = await load(fetchStub)
    const adapter = new OpenAiAdapter({ baseUrl: 'https://x/v1', apiKey: '', model: 'm', timeoutMs: 1000 })
    const chunks = await drain(adapter)
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).to.equal('ab')
  })
})
```

- [x] **Step 6: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/OpenAiAdapter.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 7: Implement `OpenAiAdapter.mjs`**

```js
import logger from '@overleaf/logger'
import { assertEndpointAllowed } from '../EndpointGuard.mjs'
import { parseSseFrames } from './parseSse.mjs'

export class ProviderRequestError extends Error {
  /**
   * @param {string} message - safe for the client; never the provider's body
   * @param {number} status
   */
  constructor(message, status) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = status
  }
}

export default class OpenAiAdapter {
  /**
   * @param {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number }} config
   */
  constructor({ baseUrl, apiKey, model, timeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutMs
  }

  /**
   * @param {{ system: string, messages: Array<{role: string, content: string}>, maxTokens: number, signal?: AbortSignal }} request
   * @returns {AsyncGenerator<{type:'text',text:string} | {type:'done',usage:object}>}
   */
  async *streamChat({ system, messages, maxTokens, signal }) {
    await assertEndpointAllowed(this.baseUrl)

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      })

      if (!response.ok) {
        // The provider's body can echo request headers, so it is logged but
        // never returned to the caller.
        const body = await response.text().catch(() => '')
        logger.error({ status: response.status, body }, 'AI provider request failed')
        throw new ProviderRequestError('the AI provider rejected the request', response.status)
      }

      let usage = {}
      for await (const frame of parseSseFrames(response.body)) {
        if (frame.data === '[DONE]') break
        let payload
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue // a truncated or non-JSON frame must not kill the stream
        }
        if (payload.usage) usage = payload.usage
        const text = payload.choices?.[0]?.delta?.content
        if (text) yield { type: 'text', text }
      }
      yield { type: 'done', usage }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
```

- [x] **Step 8: Run the adapter test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/OpenAiAdapter.test.mjs`
Expected: PASS (5 tests).

- [x] **Step 9: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add SSE parser and OpenAI provider adapter"
```

---

### Task 5: Anthropic adapter

**Files:**
- Create: `modules/ai-assist/app/src/providers/AnthropicAdapter.mjs`
- Test: `modules/ai-assist/test/unit/src/AnthropicAdapter.test.mjs`

**Interfaces:**
- Consumes: `parseSseFrames`, `ProviderRequestError` (re-exported from `OpenAiAdapter.mjs`), `assertEndpointAllowed`.
- Produces: `AnthropicAdapter` with the identical constructor and `streamChat` signature as `OpenAiAdapter`, so `AiProviderResolver` can treat them interchangeably.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/unit/src/AnthropicAdapter.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

function sseResponse(body, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    text: async () => body,
  }
}

async function load() {
  return esmock('../../../app/src/providers/AnthropicAdapter.mjs', {
    '../../../app/src/EndpointGuard.mjs': { assertEndpointAllowed: async () => {} },
    '@overleaf/logger': { default: { error: sinon.stub(), warn: sinon.stub() } },
  })
}

describe('AnthropicAdapter', function () {
  let fetchStub

  beforeEach(function () {
    fetchStub = sinon.stub()
    global.fetch = fetchStub
  })

  async function drain(adapter) {
    const chunks = []
    for await (const chunk of adapter.streamChat({
      system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100,
    })) chunks.push(chunk)
    return chunks
  }

  it('yields text from content_block_delta events', async function () {
    fetchStub.resolves(sseResponse(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"lo"}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {}\n\n'
    ))
    const { default: AnthropicAdapter } = await load()
    const adapter = new AnthropicAdapter({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-sonnet-5', timeoutMs: 1000 })
    const chunks = await drain(adapter)
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).to.equal('Hello')
    expect(chunks.at(-1)).to.deep.equal({ type: 'done', usage: { output_tokens: 5 } })
  })

  it('posts to {baseUrl}/v1/messages with the anthropic headers and a top-level system field', async function () {
    fetchStub.resolves(sseResponse('event: message_stop\ndata: {}\n\n'))
    const { default: AnthropicAdapter } = await load()
    const adapter = new AnthropicAdapter({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-sonnet-5', timeoutMs: 1000 })
    await drain(adapter)
    const [url, options] = fetchStub.firstCall.args
    expect(url).to.equal('https://api.anthropic.com/v1/messages')
    expect(options.headers['x-api-key']).to.equal('k')
    expect(options.headers['anthropic-version']).to.equal('2023-06-01')
    const body = JSON.parse(options.body)
    // Anthropic takes `system` as a top-level field, not a message role.
    expect(body.system).to.equal('sys')
    expect(body.messages).to.deep.equal([{ role: 'user', content: 'hi' }])
    expect(body.max_tokens).to.equal(100)
    expect(body.stream).to.be.true
  })

  it('throws ProviderRequestError without leaking the provider body', async function () {
    fetchStub.resolves(sseResponse('{"error":{"message":"invalid x-api-key"}}', { status: 401 }))
    const { default: AnthropicAdapter, ProviderRequestError } = await load()
    const adapter = new AnthropicAdapter({ baseUrl: 'https://api.anthropic.com', apiKey: 'bad', model: 'm', timeoutMs: 1000 })
    try {
      await drain(adapter)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).to.be.instanceOf(ProviderRequestError)
      expect(err.status).to.equal(401)
      expect(err.message).to.not.include('invalid x-api-key')
    }
  })

  it('surfaces a mid-stream error event', async function () {
    fetchStub.resolves(sseResponse(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"a"}}\n\n' +
      'event: error\ndata: {"error":{"message":"overloaded"}}\n\n'
    ))
    const { default: AnthropicAdapter, ProviderRequestError } = await load()
    const adapter = new AnthropicAdapter({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'm', timeoutMs: 1000 })
    try {
      await drain(adapter)
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).to.be.instanceOf(ProviderRequestError)
    }
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AnthropicAdapter.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `AnthropicAdapter.mjs`**

```js
import logger from '@overleaf/logger'
import { assertEndpointAllowed } from '../EndpointGuard.mjs'
import { parseSseFrames } from './parseSse.mjs'
import { ProviderRequestError } from './OpenAiAdapter.mjs'

export { ProviderRequestError }

const ANTHROPIC_VERSION = '2023-06-01'

export default class AnthropicAdapter {
  /**
   * @param {{ baseUrl: string, apiKey: string, model: string, timeoutMs: number }} config
   */
  constructor({ baseUrl, apiKey, model, timeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutMs
  }

  /**
   * @param {{ system: string, messages: Array<{role: string, content: string}>, maxTokens: number, signal?: AbortSignal }} request
   * @returns {AsyncGenerator<{type:'text',text:string} | {type:'done',usage:object}>}
   */
  async *streamChat({ system, messages, maxTokens, signal }) {
    await assertEndpointAllowed(this.baseUrl)

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (this.apiKey) headers['x-api-key'] = this.apiKey

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: true,
          max_tokens: maxTokens,
          system, // Anthropic takes system as a top-level field
          messages,
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        logger.error({ status: response.status, body }, 'AI provider request failed')
        throw new ProviderRequestError('the AI provider rejected the request', response.status)
      }

      let usage = {}
      for await (const frame of parseSseFrames(response.body)) {
        let payload
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue
        }
        if (frame.event === 'error') {
          logger.error({ payload }, 'AI provider returned a mid-stream error')
          throw new ProviderRequestError('the AI provider ended the stream with an error', 502)
        }
        if (frame.event === 'message_delta' && payload.usage) usage = payload.usage
        if (frame.event === 'content_block_delta' && payload.delta?.type === 'text_delta') {
          yield { type: 'text', text: payload.delta.text }
        }
        if (frame.event === 'message_stop') break
      }
      yield { type: 'done', usage }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AnthropicAdapter.test.mjs`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add Anthropic provider adapter"
```

---

### Task 6: Provider config manager (encryption and CRUD)

**Files:**
- Create: `modules/ai-assist/app/src/AiProviderConfigManager.mjs`
- Test: `modules/ai-assist/test/unit/src/AiProviderConfigManager.test.mjs`

**Interfaces:**
- Consumes: `AiUserProviderConfig` (Task 2); `validateBaseUrl`, `assertEndpointAllowed` (Task 3); `PROVIDER_TYPES`, `DEFAULT_BASE_URLS`, `REQUIRES_API_KEY` (Task 1).
- Produces: `AiProviderConfigManager.promises` with `listConfigs(userId)`, `createConfig(userId, input)`, `updateConfig(userId, configId, input)`, `deleteConfig(userId, configId)`, `setActive(userId, configId)`, `getActiveWithKey(userId)`. `listConfigs` returns objects shaped `{ _id, label, type, baseUrl, model, hasApiKey, isActive, createdAt, lastUsedAt }` — never a key. `getActiveWithKey` returns `{ type, baseUrl, model, apiKey } | null`.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/unit/src/AiProviderConfigManager.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

const USER_ID = '000000000000000000000001'

function makeModel(docs = []) {
  const store = [...docs]
  return {
    store,
    find: sinon.stub().callsFake(() => ({ lean: async () => store })),
    findOne: sinon.stub().callsFake(query => ({
      lean: async () => store.find(d =>
        String(d.user_id) === String(query.user_id) &&
        (query._id === undefined || String(d._id) === String(query._id)) &&
        (query.isActive === undefined || d.isActive === query.isActive)
      ) || null,
    })),
    create: sinon.stub().callsFake(async doc => ({ ...doc, _id: 'new-id' })),
    updateOne: sinon.stub().resolves({ matchedCount: 1 }),
    updateMany: sinon.stub().resolves({}),
    deleteOne: sinon.stub().resolves({ deletedCount: 1 }),
  }
}

async function load(model, { encryptor = true } = {}) {
  return esmock('../../../app/src/AiProviderConfigManager.mjs', {
    '../../../app/src/models/AiAssistModels.mjs': { AiUserProviderConfig: model },
    '../../../app/src/EndpointGuard.mjs': {
      validateBaseUrl: url => new URL(url),
      assertEndpointAllowed: async () => {},
    },
    '@overleaf/settings': { aiAssist: { allowUserProviders: true }, aiAssistEncryptorOptions: encryptor ? { cipherLabel: 'l', cipherPasswords: { l: 'x'.repeat(32) } } : undefined },
    '@overleaf/access-token-encryptor': {
      default: class {
        constructor() {
          this.promises = {
            encryptJson: async json => `enc:${JSON.stringify(json)}`,
            decryptToJson: async blob => JSON.parse(blob.replace(/^enc:/, '')),
          }
        }
      },
    },
    '@overleaf/logger': { default: { error: sinon.stub(), warn: sinon.stub() } },
  })
}

describe('AiProviderConfigManager', function () {
  it('never returns an API key from listConfigs', async function () {
    const model = makeModel([
      { _id: 'a', user_id: USER_ID, label: 'One', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', encryptedApiKey: 'enc:{"apiKey":"sk-secret"}', isActive: true },
    ])
    const { default: Manager } = await load(model)
    const configs = await Manager.promises.listConfigs(USER_ID)
    expect(configs[0].hasApiKey).to.be.true
    expect(configs[0]).to.not.have.property('encryptedApiKey')
    expect(configs[0]).to.not.have.property('apiKey')
    expect(JSON.stringify(configs)).to.not.include('sk-secret')
  })

  it('encrypts the key on create', async function () {
    const model = makeModel()
    const { default: Manager } = await load(model)
    await Manager.promises.createConfig(USER_ID, {
      label: 'Work', type: 'openai', baseUrl: '', model: 'gpt-4o-mini', apiKey: 'sk-plain',
    })
    const created = model.create.firstCall.args[0]
    expect(created.encryptedApiKey).to.equal('enc:{"apiKey":"sk-plain"}')
    expect(JSON.stringify(created)).to.not.include('"sk-plain"')
  })

  it('fills in the default base URL when none is given', async function () {
    const model = makeModel()
    const { default: Manager } = await load(model)
    await Manager.promises.createConfig(USER_ID, { label: 'A', type: 'openai', baseUrl: '', model: 'gpt-4o-mini', apiKey: 'sk' })
    expect(model.create.firstCall.args[0].baseUrl).to.equal('https://api.openai.com/v1')
  })

  it('rejects an unknown provider type', async function () {
    const { default: Manager } = await load(makeModel())
    await expect(
      Manager.promises.createConfig(USER_ID, { label: 'A', type: 'bogus', baseUrl: '', model: 'm', apiKey: '' })
    ).to.be.rejectedWith(/provider type/i)
  })

  it('requires an API key for types that need one', async function () {
    const { default: Manager } = await load(makeModel())
    await expect(
      Manager.promises.createConfig(USER_ID, { label: 'A', type: 'anthropic', baseUrl: '', model: 'm', apiKey: '' })
    ).to.be.rejectedWith(/API key/i)
  })

  it('allows a keyless ollama config', async function () {
    const model = makeModel()
    const { default: Manager } = await load(model)
    await Manager.promises.createConfig(USER_ID, { label: 'Local', type: 'ollama', baseUrl: '', model: 'llama3.1', apiKey: '' })
    expect(model.create.firstCall.args[0].encryptedApiKey).to.equal('')
  })

  it('requires a base URL for the custom-compatible types', async function () {
    const { default: Manager } = await load(makeModel())
    await expect(
      Manager.promises.createConfig(USER_ID, { label: 'A', type: 'openai-compatible', baseUrl: '', model: 'm', apiKey: '' })
    ).to.be.rejectedWith(/base URL/i)
  })

  it('deactivates the previous config before activating a new one', async function () {
    const model = makeModel([{ _id: 'b', user_id: USER_ID, label: 'B', type: 'ollama', model: 'm', isActive: false }])
    const { default: Manager } = await load(model)
    await Manager.promises.setActive(USER_ID, 'b')
    expect(model.updateMany.calledBefore(model.updateOne)).to.be.true
    expect(model.updateMany.firstCall.args[1]).to.deep.equal({ $set: { isActive: false } })
  })

  it('decrypts the key in getActiveWithKey', async function () {
    const model = makeModel([
      { _id: 'a', user_id: USER_ID, label: 'One', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', encryptedApiKey: 'enc:{"apiKey":"sk-secret"}', isActive: true },
    ])
    const { default: Manager } = await load(model)
    expect(await Manager.promises.getActiveWithKey(USER_ID)).to.deep.equal({
      type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-secret',
    })
  })

  it('returns null from getActiveWithKey when nothing is active', async function () {
    const { default: Manager } = await load(makeModel())
    expect(await Manager.promises.getActiveWithKey(USER_ID)).to.be.null
  })

  it('scopes deletes to the owning user', async function () {
    const model = makeModel()
    const { default: Manager } = await load(model)
    await Manager.promises.deleteConfig(USER_ID, 'a')
    expect(model.deleteOne.firstCall.args[0]).to.deep.equal({ _id: 'a', user_id: USER_ID })
  })
})
```

Note: this file relies on `chai-as-promised`, already registered by `test/unit/bootstrap.mjs`.

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiProviderConfigManager.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `AiProviderConfigManager.mjs`**

```js
import AccessTokenEncryptor from '@overleaf/access-token-encryptor'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { AiUserProviderConfig } from './models/AiAssistModels.mjs'
import { validateBaseUrl, assertEndpointAllowed } from './EndpointGuard.mjs'
import {
  PROVIDER_TYPES,
  DEFAULT_BASE_URLS,
  REQUIRES_API_KEY,
} from './providers/ProviderTypes.mjs'

// Same defensive pattern as GitHubCredentialsManager.mjs:9-19 — a missing
// AI_ASSIST_TOKEN_SECRET must not crash boot.
let accessTokenEncryptor
try {
  accessTokenEncryptor = new AccessTokenEncryptor(
    Settings.aiAssistEncryptorOptions
  )
} catch (error) {
  logger.error(
    { err: error },
    'Failed to initialise AI provider key encryption. Please ensure AI_ASSIST_TOKEN_SECRET is set.'
  )
}

function _requireEncryptor() {
  if (!accessTokenEncryptor) {
    throw new Error('AI key encryption not configured; set AI_ASSIST_TOKEN_SECRET')
  }
}

export class InvalidProviderConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvalidProviderConfigError'
  }
}

function _normalise({ label, type, baseUrl, model, apiKey }) {
  if (!PROVIDER_TYPES.includes(type)) {
    throw new InvalidProviderConfigError(`unsupported provider type: ${type}`)
  }
  if (!label || !label.trim()) {
    throw new InvalidProviderConfigError('a label is required')
  }
  if (!model || !model.trim()) {
    throw new InvalidProviderConfigError('a model name is required')
  }
  const resolvedBaseUrl = (baseUrl || '').trim() || DEFAULT_BASE_URLS[type]
  if (!resolvedBaseUrl) {
    throw new InvalidProviderConfigError('a base URL is required for this provider type')
  }
  validateBaseUrl(resolvedBaseUrl)
  if (REQUIRES_API_KEY[type] && !apiKey) {
    throw new InvalidProviderConfigError('an API key is required for this provider type')
  }
  return { label: label.trim(), type, baseUrl: resolvedBaseUrl, model: model.trim() }
}

function _present(doc) {
  return {
    _id: doc._id,
    label: doc.label,
    type: doc.type,
    baseUrl: doc.baseUrl,
    model: doc.model,
    hasApiKey: Boolean(doc.encryptedApiKey),
    isActive: Boolean(doc.isActive),
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt,
  }
}

async function listConfigs(userId) {
  const docs = await AiUserProviderConfig.find({ user_id: userId }).lean()
  return docs.map(_present)
}

async function createConfig(userId, input) {
  const fields = _normalise(input)
  await assertEndpointAllowed(fields.baseUrl)
  let encryptedApiKey = ''
  if (input.apiKey) {
    _requireEncryptor()
    encryptedApiKey = await accessTokenEncryptor.promises.encryptJson({ apiKey: input.apiKey })
  }
  const created = await AiUserProviderConfig.create({
    user_id: userId,
    ...fields,
    encryptedApiKey,
    isActive: false,
    createdAt: new Date(),
  })
  return _present(created)
}

async function updateConfig(userId, configId, input) {
  const fields = _normalise(input)
  await assertEndpointAllowed(fields.baseUrl)
  const update = { ...fields }
  // An absent apiKey means "leave the stored key alone"; an empty string clears it.
  if (input.apiKey) {
    _requireEncryptor()
    update.encryptedApiKey = await accessTokenEncryptor.promises.encryptJson({ apiKey: input.apiKey })
  } else if (input.apiKey === '') {
    update.encryptedApiKey = ''
  }
  await AiUserProviderConfig.updateOne({ _id: configId, user_id: userId }, { $set: update })
}

async function deleteConfig(userId, configId) {
  await AiUserProviderConfig.deleteOne({ _id: configId, user_id: userId })
}

async function setActive(userId, configId) {
  // Clear first: the partial unique index rejects a second active row.
  await AiUserProviderConfig.updateMany(
    { user_id: userId, isActive: true },
    { $set: { isActive: false } }
  )
  await AiUserProviderConfig.updateOne(
    { _id: configId, user_id: userId },
    { $set: { isActive: true } }
  )
}

async function getActiveWithKey(userId) {
  const doc = await AiUserProviderConfig.findOne({ user_id: userId, isActive: true }).lean()
  if (!doc) return null
  let apiKey = ''
  if (doc.encryptedApiKey) {
    _requireEncryptor()
    ;({ apiKey } = await accessTokenEncryptor.promises.decryptToJson(doc.encryptedApiKey))
  }
  return { type: doc.type, baseUrl: doc.baseUrl, model: doc.model, apiKey }
}

export default {
  promises: {
    listConfigs,
    createConfig,
    updateConfig,
    deleteConfig,
    setActive,
    getActiveWithKey,
  },
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiProviderConfigManager.test.mjs`
Expected: PASS (11 tests).

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add provider config manager with key encryption"
```

---

### Task 7: Provider resolver, consent manager, and usage rate limiter

**Files:**
- Create: `modules/ai-assist/app/src/AiProviderResolver.mjs`
- Create: `modules/ai-assist/app/src/AiConsentManager.mjs`
- Create: `modules/ai-assist/app/src/AiUsageRateLimiter.mjs`
- Test: `modules/ai-assist/test/unit/src/AiProviderResolver.test.mjs`
- Test: `modules/ai-assist/test/unit/src/AiUsageRateLimiter.test.mjs`

**Interfaces:**
- Consumes: `AiProviderConfigManager.promises.getActiveWithKey` (Task 6); `OpenAiAdapter`, `AnthropicAdapter` (Tasks 4-5); `adapterNameForType` (Task 1); `AiUserConsent` (Task 2).
- Produces: `resolveProvider(userId) -> Promise<{ adapter, descriptor: { type, host, model }, source: 'user'|'default' } | null>`; `AiConsentManager.promises.hasConsented(userId)`, `recordConsent(userId, fingerprint)`; `AiUsageRateLimiter` default export (an instance) with the inherited `useFeature(userId, res, cost, options)`.

- [x] **Step 1: Write the failing resolver test**

Create `modules/ai-assist/test/unit/src/AiProviderResolver.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

const USER_ID = '000000000000000000000001'

async function load({ activeConfig = null, aiAssist }) {
  return esmock('../../../app/src/AiProviderResolver.mjs', {
    '../../../app/src/AiProviderConfigManager.mjs': {
      default: { promises: { getActiveWithKey: sinon.stub().resolves(activeConfig) } },
    },
    '@overleaf/settings': { aiAssist },
  })
}

const BASE = { allowUserProviders: true, maxOutputTokens: 1024, requestTimeoutMs: 60000, defaultProvider: null }

describe('AiProviderResolver', function () {
  it('returns null when nothing is configured', async function () {
    const { resolveProvider } = await load({ aiAssist: { ...BASE } })
    expect(await resolveProvider(USER_ID)).to.be.null
  })

  it("prefers the user's active config", async function () {
    const { resolveProvider } = await load({
      activeConfig: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk' },
      aiAssist: { ...BASE, defaultProvider: { type: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' } },
    })
    const resolved = await resolveProvider(USER_ID)
    expect(resolved.source).to.equal('user')
    expect(resolved.descriptor).to.deep.equal({ type: 'openai', host: 'api.openai.com', model: 'gpt-4o-mini' })
  })

  it('falls back to the environment default', async function () {
    const { resolveProvider } = await load({
      aiAssist: { ...BASE, defaultProvider: { type: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' } },
    })
    const resolved = await resolveProvider(USER_ID)
    expect(resolved.source).to.equal('default')
    expect(resolved.descriptor.model).to.equal('llama3.1')
  })

  it('ignores the user config when allowUserProviders is false', async function () {
    const { resolveProvider } = await load({
      activeConfig: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk' },
      aiAssist: { ...BASE, allowUserProviders: false, defaultProvider: { type: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' } },
    })
    expect((await resolveProvider(USER_ID)).source).to.equal('default')
  })

  it('selects the Anthropic adapter for anthropic types', async function () {
    const { resolveProvider } = await load({
      activeConfig: { type: 'anthropic-compatible', baseUrl: 'https://proxy.example', model: 'claude-sonnet-5', apiKey: 'k' },
      aiAssist: { ...BASE },
    })
    const resolved = await resolveProvider(USER_ID)
    expect(resolved.adapter.constructor.name).to.equal('AnthropicAdapter')
  })

  it('selects the OpenAI adapter for ollama', async function () {
    const { resolveProvider } = await load({
      activeConfig: { type: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '' },
      aiAssist: { ...BASE },
    })
    expect((await resolveProvider(USER_ID)).adapter.constructor.name).to.equal('OpenAiAdapter')
  })

  it('never exposes the API key in the descriptor', async function () {
    const { resolveProvider } = await load({
      activeConfig: { type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-secret' },
      aiAssist: { ...BASE },
    })
    const { descriptor } = await resolveProvider(USER_ID)
    expect(JSON.stringify(descriptor)).to.not.include('sk-secret')
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiProviderResolver.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `AiProviderResolver.mjs`**

```js
import Settings from '@overleaf/settings'
import AiProviderConfigManager from './AiProviderConfigManager.mjs'
import OpenAiAdapter from './providers/OpenAiAdapter.mjs'
import AnthropicAdapter from './providers/AnthropicAdapter.mjs'
import { adapterNameForType } from './providers/ProviderTypes.mjs'

const ADAPTERS = { openai: OpenAiAdapter, anthropic: AnthropicAdapter }

function _build(config, source) {
  const Adapter = ADAPTERS[adapterNameForType(config.type)]
  const adapter = new Adapter({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: Settings.aiAssist.requestTimeoutMs,
  })
  let host = ''
  try {
    host = new URL(config.baseUrl).host
  } catch {
    host = config.baseUrl
  }
  // The descriptor is safe to send to the client; it carries no key.
  return { adapter, descriptor: { type: config.type, host, model: config.model }, source }
}

/**
 * @param {string} userId
 * @returns {Promise<{adapter: object, descriptor: {type: string, host: string, model: string}, source: 'user'|'default'} | null>}
 */
export async function resolveProvider(userId) {
  if (Settings.aiAssist.allowUserProviders) {
    const userConfig = await AiProviderConfigManager.promises.getActiveWithKey(userId)
    if (userConfig) return _build(userConfig, 'user')
  }
  const fallback = Settings.aiAssist.defaultProvider
  if (fallback && fallback.type && fallback.model) return _build(fallback, 'default')
  return null
}
```

- [x] **Step 4: Run the resolver test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiProviderResolver.test.mjs`
Expected: PASS (7 tests).

- [x] **Step 5: Implement `AiConsentManager.mjs`**

```js
import { AiUserConsent } from './models/AiAssistModels.mjs'

async function hasConsented(userId) {
  return Boolean(await AiUserConsent.findOne({ user_id: userId }).lean())
}

async function recordConsent(userId, providerFingerprint) {
  await AiUserConsent.updateOne(
    { user_id: userId },
    { $set: { user_id: userId, consentedAt: new Date(), providerFingerprint } },
    { upsert: true }
  )
}

export default { promises: { hasConsented, recordConsent } }
```

- [x] **Step 6: Write the failing rate-limiter test**

Create `modules/ai-assist/test/unit/src/AiUsageRateLimiter.test.mjs`:

```js
import { expect } from 'chai'
import esmock from 'esmock'

async function load(rateLimitPerDay) {
  return esmock('../../../app/src/AiUsageRateLimiter.mjs', {
    '@overleaf/settings': { aiAssist: { rateLimitPerDay } },
  })
}

describe('AiUsageRateLimiter', function () {
  it('uses its own feature name, not the SaaS one', async function () {
    const { default: limiter } = await load(100)
    expect(limiter.featureName).to.equal('aiAssistUsage')
  })

  it('reports the configured allowance', async function () {
    const { default: limiter } = await load(25)
    expect(await limiter._getAllowance('000000000000000000000001')).to.equal(25)
  })
})
```

- [x] **Step 7: Implement `AiUsageRateLimiter.mjs`**

```js
import Settings from '@overleaf/settings'
import FeatureUsageRateLimiter from '../../../../app/src/infrastructure/rate-limiters/FeatureUsageRateLimiter.mjs'

// Deliberately not extending AiFeatureUsageRateLimiter: that class is coupled to
// Writefull, split tests, and subscription add-ons, none of which exist in CE.
class AiUsageRateLimiter extends FeatureUsageRateLimiter {
  constructor() {
    super('aiAssistUsage')
  }

  /**
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async _getAllowance(userId) {
    return Settings.aiAssist.rateLimitPerDay
  }
}

export default new AiUsageRateLimiter()
```

- [x] **Step 8: Run both tests**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiProviderResolver.test.mjs modules/ai-assist/test/unit/src/AiUsageRateLimiter.test.mjs`
Expected: PASS (9 tests).

- [x] **Step 9: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add provider resolver, consent manager and usage limiter"
```

---

### Task 8: Error assistant prompt builder

**Files:**
- Create: `modules/ai-assist/app/src/ErrorAssistantPrompt.mjs`
- Test: `modules/ai-assist/test/unit/src/ErrorAssistantPrompt.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_CONTEXT_LINES` (number, 40); `buildErrorAssistantMessages({ fileName, lines, logEntry, contextRange }) -> { system, messages, contextRange }` where the returned `contextRange` is the clamped `{ from, to }` (1-indexed, inclusive) actually sent.

- [x] **Step 1: Write the failing test**

Create `modules/ai-assist/test/unit/src/ErrorAssistantPrompt.test.mjs`:

```js
import { expect } from 'chai'
import {
  buildErrorAssistantMessages,
  MAX_CONTEXT_LINES,
} from '../../../app/src/ErrorAssistantPrompt.mjs'

const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
const logEntry = { message: 'Undefined control sequence', raw: '! Undefined control sequence.', level: 'error', line: 100 }

describe('buildErrorAssistantMessages', function () {
  it('clamps an oversized requested range to MAX_CONTEXT_LINES', function () {
    const { contextRange } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines, logEntry, contextRange: { from: 1, to: 200 },
    })
    expect(contextRange.to - contextRange.from + 1).to.be.at.most(MAX_CONTEXT_LINES)
  })

  it('centres the clamped range on the error line', function () {
    const { contextRange } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines, logEntry, contextRange: { from: 1, to: 200 },
    })
    expect(contextRange.from).to.be.at.most(100)
    expect(contextRange.to).to.be.at.least(100)
  })

  it('does not run past the start or end of the file', function () {
    const short = ['a', 'b', 'c']
    const { contextRange } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines: short, logEntry: { ...logEntry, line: 1 }, contextRange: { from: 1, to: 3 },
    })
    expect(contextRange.from).to.equal(1)
    expect(contextRange.to).to.equal(3)
  })

  it('includes the file name, the error text, and numbered source lines', function () {
    const { messages } = buildErrorAssistantMessages({
      fileName: 'chapters/intro.tex', lines, logEntry, contextRange: { from: 98, to: 102 },
    })
    const content = messages[0].content
    expect(content).to.include('chapters/intro.tex')
    expect(content).to.include('Undefined control sequence')
    expect(content).to.include('100: line 100')
  })

  it('produces exactly one user message', function () {
    const { messages } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines, logEntry, contextRange: { from: 98, to: 102 },
    })
    expect(messages).to.have.length(1)
    expect(messages[0].role).to.equal('user')
  })

  it('states the fix-block output contract in the system prompt', function () {
    const { system } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines, logEntry, contextRange: { from: 98, to: 102 },
    })
    expect(system).to.include('<fix')
    expect(system).to.include('from=')
    expect(system).to.include('to=')
  })

  it('handles a missing error line by centring on the file start', function () {
    const { contextRange } = buildErrorAssistantMessages({
      fileName: 'main.tex', lines, logEntry: { ...logEntry, line: null }, contextRange: null,
    })
    expect(contextRange.from).to.equal(1)
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/ErrorAssistantPrompt.test.mjs`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `ErrorAssistantPrompt.mjs`**

```js
export const MAX_CONTEXT_LINES = 40

const SYSTEM_PROMPT = `You are an expert LaTeX assistant helping a user fix a compilation error in their document.

Explain the cause of the error in two or three sentences, in plain language.

Then, if and only if you can propose a concrete correction, emit a fix block on its own lines:

<fix from="START_LINE" to="END_LINE">
replacement LaTeX for those lines, inclusive
</fix>

Rules for the fix block:
- START_LINE and END_LINE are 1-indexed line numbers from the numbered source you were given.
- Reproduce the full replacement text for that whole line range, not a diff.
- Emit at most one fix block.
- If you are not confident of a correction, omit the fix block entirely and explain what the user should check.
- Never wrap the fix block in markdown code fences.`

/**
 * @param {{ fileName: string, lines: string[], logEntry: {message: string, raw?: string, level?: string, line: number|null}, contextRange: {from: number, to: number}|null }} input
 * @returns {{ system: string, messages: Array<{role: 'user', content: string}>, contextRange: {from: number, to: number} }}
 */
export function buildErrorAssistantMessages({ fileName, lines, logEntry, contextRange }) {
  const total = lines.length
  const errorLine = Number.isInteger(logEntry.line) && logEntry.line > 0 ? logEntry.line : 1

  // The client's range is a hint only. Clamp it to MAX_CONTEXT_LINES centred on
  // the error so a crafted request cannot exfiltrate a whole document at once.
  let from = contextRange?.from ?? errorLine - Math.floor(MAX_CONTEXT_LINES / 2)
  let to = contextRange?.to ?? errorLine + Math.floor(MAX_CONTEXT_LINES / 2)

  if (to - from + 1 > MAX_CONTEXT_LINES) {
    const half = Math.floor(MAX_CONTEXT_LINES / 2)
    from = errorLine - half
    to = from + MAX_CONTEXT_LINES - 1
  }
  if (from < 1) {
    to += 1 - from
    from = 1
  }
  if (to > total) {
    to = total
    from = Math.max(1, to - MAX_CONTEXT_LINES + 1)
  }

  const numbered = lines
    .slice(from - 1, to)
    .map((text, index) => `${from + index}: ${text}`)
    .join('\n')

  const content = [
    `File: ${fileName}`,
    `Error line: ${errorLine}`,
    `Error: ${logEntry.message}`,
    logEntry.raw ? `Raw log:\n${logEntry.raw}` : null,
    '',
    `Source lines ${from}-${to}:`,
    numbered,
  ]
    .filter(part => part !== null)
    .join('\n')

  return {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    contextRange: { from, to },
  }
}
```

- [x] **Step 4: Run the test and confirm it passes**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/ErrorAssistantPrompt.test.mjs`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add error assistant prompt builder"
```

---

### Task 9: Controller and router

**Files:**
- Create: `modules/ai-assist/app/src/AiAssistController.mjs`
- Modify: `modules/ai-assist/app/src/AiAssistRouter.mjs` (replace the Task 1 placeholder)
- Test: `modules/ai-assist/test/unit/src/AiAssistController.test.mjs`
- Test: `modules/ai-assist/test/unit/src/AiAssistRouter.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 3 and 6-8, plus `AuthenticationController.requireLogin()` and `AuthorizationManager.promises.canUserReadProject` from core, and `DocumentUpdaterHandler`/`ProjectLocator` for document text.
- Produces: routes `GET/POST /ai/providers`, `PUT/DELETE /ai/providers/:configId`, `POST /ai/providers/:configId/activate`, `GET/POST /ai/consent`, `POST /project/:projectId/ai/error-assistant`.

- [x] **Step 1: Write the failing router test**

Create `modules/ai-assist/test/unit/src/AiAssistRouter.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

async function load() {
  return esmock('../../../app/src/AiAssistRouter.mjs', {
    '../../../app/src/AiAssistController.mjs': {
      default: {
        listProviders: sinon.stub(), createProvider: sinon.stub(), updateProvider: sinon.stub(),
        deleteProvider: sinon.stub(), activateProvider: sinon.stub(),
        getConsent: sinon.stub(), postConsent: sinon.stub(), errorAssistant: sinon.stub(),
      },
    },
    '../../../../../app/src/Features/Authentication/AuthenticationController.mjs': {
      default: { requireLogin: () => (req, res, next) => next() },
    },
  })
}

describe('AiAssistRouter', function () {
  it('registers every provider, consent and error-assistant route behind requireLogin', async function () {
    const { default: router } = await load()
    const webRouter = { get: sinon.stub(), post: sinon.stub(), put: sinon.stub(), delete: sinon.stub() }
    router.apply(webRouter)

    const paths = [
      ...webRouter.get.getCalls(), ...webRouter.post.getCalls(),
      ...webRouter.put.getCalls(), ...webRouter.delete.getCalls(),
    ].map(call => call.args[0])

    expect(paths).to.include.members([
      '/ai/providers',
      '/ai/providers/:configId',
      '/ai/providers/:configId/activate',
      '/ai/consent',
      '/project/:projectId/ai/error-assistant',
    ])
    // every route carries middleware plus a handler
    for (const call of webRouter.post.getCalls()) {
      expect(call.args.length).to.be.at.least(3)
    }
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistRouter.test.mjs`
Expected: FAIL — the placeholder registers nothing.

- [x] **Step 3: Implement `AiAssistRouter.mjs`**

```js
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AiAssistController from './AiAssistController.mjs'

export default {
  // Must stay synchronous: no await, no dynamic import.
  apply(webRouter) {
    const requireLogin = AuthenticationController.requireLogin()

    webRouter.get('/ai/providers', requireLogin, AiAssistController.listProviders)
    webRouter.post('/ai/providers', requireLogin, AiAssistController.createProvider)
    webRouter.put('/ai/providers/:configId', requireLogin, AiAssistController.updateProvider)
    webRouter.delete('/ai/providers/:configId', requireLogin, AiAssistController.deleteProvider)
    webRouter.post('/ai/providers/:configId/activate', requireLogin, AiAssistController.activateProvider)

    webRouter.get('/ai/consent', requireLogin, AiAssistController.getConsent)
    webRouter.post('/ai/consent', requireLogin, AiAssistController.postConsent)

    webRouter.post(
      '/project/:projectId/ai/error-assistant',
      requireLogin,
      AiAssistController.errorAssistant
    )
  },
}
```

- [x] **Step 4: Write the failing controller test**

Create `modules/ai-assist/test/unit/src/AiAssistController.test.mjs`:

```js
import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

const USER_ID = '000000000000000000000001'
const PROJECT_ID = '000000000000000000000002'

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    set(key, value) { this.headers[key] = value; return this },
    setHeader(key, value) { this.headers[key] = value; return this },
    write(chunk) { this.chunks.push(chunk); return true },
    end() { this.ended = true; return this },
    flushHeaders() { this.flushed = true },
    on() {},
  }
  return res
}

function makeReq(overrides = {}) {
  return {
    user: { _id: USER_ID },
    params: { projectId: PROJECT_ID },
    body: {},
    on: sinon.stub(),
    ...overrides,
  }
}

async function load(overrides = {}) {
  return esmock('../../../app/src/AiAssistController.mjs', {
    '../../../app/src/AiProviderConfigManager.mjs': {
      default: { promises: {
        listConfigs: sinon.stub().resolves([]),
        createConfig: sinon.stub().resolves({ _id: 'a' }),
        updateConfig: sinon.stub().resolves(),
        deleteConfig: sinon.stub().resolves(),
        setActive: sinon.stub().resolves(),
      } },
      InvalidProviderConfigError: class extends Error {},
    },
    '../../../app/src/AiConsentManager.mjs': {
      default: { promises: {
        hasConsented: sinon.stub().resolves(true),
        recordConsent: sinon.stub().resolves(),
      } },
    },
    '../../../app/src/AiProviderResolver.mjs': {
      resolveProvider: sinon.stub().resolves({
        adapter: { async *streamChat() { yield { type: 'text', text: 'hi' }; yield { type: 'done', usage: {} } } },
        descriptor: { type: 'openai', host: 'api.openai.com', model: 'gpt-4o-mini' },
        source: 'user',
      }),
    },
    '../../../app/src/AiUsageRateLimiter.mjs': {
      default: { useFeature: sinon.stub().resolves(true) },
    },
    '../../../app/src/ErrorAssistantPrompt.mjs': {
      buildErrorAssistantMessages: () => ({ system: 's', messages: [], contextRange: { from: 1, to: 5 } }),
    },
    '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs': {
      default: { promises: { canUserReadProject: sinon.stub().resolves(true) } },
    },
    '../../../app/src/DocumentContext.mjs': {
      getDocumentLines: sinon.stub().resolves({ fileName: 'main.tex', lines: ['a', 'b', 'c'] }),
    },
    '@overleaf/settings': { aiAssist: { allowUserProviders: true, maxOutputTokens: 1024 } },
    '@overleaf/logger': { default: { error: sinon.stub(), warn: sinon.stub(), info: sinon.stub() } },
    ...overrides,
  })
}

describe('AiAssistController', function () {
  describe('errorAssistant', function () {
    it('sets SSE headers including X-Accel-Buffering', async function () {
      const { default: Controller } = await load()
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      expect(res.headers['Content-Type']).to.equal('text/event-stream')
      expect(res.headers['Cache-Control']).to.equal('no-cache')
      expect(res.headers['X-Accel-Buffering']).to.equal('no')
    })

    it('streams delta frames then a done frame', async function () {
      const { default: Controller } = await load()
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      const written = res.chunks.join('')
      expect(written).to.include('"type":"delta"')
      expect(written).to.include('"type":"done"')
      expect(res.ended).to.be.true
    })

    it('rejects a user without project read access', async function () {
      const { default: Controller } = await load({
        '../../../../../app/src/Features/Authorization/AuthorizationManager.mjs': {
          default: { promises: { canUserReadProject: sinon.stub().resolves(false) } },
        },
      })
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      expect(res.statusCode).to.equal(403)
    })

    it('rejects when consent has not been recorded', async function () {
      const { default: Controller } = await load({
        '../../../app/src/AiConsentManager.mjs': {
          default: { promises: { hasConsented: sinon.stub().resolves(false), recordConsent: sinon.stub() } },
        },
      })
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      expect(res.statusCode).to.equal(428)
      expect(res.body.code).to.equal('consentRequired')
    })

    it('rejects when the quota is exhausted', async function () {
      const { default: Controller } = await load({
        '../../../app/src/AiUsageRateLimiter.mjs': { default: { useFeature: sinon.stub().resolves(false) } },
      })
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      expect(res.statusCode).to.equal(429)
    })

    it('reports when no provider is configured', async function () {
      const { default: Controller } = await load({
        '../../../app/src/AiProviderResolver.mjs': { resolveProvider: sinon.stub().resolves(null) },
      })
      const res = makeRes()
      await Controller.errorAssistant(makeReq({ body: { docId: 'd', logEntry: { message: 'e', line: 2 } } }), res)
      expect(res.statusCode).to.equal(409)
      expect(res.body.code).to.equal('noProvider')
    })
  })

  describe('provider config endpoints', function () {
    it('rejects writes when allowUserProviders is false', async function () {
      const { default: Controller } = await load({
        '@overleaf/settings': { aiAssist: { allowUserProviders: false, maxOutputTokens: 1024 } },
      })
      const res = makeRes()
      await Controller.createProvider(makeReq({ body: { label: 'x', type: 'openai', model: 'm', apiKey: 'k' } }), res)
      expect(res.statusCode).to.equal(403)
    })
  })

  describe('consent endpoints', function () {
    it('records consent with the resolved provider fingerprint', async function () {
      const recordConsent = sinon.stub().resolves()
      const { default: Controller } = await load({
        '../../../app/src/AiConsentManager.mjs': {
          default: { promises: { hasConsented: sinon.stub().resolves(false), recordConsent } },
        },
      })
      const res = makeRes()
      await Controller.postConsent(makeReq(), res)
      expect(recordConsent.firstCall.args[1]).to.equal('openai@api.openai.com')
    })
  })
})
```

- [x] **Step 5: Implement `DocumentContext.mjs`**

Create `modules/ai-assist/app/src/DocumentContext.mjs`:

```js
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectLocator from '../../../../app/src/Features/Project/ProjectLocator.mjs'

/**
 * Reads the current text of a document, preferring the live document-updater
 * copy so the context matches what the user is looking at.
 *
 * @param {string} projectId
 * @param {string} docId
 * @returns {Promise<{ fileName: string, lines: string[] }>}
 */
export async function getDocumentLines(projectId, docId) {
  const { lines } = await DocumentUpdaterHandler.promises.getDocument(
    projectId,
    docId,
    -1
  )
  let fileName = 'main.tex'
  try {
    const { path } = await ProjectLocator.promises.findElement({
      project_id: projectId,
      element_id: docId,
      type: 'doc',
    })
    if (path?.fileSystem) fileName = path.fileSystem.replace(/^\//, '')
  } catch {
    // A missing path is not fatal; the prompt just gets the default name.
  }
  return { fileName, lines: Array.isArray(lines) ? lines : String(lines).split('\n') }
}
```

Verify the `DocumentUpdaterHandler.promises.getDocument` signature against `app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs` before relying on it, and adjust if it differs.

- [x] **Step 6: Implement `AiAssistController.mjs`**

```js
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import AuthorizationManager from '../../../../app/src/Features/Authorization/AuthorizationManager.mjs'
import AiProviderConfigManager, {
  InvalidProviderConfigError,
} from './AiProviderConfigManager.mjs'
import AiConsentManager from './AiConsentManager.mjs'
import AiUsageRateLimiter from './AiUsageRateLimiter.mjs'
import { resolveProvider } from './AiProviderResolver.mjs'
import { buildErrorAssistantMessages } from './ErrorAssistantPrompt.mjs'
import { getDocumentLines } from './DocumentContext.mjs'
import { InvalidBaseUrlError, BlockedEndpointError } from './EndpointGuard.mjs'

function _fingerprint(descriptor) {
  return `${descriptor.type}@${descriptor.host}`
}

function _writeFrame(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function _configError(res, error) {
  if (
    error instanceof InvalidProviderConfigError ||
    error instanceof InvalidBaseUrlError ||
    error instanceof BlockedEndpointError
  ) {
    res.status(400).json({ code: 'invalidConfig', message: error.message })
    return true
  }
  return false
}

function _requireUserProvidersAllowed(res) {
  if (!Settings.aiAssist.allowUserProviders) {
    res.status(403).json({
      code: 'userProvidersDisabled',
      message: 'the administrator has fixed the AI provider for this instance',
    })
    return false
  }
  return true
}

async function listProviders(req, res) {
  const configs = await AiProviderConfigManager.promises.listConfigs(req.user._id)
  res.json({ configs, allowUserProviders: Settings.aiAssist.allowUserProviders })
}

async function createProvider(req, res) {
  if (!_requireUserProvidersAllowed(res)) return
  try {
    const config = await AiProviderConfigManager.promises.createConfig(req.user._id, req.body)
    res.status(201).json(config)
  } catch (error) {
    if (_configError(res, error)) return
    throw error
  }
}

async function updateProvider(req, res) {
  if (!_requireUserProvidersAllowed(res)) return
  try {
    await AiProviderConfigManager.promises.updateConfig(req.user._id, req.params.configId, req.body)
    res.sendStatus(204)
  } catch (error) {
    if (_configError(res, error)) return
    throw error
  }
}

async function deleteProvider(req, res) {
  if (!_requireUserProvidersAllowed(res)) return
  await AiProviderConfigManager.promises.deleteConfig(req.user._id, req.params.configId)
  res.sendStatus(204)
}

async function activateProvider(req, res) {
  if (!_requireUserProvidersAllowed(res)) return
  await AiProviderConfigManager.promises.setActive(req.user._id, req.params.configId)
  res.sendStatus(204)
}

async function getConsent(req, res) {
  const [consented, resolved] = await Promise.all([
    AiConsentManager.promises.hasConsented(req.user._id),
    resolveProvider(req.user._id),
  ])
  res.json({ consented, provider: resolved?.descriptor ?? null })
}

async function postConsent(req, res) {
  const resolved = await resolveProvider(req.user._id)
  await AiConsentManager.promises.recordConsent(
    req.user._id,
    resolved ? _fingerprint(resolved.descriptor) : ''
  )
  res.sendStatus(204)
}

async function errorAssistant(req, res) {
  const userId = req.user._id
  const { projectId } = req.params
  const { docId, logEntry, contextRange } = req.body

  if (!docId || !logEntry?.message) {
    return res.status(400).json({ code: 'badRequest', message: 'docId and logEntry are required' })
  }

  // Authorization is re-derived from the session; the client's docId is never trusted.
  const canRead = await AuthorizationManager.promises.canUserReadProject(userId, projectId, null)
  if (!canRead) {
    return res.status(403).json({ code: 'forbidden', message: 'No read access' })
  }

  if (!(await AiConsentManager.promises.hasConsented(userId))) {
    return res.status(428).json({ code: 'consentRequired', message: 'AI consent is required' })
  }

  const resolved = await resolveProvider(userId)
  if (!resolved) {
    return res.status(409).json({ code: 'noProvider', message: 'No AI provider is configured' })
  }

  if (!(await AiUsageRateLimiter.useFeature(userId, res))) {
    return res.status(429).json({ code: 'quotaExhausted', message: 'AI usage limit reached' })
  }

  const { fileName, lines } = await getDocumentLines(projectId, docId)
  const prompt = buildErrorAssistantMessages({ fileName, lines, logEntry, contextRange })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // Without this nginx buffers the whole response and the feature appears to hang.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  _writeFrame(res, {
    type: 'start',
    provider: resolved.descriptor,
    contextRange: prompt.contextRange,
  })

  try {
    for await (const chunk of resolved.adapter.streamChat({
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: Settings.aiAssist.maxOutputTokens,
      signal: abortController.signal,
    })) {
      if (chunk.type === 'text') _writeFrame(res, { type: 'delta', text: chunk.text })
      else if (chunk.type === 'done') _writeFrame(res, { type: 'done' })
    }
  } catch (error) {
    logger.error({ err: error, projectId }, 'AI error assistant stream failed')
    // Headers are already sent, so the failure travels as a frame, not a status.
    _writeFrame(res, {
      type: 'error',
      code: error.status === 401 || error.status === 403 ? 'providerAuth' : 'providerError',
      message: 'the AI provider could not complete this request',
    })
  } finally {
    res.end()
  }
}

export default {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  activateProvider,
  getConsent,
  postConsent,
  errorAssistant,
}
```

- [x] **Step 7: Run both tests**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/AiAssistController.test.mjs modules/ai-assist/test/unit/src/AiAssistRouter.test.mjs`
Expected: PASS (9 tests).

- [x] **Step 8: Run the whole module suite**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/`
Expected: PASS, no failures.

- [x] **Step 9: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add controller and routes for providers, consent and error assistant"
```

---

### Task 10: Core wiring (slots, meta flag, nginx)

**Files:**
- Modify: `config/settings.defaults.js:1049-1155` (three `overleafModuleImports` slots)
- Modify: `app/views/layout-base.pug:73-77` (add `ol-aiAssistEnabled`)
- Modify: `frontend/js/features/settings/components/linking-section.tsx:47-68`
- Modify: `../../server-ce/nginx/overleaf.conf`
- Test: `modules/ai-assist/test/unit/src/CoreWiring.test.mjs`

**Interfaces:**
- Consumes: component paths created in Tasks 11-12. Create empty placeholder components first so webpack resolves.
- Produces: `getMeta('ol-aiAssistEnabled')` available to the frontend; module components mounted in three slots.

- [x] **Step 1: Create placeholder components so the slot paths resolve**

Create `modules/ai-assist/frontend/js/features/ai-assist/components/ai-providers-widget.tsx`, `suggest-fix-button.tsx`, and `suggest-fix-panel.tsx`, each containing:

```tsx
export default function Placeholder() {
  return null
}
```

These are replaced in Tasks 11 and 12.

- [x] **Step 2: Register the three slots**

In `config/settings.defaults.js`, inside `overleafModuleImports`:

```js
    pdfLogEntryHeaderActionComponents: [
      Path.resolve(
        __dirname,
        '../modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-button.tsx'
      ),
    ],
    pdfLogEntryComponents: [
      Path.resolve(
        __dirname,
        '../modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-panel.tsx'
      ),
    ],
```

and append to the existing `integrationLinkingWidgets` array (which already holds the github-sync widget):

```js
      Path.resolve(
        __dirname,
        '../modules/ai-assist/frontend/js/features/ai-assist/components/ai-providers-widget.tsx'
      ),
```

- [x] **Step 3: Expose the meta flag**

In `app/views/layout-base.pug`, immediately after the `ol-githubSyncEnabled` meta block (lines 73-77), add:

```pug
			meta(
				name='ol-aiAssistEnabled'
				data-type='boolean'
				content=settings.aiAssist && settings.aiAssist.enabled
			)
```

Add `'ol-aiAssistEnabled': boolean` to the `Meta` interface in `frontend/js/utils/meta.ts`, in alphabetical position near `'ol-allInReconfirmNotificationPeriods'`.

- [x] **Step 4: Reveal the Integrations section when AI assist is on**

In `frontend/js/features/settings/components/linking-section.tsx`, add alongside the sibling flags (around line 47):

```tsx
  const aiAssistEnabled = Boolean(getMeta('ol-aiAssistEnabled'))
```

and add `aiAssistEnabled ||` to the `renderSyncSection` disjunction (around line 50). Without this the whole Integrations block stays hidden on a CE instance and the provider widget never renders.

- [x] **Step 5: Disable nginx buffering for the stream**

In `server-ce/nginx/overleaf.conf`, add before the catch-all `location /` block:

```nginx
	# Server-Sent Events for the AI error assistant. The catch-all location
	# below buffers responses, which would hold the whole stream until the
	# model finished — the feature would appear to hang, then complete at once.
	location ~ ^/project/[0-9a-f]+/ai/error-assistant$ {
		proxy_pass http://127.0.0.1:4000;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_buffering off;
		proxy_cache off;
		proxy_read_timeout 10m;
		proxy_send_timeout 10m;
		chunked_transfer_encoding off;
	}
```

- [x] **Step 6: Write a test that pins the wiring**

Create `modules/ai-assist/test/unit/src/CoreWiring.test.mjs`:

```js
import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const WEB_ROOT = path.resolve(import.meta.dirname, '../../../../..')

function read(relative) {
  return fs.readFileSync(path.join(WEB_ROOT, relative), 'utf8')
}

describe('ai-assist core wiring', function () {
  it('registers the module in moduleImportSequence', function () {
    expect(read('config/settings.defaults.js')).to.match(/moduleImportSequence:[\s\S]*'ai-assist'/)
  })

  it('registers all three frontend slots', function () {
    const settings = read('config/settings.defaults.js')
    for (const component of ['suggest-fix-button.tsx', 'suggest-fix-panel.tsx', 'ai-providers-widget.tsx']) {
      expect(settings, component).to.include(component)
    }
  })

  it('exposes ol-aiAssistEnabled', function () {
    expect(read('app/views/layout-base.pug')).to.include('ol-aiAssistEnabled')
    expect(read('frontend/js/utils/meta.ts')).to.include("'ol-aiAssistEnabled'")
  })

  it('includes aiAssistEnabled in renderSyncSection', function () {
    const section = read('frontend/js/features/settings/components/linking-section.tsx')
    expect(section).to.include("getMeta('ol-aiAssistEnabled')")
    expect(section).to.match(/renderSyncSection[\s\S]{0,300}aiAssistEnabled/)
  })

  it('disables nginx buffering for the error-assistant route', function () {
    const conf = fs.readFileSync(path.join(WEB_ROOT, '../../server-ce/nginx/overleaf.conf'), 'utf8')
    expect(conf).to.include('ai/error-assistant')
    expect(conf).to.include('proxy_buffering off')
  })
})
```

- [x] **Step 7: Run it**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/src/CoreWiring.test.mjs`
Expected: PASS (5 tests).

- [x] **Step 8: Commit**

```bash
git add config/settings.defaults.js app/views/layout-base.pug frontend/js/utils/meta.ts frontend/js/features/settings/components/linking-section.tsx ../../server-ce/nginx/overleaf.conf modules/ai-assist
git commit -m "feat(ai-assist): wire module slots, meta flag and nginx streaming"
```

---

### Task 11: Account Settings provider widget

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/ai-providers-widget.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/components/provider-form.tsx`
- Test: `modules/ai-assist/test/frontend/ai-providers-widget.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /ai/providers`, `PUT/DELETE /ai/providers/:configId`, `POST /ai/providers/:configId/activate` (Task 9); `getMeta('ol-aiAssistEnabled')` (Task 10).
- Produces: a widget rendered in the Integrations section.

- [x] **Step 1: Write the failing frontend test**

Create `modules/ai-assist/test/frontend/ai-providers-widget.test.tsx`:

```tsx
import { expect } from 'chai'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fetchMock from 'fetch-mock'
import AiProvidersWidget from '../../frontend/js/features/ai-assist/components/ai-providers-widget'

describe('<AiProvidersWidget/>', function () {
  beforeEach(function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
    window.metaAttributesCache.clear()
  })

  it('renders nothing when the feature is disabled', async function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', false)
    const { container } = render(<AiProvidersWidget />)
    expect(container.textContent).to.equal('')
  })

  it('lists configured providers and marks the active one', async function () {
    fetchMock.get('/ai/providers', {
      allowUserProviders: true,
      configs: [
        { _id: '1', label: 'Work OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true, isActive: true },
        { _id: '2', label: 'Local', type: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', hasApiKey: false, isActive: false },
      ],
    })
    render(<AiProvidersWidget />)
    await screen.findByText('Work OpenAI')
    expect(screen.getByText('Local')).to.exist
    expect(screen.getByTestId('active-badge-1')).to.exist
  })

  it('never renders an API key', async function () {
    fetchMock.get('/ai/providers', {
      allowUserProviders: true,
      configs: [{ _id: '1', label: 'Work', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasApiKey: true, isActive: true }],
    })
    const { container } = render(<AiProvidersWidget />)
    await screen.findByText('Work')
    expect(container.innerHTML).to.not.match(/sk-/)
  })

  it('activates a provider', async function () {
    fetchMock.get('/ai/providers', {
      allowUserProviders: true,
      configs: [{ _id: '2', label: 'Local', type: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', hasApiKey: false, isActive: false }],
    })
    fetchMock.post('/ai/providers/2/activate', 204)
    render(<AiProvidersWidget />)
    await screen.findByText('Local')
    await userEvent.click(screen.getByRole('button', { name: /use this provider/i }))
    await waitFor(() => {
      expect(fetchMock.callHistory.called('/ai/providers/2/activate')).to.be.true
    })
  })

  it('explains when the administrator has fixed the provider', async function () {
    fetchMock.get('/ai/providers', { allowUserProviders: false, configs: [] })
    render(<AiProvidersWidget />)
    await screen.findByText(/administrator/i)
    expect(screen.queryByRole('button', { name: /add provider/i })).to.be.null
  })

  it('surfaces a save error from the server', async function () {
    fetchMock.get('/ai/providers', { allowUserProviders: true, configs: [] })
    fetchMock.post('/ai/providers', { status: 400, body: { code: 'invalidConfig', message: 'a base URL is required for this provider type' } })
    render(<AiProvidersWidget />)
    await userEvent.click(await screen.findByRole('button', { name: /add provider/i }))
    await userEvent.type(screen.getByLabelText(/label/i), 'Broken')
    await userEvent.selectOptions(screen.getByLabelText(/provider type/i), 'openai-compatible')
    await userEvent.type(screen.getByLabelText(/model/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByText(/a base URL is required/i)
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend`
Expected: FAIL — the placeholder renders nothing.

- [x] **Step 3: Implement `provider-form.tsx`**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export type ProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'anthropic-compatible'
  | 'ollama'

export type ProviderConfig = {
  _id: string
  label: string
  type: ProviderType
  baseUrl: string
  model: string
  hasApiKey: boolean
  isActive: boolean
}

const TYPES: { value: ProviderType; label: string; needsBaseUrl: boolean }[] = [
  { value: 'openai', label: 'OpenAI', needsBaseUrl: false },
  { value: 'anthropic', label: 'Anthropic', needsBaseUrl: false },
  { value: 'openai-compatible', label: 'Custom (OpenAI-compatible)', needsBaseUrl: true },
  { value: 'anthropic-compatible', label: 'Custom (Anthropic-compatible)', needsBaseUrl: true },
  { value: 'ollama', label: 'Ollama', needsBaseUrl: false },
]

export default function ProviderForm({
  initial,
  error,
  onSave,
  onCancel,
}: {
  initial?: ProviderConfig
  error?: string | null
  onSave: (values: {
    label: string
    type: ProviderType
    baseUrl: string
    model: string
    apiKey?: string
  }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(initial?.label ?? '')
  const [type, setType] = useState<ProviderType>(initial?.type ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [apiKey, setApiKey] = useState('')

  const needsBaseUrl = TYPES.find(entry => entry.value === type)?.needsBaseUrl

  return (
    <form
      onSubmit={event => {
        event.preventDefault()
        // An absent apiKey means "leave the stored key alone" on edit.
        onSave({ label, type, baseUrl, model, ...(apiKey ? { apiKey } : {}) })
      }}
    >
      <label htmlFor="ai-label">Label</label>
      <input id="ai-label" value={label} onChange={e => setLabel(e.target.value)} required />

      <label htmlFor="ai-type">Provider type</label>
      <select id="ai-type" value={type} onChange={e => setType(e.target.value as ProviderType)}>
        {TYPES.map(entry => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>

      <label htmlFor="ai-base-url">Base URL</label>
      <input
        id="ai-base-url"
        value={baseUrl}
        onChange={e => setBaseUrl(e.target.value)}
        required={needsBaseUrl}
        placeholder={needsBaseUrl ? 'https://your-endpoint.example/v1' : 'Leave blank for the default'}
      />

      <label htmlFor="ai-model">Model</label>
      <input id="ai-model" value={model} onChange={e => setModel(e.target.value)} required />

      <label htmlFor="ai-api-key">API key</label>
      <input
        id="ai-api-key"
        type="password"
        value={apiKey}
        autoComplete="off"
        onChange={e => setApiKey(e.target.value)}
        placeholder={initial?.hasApiKey ? 'Stored — type to replace' : ''}
      />

      {error ? <div role="alert">{error}</div> : null}

      <button type="submit">{t('save')}</button>
      <button type="button" onClick={onCancel}>
        {t('cancel')}
      </button>
    </form>
  )
}
```

- [x] **Step 4: Implement `ai-providers-widget.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import getMeta from '@/utils/meta'
import { getJSON, postJSON, putJSON, deleteJSON } from '@/infrastructure/fetch-json'
import ProviderForm, { ProviderConfig } from './provider-form'

export default function AiProvidersWidget() {
  const enabled = Boolean(getMeta('ol-aiAssistEnabled'))
  const [configs, setConfigs] = useState<ProviderConfig[]>([])
  const [allowUserProviders, setAllowUserProviders] = useState(true)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await getJSON('/ai/providers')
    setConfigs(data.configs)
    setAllowUserProviders(data.allowUserProviders)
  }, [])

  useEffect(() => {
    if (!enabled) return
    refresh().catch(() => setError('Could not load AI providers'))
  }, [enabled, refresh])

  if (!enabled) return null

  const save = async (values: Parameters<typeof ProviderForm>[0] extends never ? never : any) => {
    setError(null)
    try {
      if (editing === 'new') await postJSON('/ai/providers', { body: values })
      else if (editing) await putJSON(`/ai/providers/${editing._id}`, { body: values })
      setEditing(null)
      await refresh()
    } catch (err: any) {
      setError(err?.data?.message ?? 'Could not save this provider')
    }
  }

  return (
    <div className="ai-providers-widget">
      <h3>AI provider</h3>
      {!allowUserProviders ? (
        <p>
          Your administrator has fixed the AI provider for this instance, so it cannot be
          changed here.
        </p>
      ) : (
        <>
          <ul>
            {configs.map(config => (
              <li key={config._id}>
                <span>{config.label}</span>
                <span>
                  {config.type} · {config.model}
                </span>
                {config.isActive ? (
                  <span data-testid={`active-badge-${config._id}`}>Active</span>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      await postJSON(`/ai/providers/${config._id}/activate`)
                      await refresh()
                    }}
                  >
                    Use this provider
                  </button>
                )}
                <button type="button" onClick={() => setEditing(config)}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await deleteJSON(`/ai/providers/${config._id}`)
                    await refresh()
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>

          {editing ? (
            <ProviderForm
              initial={editing === 'new' ? undefined : editing}
              error={error}
              onSave={save}
              onCancel={() => {
                setEditing(null)
                setError(null)
              }}
            />
          ) : (
            <button type="button" onClick={() => setEditing('new')}>
              Add provider
            </button>
          )}
        </>
      )}
    </div>
  )
}
```

Confirm the exact exports of `@/infrastructure/fetch-json` (`getJSON`, `postJSON`, `putJSON`, `deleteJSON`) before relying on them; adjust the import if the names differ.

- [x] **Step 5: Run the test and confirm it passes**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend`
Expected: PASS (6 tests).

- [x] **Step 6: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add AI provider settings widget"
```

---

### Task 12: Suggest-fix button, streaming panel, and apply-fix

**Files:**
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-button.tsx`
- Modify: `modules/ai-assist/frontend/js/features/ai-assist/components/suggest-fix-panel.tsx`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-fix-stream.ts`
- Create: `modules/ai-assist/frontend/js/features/ai-assist/parse-fix-block.ts`
- Test: `modules/ai-assist/test/frontend/parse-fix-block.test.ts`
- Test: `modules/ai-assist/test/frontend/suggest-fix-panel.test.tsx`

**Interfaces:**
- Consumes: `POST /project/:projectId/ai/error-assistant` (Task 9); the `pdfLogEntryHeaderActionComponents` and `pdfLogEntryComponents` slots (Task 10). Slot components receive a `logEntry` prop of type `LogEntry` from `frontend/js/features/pdf-preview/util/types`.
- Produces: `parseFixBlock(text) -> { explanation: string, fix: { from: number, to: number, replacement: string } | null }`; `useFixStream()` returning `{ start, cancel, state }` where `state` is `{ status: 'idle'|'streaming'|'done'|'error', text: string, contextRange: {from,to}|null, errorCode: string|null }`.

- [x] **Step 1: Write the failing parser test**

Create `modules/ai-assist/test/frontend/parse-fix-block.test.ts`:

```ts
import { expect } from 'chai'
import { parseFixBlock } from '../../frontend/js/features/ai-assist/parse-fix-block'

describe('parseFixBlock', function () {
  it('returns the explanation and no fix when no block is present', function () {
    const result = parseFixBlock('You are missing a backslash.')
    expect(result.explanation).to.equal('You are missing a backslash.')
    expect(result.fix).to.be.null
  })

  it('extracts the fix block and its line range', function () {
    const result = parseFixBlock(
      'The command is misspelled.\n<fix from="12" to="13">\n\\begin{itemize}\n\\item a\n</fix>'
    )
    expect(result.explanation).to.equal('The command is misspelled.')
    expect(result.fix).to.deep.equal({
      from: 12,
      to: 13,
      replacement: '\\begin{itemize}\n\\item a',
    })
  })

  it('ignores an unterminated block mid-stream', function () {
    const result = parseFixBlock('Explaining.\n<fix from="1" to="2">\npartial')
    expect(result.fix).to.be.null
    expect(result.explanation).to.equal('Explaining.')
  })

  it('takes only the first block when several are emitted', function () {
    const result = parseFixBlock(
      'x\n<fix from="1" to="1">\na\n</fix>\n<fix from="5" to="5">\nb\n</fix>'
    )
    expect(result.fix?.replacement).to.equal('a')
    expect(result.fix?.from).to.equal(1)
  })

  it('rejects a block with a non-numeric range', function () {
    const result = parseFixBlock('x\n<fix from="a" to="b">\ny\n</fix>')
    expect(result.fix).to.be.null
  })

  it('rejects an inverted range', function () {
    const result = parseFixBlock('x\n<fix from="9" to="2">\ny\n</fix>')
    expect(result.fix).to.be.null
  })
})
```

- [x] **Step 2: Run it and confirm it fails**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/parse-fix-block.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `parse-fix-block.ts`**

```ts
export type ParsedFix = {
  from: number
  to: number
  replacement: string
}

export type ParsedResponse = {
  explanation: string
  fix: ParsedFix | null
}

const FIX_RE = /<fix\s+from="([^"]*)"\s+to="([^"]*)"\s*>\n?([\s\S]*?)\n?<\/fix>/

/**
 * Splits a model response into its explanation and at most one fix block.
 * Called on every streamed delta, so a block that has not finished arriving
 * yet must simply not match.
 */
export function parseFixBlock(text: string): ParsedResponse {
  const match = FIX_RE.exec(text)
  if (!match) {
    // Hide a partially-streamed opening tag from the explanation.
    const openIndex = text.indexOf('<fix')
    return {
      explanation: (openIndex === -1 ? text : text.slice(0, openIndex)).trim(),
      fix: null,
    }
  }

  const from = Number(match[1])
  const to = Number(match[2])
  const explanation = text.slice(0, match.index).trim()

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    return { explanation, fix: null }
  }

  return { explanation, fix: { from, to, replacement: match[3] } }
}
```

- [x] **Step 4: Run the parser test and confirm it passes**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend/parse-fix-block.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Implement `use-fix-stream.ts`**

```ts
import { useCallback, useRef, useState } from 'react'
import { postJSON } from '@/infrastructure/fetch-json'

export type FixStreamState = {
  status: 'idle' | 'streaming' | 'done' | 'error'
  text: string
  contextRange: { from: number; to: number } | null
  errorCode: string | null
}

const INITIAL: FixStreamState = {
  status: 'idle',
  text: '',
  contextRange: null,
  errorCode: null,
}

export function useFixStream() {
  const [state, setState] = useState<FixStreamState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const start = useCallback(
    async (projectId: string, body: Record<string, unknown>) => {
      cancel()
      const controller = new AbortController()
      abortRef.current = controller
      setState({ ...INITIAL, status: 'streaming' })

      let response: Response
      try {
        // EventSource cannot POST, so the stream is read off a fetch body.
        response = await fetch(`/project/${projectId}/ai/error-assistant`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'X-CSRF-Token': (window as any).csrfToken,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch {
        setState(prev => ({ ...prev, status: 'error', errorCode: 'network' }))
        return
      }

      if (!response.ok || !response.body) {
        let code = 'unknown'
        try {
          code = (await response.json()).code ?? 'unknown'
        } catch {
          // a non-JSON error body leaves the generic code in place
        }
        setState(prev => ({ ...prev, status: 'error', errorCode: code }))
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            if (!raw.startsWith('data:')) continue
            let frame: any
            try {
              frame = JSON.parse(raw.slice(5).trim())
            } catch {
              continue
            }
            if (frame.type === 'start') {
              setState(prev => ({ ...prev, contextRange: frame.contextRange }))
            } else if (frame.type === 'delta') {
              setState(prev => ({ ...prev, text: prev.text + frame.text }))
            } else if (frame.type === 'done') {
              setState(prev => ({ ...prev, status: 'done' }))
            } else if (frame.type === 'error') {
              setState(prev => ({ ...prev, status: 'error', errorCode: frame.code }))
            }
          }
        }
      } catch {
        // An abort during read is expected on cancel or unmount.
      } finally {
        abortRef.current = null
        setState(prev =>
          prev.status === 'streaming' ? { ...prev, status: 'done' } : prev
        )
      }
    },
    [cancel]
  )

  return { state, start, cancel }
}
```

Confirm how CSRF tokens are supplied elsewhere in the frontend (search for `X-CSRF-Token` under `frontend/js`) and match that convention exactly.

- [x] **Step 6: Write the failing panel test**

Create `modules/ai-assist/test/frontend/suggest-fix-panel.test.tsx`:

```tsx
import { expect } from 'chai'
import sinon from 'sinon'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SuggestFixPanel from '../../frontend/js/features/ai-assist/components/suggest-fix-panel'

const LOG_ENTRY = {
  id: 'entry-1',
  message: 'Undefined control sequence',
  raw: '! Undefined control sequence.',
  level: 'error',
  file: 'main.tex',
  line: 12,
}

function sseBody(...frames: string[]) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

describe('<SuggestFixPanel/>', function () {
  let fetchStub: sinon.SinonStub

  beforeEach(function () {
    window.metaAttributesCache.set('ol-aiAssistEnabled', true)
    fetchStub = sinon.stub(window, 'fetch')
  })

  afterEach(function () {
    fetchStub.restore()
    window.metaAttributesCache.clear()
  })

  function resolveWith(...frames: string[]) {
    fetchStub.resolves({ ok: true, body: sseBody(...frames) } as any)
  }

  it('renders nothing until the suggest-fix event fires', function () {
    const { container } = render(<SuggestFixPanel logEntry={LOG_ENTRY} />)
    expect(container.textContent).to.equal('')
  })

  it('streams the explanation into the panel', async function () {
    resolveWith(
      'data: {"type":"start","contextRange":{"from":10,"to":14}}\n\n',
      'data: {"type":"delta","text":"You misspelled "}\n\n',
      'data: {"type":"delta","text":"a command."}\n\n',
      'data: {"type":"done"}\n\n'
    )
    render(<SuggestFixPanel logEntry={LOG_ENTRY} />)
    window.dispatchEvent(new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } }))
    await screen.findByText('You misspelled a command.')
  })

  it('offers Apply fix when a fix block arrives', async function () {
    resolveWith(
      'data: {"type":"start","contextRange":{"from":10,"to":14}}\n\n',
      'data: {"type":"delta","text":"Fix it.\\n<fix from=\\"12\\" to=\\"12\\">\\n\\\\item a\\n</fix>"}\n\n',
      'data: {"type":"done"}\n\n'
    )
    render(<SuggestFixPanel logEntry={LOG_ENTRY} />)
    window.dispatchEvent(new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } }))
    await screen.findByRole('button', { name: /apply fix/i })
  })

  it('shows a specific message when the API key is rejected', async function () {
    fetchStub.resolves({ ok: false, status: 200, body: sseBody('data: {"type":"error","code":"providerAuth"}\n\n') } as any)
    render(<SuggestFixPanel logEntry={LOG_ENTRY} />)
    window.dispatchEvent(new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'entry-1' } }))
    await waitFor(() => expect(screen.getByRole('alert')).to.exist)
  })

  it('ignores an event aimed at a different log entry', async function () {
    resolveWith('data: {"type":"done"}\n\n')
    render(<SuggestFixPanel logEntry={LOG_ENTRY} />)
    window.dispatchEvent(new CustomEvent('aiAssist:suggestFix', { detail: { entryId: 'other' } }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetchStub.called).to.be.false
  })
})
```

- [x] **Step 7: Implement `suggest-fix-button.tsx`**

```tsx
import { useCallback } from 'react'
import getMeta from '@/utils/meta'
import OLIconButton from '@/shared/components/ol/ol-icon-button'

export default function SuggestFixButton({ logEntry }: { logEntry?: { id?: string } }) {
  const enabled = Boolean(getMeta('ol-aiAssistEnabled'))

  const onClick = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('aiAssist:suggestFix', { detail: { entryId: logEntry?.id } })
    )
  }, [logEntry?.id])

  if (!enabled || !logEntry?.id) return null

  return (
    <OLIconButton
      // use-log-events.ts:46 clicks this selector when the editor asks for a fix
      data-action="suggest-fix"
      icon="auto_awesome"
      size="sm"
      variant="ghost"
      accessibilityLabel="Suggest fix"
      onClick={onClick}
    />
  )
}
```

Check the actual prop names of `OLIconButton` in `frontend/js/shared/components/ol/ol-icon-button.tsx` and adjust; `data-action="suggest-fix"` must survive onto the rendered `button`.

- [x] **Step 8: Implement `suggest-fix-panel.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import getMeta from '@/utils/meta'
import useEventListener from '@/shared/hooks/use-event-listener'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { useFixStream } from '../hooks/use-fix-stream'
import { parseFixBlock } from '../parse-fix-block'

const ERROR_MESSAGES: Record<string, string> = {
  providerAuth: 'Your AI provider rejected the API key. Check it in Account Settings.',
  providerError: 'The AI provider could not complete this request. Try again.',
  consentRequired: 'You need to allow AI features before using this.',
  noProvider: 'No AI provider is configured. Add one in Account Settings.',
  quotaExhausted: 'You have reached your AI usage limit for today.',
  network: 'Could not reach the server.',
  unknown: 'Something went wrong.',
}

export default function SuggestFixPanel({ logEntry }: { logEntry?: any }) {
  const enabled = Boolean(getMeta('ol-aiAssistEnabled'))
  const { projectId } = useProjectContext()
  const { openDocId } = useEditorManagerContext()
  const { state, start, cancel } = useFixStream()
  const [open, setOpen] = useState(false)
  const [sentLines, setSentLines] = useState<string[] | null>(null)

  const { getCurrentDocValue } = useApplyFixTarget()

  const onSuggestFix = useCallback(
    (event: Event) => {
      const { entryId } = (event as CustomEvent<{ entryId?: string }>).detail ?? {}
      if (!logEntry?.id || entryId !== logEntry.id) return
      setOpen(true)
      // Snapshot the document as it is at request time. Drift is measured
      // against exactly what was sent, not against the compile that produced
      // the error, so an edit made while the model is streaming is caught too.
      setSentLines(getCurrentDocValue()?.split('\n') ?? null)
      start(projectId, {
        docId: openDocId,
        logEntry: {
          message: logEntry.message,
          raw: logEntry.raw,
          level: logEntry.level,
          line: logEntry.line,
        },
      })
    },
    [getCurrentDocValue, logEntry, openDocId, projectId, start]
  )

  useEventListener('aiAssist:suggestFix', onSuggestFix)

  useEffect(() => cancel, [cancel])

  const parsed = useMemo(() => parseFixBlock(state.text), [state.text])

  if (!enabled || !open) return null

  return (
    <div className="ai-suggest-fix-panel">
      {parsed.explanation ? <p>{parsed.explanation}</p> : null}

      {state.status === 'streaming' ? (
        <button type="button" onClick={cancel}>
          Stop
        </button>
      ) : null}

      {state.status === 'error' ? (
        <div role="alert">{ERROR_MESSAGES[state.errorCode ?? 'unknown']}</div>
      ) : null}

      {parsed.fix && state.status === 'done' ? (
        <ApplyFix fix={parsed.fix} sentLines={sentLines} />
      ) : null}
    </div>
  )
}
```

Then add the `ApplyFix` child in the same file:

```tsx
function ApplyFix({
  fix,
  sentLines,
}: {
  fix: { from: number; to: number; replacement: string }
  sentLines: string[] | null
}) {
  const { getCurrentDocValue, replaceLineRange } = useApplyFixTarget()
  const [applied, setApplied] = useState(false)

  const currentLines = getCurrentDocValue()?.split('\n') ?? null
  // Refuse to overwrite a range the user has edited since the compile that
  // produced this error.
  const drifted =
    !currentLines ||
    !sentLines ||
    sentLines.slice(fix.from - 1, fix.to).join('\n') !==
      currentLines.slice(fix.from - 1, fix.to).join('\n')

  if (applied) return <p>Fix applied.</p>

  return (
    <>
      <pre>{fix.replacement}</pre>
      <button
        type="button"
        disabled={drifted}
        onClick={() => {
          replaceLineRange(fix.from, fix.to, fix.replacement)
          setApplied(true)
        }}
      >
        Apply fix
      </button>
      {drifted ? (
        <p>The document changed since the last compile, so this fix cannot be applied automatically.</p>
      ) : null}
    </>
  )
}
```

`useApplyFixTarget` is the one piece this plan cannot specify exactly, because it depends on the editor's document API. Implement it in `modules/ai-assist/frontend/js/features/ai-assist/hooks/use-apply-fix-target.ts` returning `{ getCurrentDocValue(): string | null, replaceLineRange(from: number, to: number, text: string): void }`.

Locate the CodeMirror view accessor used elsewhere in `frontend/js/features/source-editor` (search for `useCodeMirrorViewContext`), then:

- `getCurrentDocValue()` returns `view.state.doc.toString()`, or `null` when no view is mounted.
- `replaceLineRange(from, to, text)` is a single CM6 dispatch converting the 1-indexed inclusive line range to offsets: `view.dispatch({ changes: { from: view.state.doc.line(from).from, to: view.state.doc.line(to).to, insert: text } })`. Guard against `from`/`to` exceeding `view.state.doc.lines` and return without dispatching if so.

Write a unit test for this hook against a real `EditorState`/`EditorView` before wiring it in.

- [x] **Step 9: Run the frontend tests**

Run: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend`
Expected: PASS (all panel, parser, and widget tests).

- [x] **Step 10: Commit**

```bash
git add modules/ai-assist
git commit -m "feat(ai-assist): add suggest-fix button, streaming panel and apply-fix"
```

---

### Task 13: Acceptance tests and the default-off guarantee

**Files:**
- Create: `modules/ai-assist/test/acceptance/src/AiAssistTests.mjs`
- Create: `modules/ai-assist/test/acceptance/src/Init.mjs`
- Create: `modules/ai-assist/test/acceptance/config/settings.test.defaults.js`

**Interfaces:**
- Consumes: every route from Task 9.
- Produces: no application code.

Model these on `modules/github-sync/test/acceptance/src/GithubSyncTests.mjs` and its `Init.mjs`; read both first and mirror their bootstrap exactly.

- [x] **Step 1: Write the disabled-instance tests**

In `AiAssistTests.mjs`, with `AI_ASSIST_ENABLED` unset:

```js
describe('ai-assist disabled (default)', function () {
  it('does not expose the provider list', async function () {
    const { response } = await UserHelper.request('GET', '/ai/providers')
    expect(response.statusCode).to.equal(404)
  })

  it('does not expose the error assistant', async function () {
    const { response } = await UserHelper.request(
      'POST', `/project/${projectId}/ai/error-assistant`, { json: { docId, logEntry: { message: 'x', line: 1 } } }
    )
    expect(response.statusCode).to.equal(404)
  })

  it('does not expose the consent endpoint', async function () {
    const { response } = await UserHelper.request('GET', '/ai/consent')
    expect(response.statusCode).to.equal(404)
  })
})
```

- [x] **Step 2: Write the enabled-instance gate tests**

With `AI_ASSIST_ENABLED=true`, `AI_ASSIST_TOKEN_SECRET` set, and no default provider:

```js
describe('ai-assist enabled', function () {
  it('requires login for every route', async function () {
    for (const [method, path] of [['GET', '/ai/providers'], ['GET', '/ai/consent']]) {
      const { response } = await AnonymousUserHelper.request(method, path)
      expect(response.statusCode).to.be.oneOf([302, 401])
    }
  })

  it('rejects a request for a project the user cannot read', async function () {
    const { response } = await otherUser.request(
      'POST', `/project/${projectId}/ai/error-assistant`, { json: { docId, logEntry: { message: 'x', line: 1 } } }
    )
    expect(response.statusCode).to.equal(403)
  })

  it('requires consent before streaming', async function () {
    const { response } = await user.request(
      'POST', `/project/${projectId}/ai/error-assistant`, { json: { docId, logEntry: { message: 'x', line: 1 } } }
    )
    expect(response.statusCode).to.equal(428)
    expect(response.body.code).to.equal('consentRequired')
  })

  it('reports noProvider once consent is given but nothing is configured', async function () {
    await user.request('POST', '/ai/consent')
    const { response } = await user.request(
      'POST', `/project/${projectId}/ai/error-assistant`, { json: { docId, logEntry: { message: 'x', line: 1 } } }
    )
    expect(response.statusCode).to.equal(409)
    expect(response.body.code).to.equal('noProvider')
  })

  it("never returns another user's provider configs", async function () {
    await user.request('POST', '/ai/providers', {
      json: { label: 'Mine', type: 'ollama', model: 'llama3.1' },
    })
    const { body } = await otherUser.request('GET', '/ai/providers')
    expect(body.configs).to.have.length(0)
  })

  it('never returns an API key', async function () {
    await user.request('POST', '/ai/providers', {
      json: { label: 'Keyed', type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-should-not-leak' },
    })
    const { body } = await user.request('GET', '/ai/providers')
    expect(JSON.stringify(body)).to.not.include('sk-should-not-leak')
    expect(body.configs.every(c => c.hasApiKey !== undefined)).to.be.true
  })
})
```

- [x] **Step 3: Run the acceptance suite**

Acceptance tests are Docker-based. Run them the same way `modules/github-sync` acceptance tests are run in this repo, and if the Docker environment is unavailable in your sandbox, say so explicitly and hand the run to the user rather than reporting the suite as passing.

- [x] **Step 4: Run the full module unit suite one final time**

Run: `XDG_DATA_HOME="$TMPDIR/xdg" ../../node_modules/.bin/vitest run modules/ai-assist/test/unit/`
Then: `NODE_ENV=test TZ=GMT ../../node_modules/.bin/mocha --recursive --timeout 5000 --exit --extension js,jsx,mjs,ts,tsx --require test/frontend/bootstrap.js modules/ai-assist/test/frontend`
Expected: both PASS.

- [x] **Step 5: Commit**

```bash
git add modules/ai-assist
git commit -m "test(ai-assist): add acceptance tests and default-off guarantee"
```

---

## Documentation

- [x] Add `docs/ai-assist/setup.md` covering every `AI_ASSIST_*` variable from the Global Constraints, a worked Ollama example, a worked OpenAI example, and an explicit warning that `AI_ASSIST_ALLOW_PRIVATE_ENDPOINTS=true` permits requests to hosts inside the deployment's network and should only be set when a local model endpoint is genuinely needed.
- [x] Commit: `docs(ai-assist): document configuration and security trade-offs`

## Self-Review Notes

Checked against the spec: every section maps to a task — module layout and settings (1), models (2), SSRF (3), adapters (4-5), credential store (6), resolution/consent/quota (7), prompt (8), request flow and SSE (9), core wiring including nginx (10), settings UI (11), log-pane UI and apply-fix drift (12), default-off guarantee and authorization gates (13).

Four points name an existing API that the implementer must confirm against the real source rather than trust from this plan, because inventing a signature would be worse than flagging it. Each is called out inline at the step that uses it:

| API | Task, step |
|---|---|
| `DocumentUpdaterHandler.promises.getDocument` signature | Task 9, Step 5 |
| `@/infrastructure/fetch-json` export names | Task 11, Step 4 |
| `OLIconButton` props, and that `data-action` reaches the DOM | Task 12, Step 7 |
| The CSRF-token convention used by `fetch` callers | Task 12, Step 5 |

`data-action="suggest-fix"` reaching the rendered `button` is load-bearing, not cosmetic: `use-log-events.ts:46` finds the button by that exact selector when the editor asks for a fix. If it does not survive onto the DOM node, the editor-initiated path silently does nothing while the manual click still works — verify it with a test assertion, not by eye.
