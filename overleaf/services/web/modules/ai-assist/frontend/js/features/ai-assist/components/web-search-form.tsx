import { Fragment, useCallback, useMemo, useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import DropdownSetting from '@/features/ide-settings/components/dropdown-setting'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import Notification from '@/shared/components/notification'
import { SiteIcon } from './agent/site-icon'
import {
  ListSetting,
  ProviderCard,
  SettingsGroup,
  TextSetting,
  WEB_SEARCH_LABELS,
  WEB_SEARCH_LINKS,
  WEB_SEARCH_NOTES,
} from './web-search-settings'
import WebsearchapiOptions, {
  draftFromWebsearchapi,
  websearchapiOptionsFromDraft,
} from './websearchapi-options'
import TavilyOptions, {
  draftFromTavily,
  tavilyOptionsFromDraft,
} from './tavily-options'
import FirecrawlOptions, {
  draftFromFirecrawl,
  firecrawlOptionsFromDraft,
} from './firecrawl-options'
import JinaOptions, {
  draftFromJina,
  jinaOptionsFromDraft,
} from './jina-options'
import LangsearchOptions, {
  draftFromLangsearch,
  langsearchOptionsFromDraft,
} from './langsearch-options'
import ExaOptions, { draftFromExa, exaOptionsFromDraft } from './exa-options'
import McpOptions, { draftFromMcp, mcpOptionsFromDraft } from './mcp-options'
import { testWebSearch } from '../providers/server-client'
import {
  ExaProviderConfig,
  FirecrawlProviderConfig,
  FirecrawlSelfHostedProviderConfig,
  JinaProviderConfig,
  LangsearchProviderConfig,
  McpProviderConfig,
  MultiWebSearchSettings,
  ProviderError,
  SearxngProviderConfig,
  TavilyProviderConfig,
  WEB_SEARCH_DEFAULTS,
  WebSearchPreferences,
  WebSearchPrimaryProvider,
  WebSearchProviderType,
  WebSearchRotationStrategy,
  WebSearchSettings,
  WebSearchSourceMode,
  WebsearchapiProviderConfig,
} from '../providers/types'
import { isServerWebSearchAvailable } from '../provider-store'

export { WEB_SEARCH_LABELS }

const ALL_PROVIDERS: WebSearchProviderType[] = [
  'searxng',
  'ollama',
  'websearchapi',
  'tavily',
  'firecrawl',
  'firecrawlSelfHosted',
  'jina',
  'langsearch',
  'exa',
  'mcp',
]

function plural(count: number, noun: string, nouns = `${noun}s`) {
  return `${count} ${count === 1 ? noun : nouns}`
}

type Probe =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; message: string }
  | { state: 'failed'; message: string }

export default function WebSearchForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: WebSearchSettings
  onSave: (values: MultiWebSearchSettings) => void
  onCancel: () => void
}) {
  const isMulti = initial && 'providers' in initial
  const legacyType =
    !isMulti && initial && 'type' in initial ? initial.type : null
  const serverAvailable = isServerWebSearchAvailable()

  const [sourceMode, setSourceMode] = useState<WebSearchSourceMode>(() => {
    if (
      initial &&
      'sourceMode' in initial &&
      (initial.sourceMode === 'server' || initial.sourceMode === 'custom')
    ) {
      return initial.sourceMode
    }
    return serverAvailable && !initial ? 'server' : 'custom'
  })

  const initialOllama = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.ollama
    : legacyType === 'ollama'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialSearxng: SearxngProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.searxng
    : legacyType === 'searxng'
      ? {
          enabled: true,
          baseUrls: [(initial as any).baseUrl],
        }
      : undefined

  const initialWebsearchapi: WebsearchapiProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.websearchapi
    : legacyType === 'websearchapi'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialTavily: TavilyProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.tavily
    : legacyType === 'tavily'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialFirecrawl: FirecrawlProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.firecrawl
    : legacyType === 'firecrawl'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialFirecrawlSelfHosted:
    | FirecrawlSelfHostedProviderConfig
    | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.firecrawlSelfHosted
    : legacyType === 'firecrawlSelfHosted'
      ? { enabled: true, baseUrls: [(initial as any).baseUrl] }
      : undefined

  const initialJina: JinaProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.jina
    : legacyType === 'jina'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialLangsearch: LangsearchProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.langsearch
    : legacyType === 'langsearch'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialExa: ExaProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.exa
    : legacyType === 'exa'
      ? { enabled: true, apiKeys: [(initial as any).apiKey] }
      : undefined

  const initialMcp: McpProviderConfig | undefined = isMulti
    ? (initial as MultiWebSearchSettings)?.providers?.mcp
    : legacyType === 'mcp'
      ? {
          enabled: true,
          serverUrls: [(initial as any).baseUrl],
          headers: (initial as any).headers,
        }
      : undefined

  const [addedProviders, setAddedProviders] = useState<WebSearchProviderType[]>(
    () => {
      const list: WebSearchProviderType[] = []
      if (
        initialSearxng &&
        (initialSearxng.enabled ||
          (initialSearxng.baseUrls && initialSearxng.baseUrls.length > 0) ||
          legacyType === 'searxng')
      ) {
        list.push('searxng')
      }
      if (
        initialOllama &&
        (initialOllama.enabled ||
          (initialOllama.apiKeys && initialOllama.apiKeys.length > 0) ||
          legacyType === 'ollama')
      ) {
        list.push('ollama')
      }
      if (
        initialWebsearchapi &&
        (initialWebsearchapi.enabled ||
          (initialWebsearchapi.apiKeys &&
            initialWebsearchapi.apiKeys.length > 0) ||
          legacyType === 'websearchapi')
      ) {
        list.push('websearchapi')
      }
      if (
        initialTavily &&
        (initialTavily.enabled ||
          (initialTavily.apiKeys && initialTavily.apiKeys.length > 0) ||
          legacyType === 'tavily')
      ) {
        list.push('tavily')
      }
      if (
        initialFirecrawl &&
        (initialFirecrawl.enabled ||
          (initialFirecrawl.apiKeys && initialFirecrawl.apiKeys.length > 0) ||
          legacyType === 'firecrawl')
      ) {
        list.push('firecrawl')
      }
      if (
        initialFirecrawlSelfHosted &&
        (initialFirecrawlSelfHosted.enabled ||
          (initialFirecrawlSelfHosted.baseUrls &&
            initialFirecrawlSelfHosted.baseUrls.length > 0) ||
          legacyType === 'firecrawlSelfHosted')
      ) {
        list.push('firecrawlSelfHosted')
      }
      if (
        initialJina &&
        (initialJina.enabled ||
          (initialJina.apiKeys && initialJina.apiKeys.length > 0) ||
          legacyType === 'jina')
      ) {
        list.push('jina')
      }
      if (
        initialLangsearch &&
        (initialLangsearch.enabled ||
          (initialLangsearch.apiKeys && initialLangsearch.apiKeys.length > 0) ||
          legacyType === 'langsearch')
      ) {
        list.push('langsearch')
      }
      if (
        initialExa &&
        (initialExa.enabled ||
          (initialExa.apiKeys && initialExa.apiKeys.length > 0) ||
          legacyType === 'exa')
      ) {
        list.push('exa')
      }
      if (
        initialMcp &&
        (initialMcp.enabled ||
          (initialMcp.serverUrls && initialMcp.serverUrls.length > 0) ||
          legacyType === 'mcp')
      ) {
        list.push('mcp')
      }
      return list
    }
  )

  const [expandedProviders, setExpandedProviders] = useState<
    WebSearchProviderType[]
  >([])

  const [isAddingProvider, setIsAddingProvider] = useState(false)
  const [selectedNewProvider, setSelectedNewProvider] = useState<
    WebSearchProviderType | ''
  >('')

  const [rotationStrategy, setRotationStrategy] =
    useState<WebSearchRotationStrategy>(
      (isMulti && (initial as MultiWebSearchSettings).rotationStrategy) ||
        'round-robin'
    )
  const [primaryProvider, setPrimaryProvider] =
    useState<WebSearchPrimaryProvider>(
      (isMulti && (initial as MultiWebSearchSettings).primaryProvider) ||
        (legacyType && ALL_PROVIDERS.includes(legacyType)
          ? legacyType
          : 'searxng')
    )

  const [searxngEnabled, setSearxngEnabled] = useState(
    initialSearxng?.enabled ?? (legacyType === 'searxng' || false)
  )
  const [searxngUrls, setSearxngUrls] = useState<string[]>(
    initialSearxng?.baseUrls && initialSearxng.baseUrls.length > 0
      ? initialSearxng.baseUrls
      : ['']
  )
  const [defaultCategories, setDefaultCategories] = useState(
    initialSearxng?.defaultCategories ?? ''
  )
  const [defaultLanguage, setDefaultLanguage] = useState(
    initialSearxng?.defaultLanguage ?? ''
  )
  const [searxngTimeRange, setSearxngTimeRange] = useState<string>(
    initialSearxng?.timeRange ?? ''
  )
  const [searxngSafeSearch, setSearxngSafeSearch] = useState<string>(
    initialSearxng?.safeSearch === undefined
      ? ''
      : String(initialSearxng.safeSearch)
  )

  const [ollamaEnabled, setOllamaEnabled] = useState(
    initialOllama?.enabled ?? legacyType === 'ollama'
  )
  const [ollamaMaxResults, setOllamaMaxResults] = useState(
    initialOllama && 'maxResults' in initialOllama && initialOllama.maxResults
      ? String(initialOllama.maxResults)
      : ''
  )
  const [ollamaKeys, setOllamaKeys] = useState<string[]>(
    initialOllama?.apiKeys && initialOllama.apiKeys.length > 0
      ? initialOllama.apiKeys
      : ['']
  )

  const [websearchapiEnabled, setWebsearchapiEnabled] = useState(
    initialWebsearchapi?.enabled ?? legacyType === 'websearchapi'
  )
  const [websearchapiKeys, setWebsearchapiKeys] = useState<string[]>(
    initialWebsearchapi?.apiKeys && initialWebsearchapi.apiKeys.length > 0
      ? initialWebsearchapi.apiKeys
      : ['']
  )

  const [websearchapiDraft, setWebsearchapiDraft] = useState(() =>
    draftFromWebsearchapi(initialWebsearchapi)
  )

  const [tavilyEnabled, setTavilyEnabled] = useState(
    initialTavily?.enabled ?? legacyType === 'tavily'
  )
  const [tavilyKeys, setTavilyKeys] = useState<string[]>(
    initialTavily?.apiKeys && initialTavily.apiKeys.length > 0
      ? initialTavily.apiKeys
      : ['']
  )
  const [tavilyDraft, setTavilyDraft] = useState(() =>
    draftFromTavily(initialTavily)
  )

  const [firecrawlEnabled, setFirecrawlEnabled] = useState(
    initialFirecrawl?.enabled ?? legacyType === 'firecrawl'
  )
  const [firecrawlKeys, setFirecrawlKeys] = useState<string[]>(
    initialFirecrawl?.apiKeys && initialFirecrawl.apiKeys.length > 0
      ? initialFirecrawl.apiKeys
      : ['']
  )
  const [firecrawlDraft, setFirecrawlDraft] = useState(() =>
    draftFromFirecrawl(initialFirecrawl)
  )

  const [firecrawlSelfHostedEnabled, setFirecrawlSelfHostedEnabled] = useState(
    initialFirecrawlSelfHosted?.enabled ?? legacyType === 'firecrawlSelfHosted'
  )
  const [firecrawlSelfHostedUrls, setFirecrawlSelfHostedUrls] = useState<
    string[]
  >(
    initialFirecrawlSelfHosted?.baseUrls &&
      initialFirecrawlSelfHosted.baseUrls.length > 0
      ? initialFirecrawlSelfHosted.baseUrls
      : ['']
  )
  const [firecrawlSelfHostedDraft, setFirecrawlSelfHostedDraft] = useState(() =>
    draftFromFirecrawl(initialFirecrawlSelfHosted)
  )

  const [jinaEnabled, setJinaEnabled] = useState(
    initialJina?.enabled ?? legacyType === 'jina'
  )
  const [jinaKeys, setJinaKeys] = useState<string[]>(
    initialJina?.apiKeys && initialJina.apiKeys.length > 0
      ? initialJina.apiKeys
      : ['']
  )
  const [jinaDraft, setJinaDraft] = useState(() => draftFromJina(initialJina))

  const [langsearchEnabled, setLangsearchEnabled] = useState(
    initialLangsearch?.enabled ?? legacyType === 'langsearch'
  )
  const [langsearchKeys, setLangsearchKeys] = useState<string[]>(
    initialLangsearch?.apiKeys && initialLangsearch.apiKeys.length > 0
      ? initialLangsearch.apiKeys
      : ['']
  )
  const [langsearchDraft, setLangsearchDraft] = useState(() =>
    draftFromLangsearch(initialLangsearch)
  )

  const [exaEnabled, setExaEnabled] = useState(
    initialExa?.enabled ?? legacyType === 'exa'
  )
  const [exaKeys, setExaKeys] = useState<string[]>(
    initialExa?.apiKeys && initialExa.apiKeys.length > 0
      ? initialExa.apiKeys
      : ['']
  )
  const [exaDraft, setExaDraft] = useState(() => draftFromExa(initialExa))

  const [mcpEnabled, setMcpEnabled] = useState(
    initialMcp?.enabled ?? legacyType === 'mcp'
  )
  const [mcpDraft, setMcpDraft] = useState(() => draftFromMcp(initialMcp))

  const [probe, setProbe] = useState<Probe>({ state: 'idle' })

  const validSearxngUrls = searxngUrls.map(u => u.trim()).filter(Boolean)
  const validOllamaKeys = ollamaKeys.map(k => k.trim()).filter(Boolean)
  const validWebsearchapiKeys = websearchapiKeys
    .map(k => k.trim())
    .filter(Boolean)

  const validTavilyKeys = tavilyKeys.map(k => k.trim()).filter(Boolean)
  const validFirecrawlKeys = firecrawlKeys.map(k => k.trim()).filter(Boolean)
  const validFirecrawlSelfHostedUrls = firecrawlSelfHostedUrls
    .map(u => u.trim())
    .filter(Boolean)
  const validJinaKeys = jinaKeys.map(k => k.trim()).filter(Boolean)
  const validLangsearchKeys = langsearchKeys.map(k => k.trim()).filter(Boolean)
  const validExaKeys = exaKeys.map(k => k.trim()).filter(Boolean)
  const validMcpUrls = mcpDraft.serverUrls.map(u => u.trim()).filter(Boolean)

  const isProviderValid = useCallback(
    (type: WebSearchProviderType) => {
      switch (type) {
        case 'searxng':
          return searxngEnabled && validSearxngUrls.length > 0
        case 'ollama':
          return ollamaEnabled && validOllamaKeys.length > 0
        case 'websearchapi':
          return websearchapiEnabled && validWebsearchapiKeys.length > 0
        case 'tavily':
          return tavilyEnabled && validTavilyKeys.length > 0
        case 'firecrawl':
          return firecrawlEnabled && validFirecrawlKeys.length > 0
        case 'firecrawlSelfHosted':
          return (
            firecrawlSelfHostedEnabled &&
            validFirecrawlSelfHostedUrls.length > 0
          )
        case 'jina':
          return jinaEnabled && validJinaKeys.length > 0
        case 'langsearch':
          return langsearchEnabled && validLangsearchKeys.length > 0
        case 'exa':
          return exaEnabled && validExaKeys.length > 0
        case 'mcp':
          return mcpEnabled && validMcpUrls.length > 0
        default:
          return false
      }
    },
    [
      searxngEnabled,
      validSearxngUrls.length,
      ollamaEnabled,
      validOllamaKeys.length,
      websearchapiEnabled,
      validWebsearchapiKeys.length,
      tavilyEnabled,
      validTavilyKeys.length,
      firecrawlEnabled,
      validFirecrawlKeys.length,
      firecrawlSelfHostedEnabled,
      validFirecrawlSelfHostedUrls.length,
      jinaEnabled,
      validJinaKeys.length,
      langsearchEnabled,
      validLangsearchKeys.length,
      exaEnabled,
      validExaKeys.length,
      mcpEnabled,
      validMcpUrls.length,
    ]
  )

  const isProviderConfigured = useCallback(
    (type: WebSearchProviderType) => {
      switch (type) {
        case 'searxng':
          return validSearxngUrls.length > 0
        case 'ollama':
          return validOllamaKeys.length > 0
        case 'websearchapi':
          return validWebsearchapiKeys.length > 0
        case 'tavily':
          return validTavilyKeys.length > 0
        case 'firecrawl':
          return validFirecrawlKeys.length > 0
        case 'firecrawlSelfHosted':
          return validFirecrawlSelfHostedUrls.length > 0
        case 'jina':
          return validJinaKeys.length > 0
        case 'langsearch':
          return validLangsearchKeys.length > 0
        case 'exa':
          return validExaKeys.length > 0
        case 'mcp':
          return validMcpUrls.length > 0
        default:
          return false
      }
    },
    [
      validSearxngUrls.length,
      validOllamaKeys.length,
      validWebsearchapiKeys.length,
      validTavilyKeys.length,
      validFirecrawlKeys.length,
      validFirecrawlSelfHostedUrls.length,
      validJinaKeys.length,
      validLangsearchKeys.length,
      validExaKeys.length,
      validMcpUrls.length,
    ]
  )

  const effectiveProviders = useMemo(() => {
    if (
      isAddingProvider &&
      selectedNewProvider &&
      isProviderConfigured(selectedNewProvider) &&
      !addedProviders.includes(selectedNewProvider)
    ) {
      return [...addedProviders, selectedNewProvider]
    }
    return addedProviders
  }, [
    isAddingProvider,
    selectedNewProvider,
    isProviderConfigured,
    addedProviders,
  ])

  const complete =
    sourceMode === 'server' ||
    effectiveProviders.some(type =>
      addedProviders.includes(type)
        ? isProviderValid(type)
        : isProviderConfigured(type)
    )

  const current = useCallback((): MultiWebSearchSettings => {
    if (sourceMode === 'server') {
      return {
        sourceMode: 'server',
        providers: {},
      }
    }

    const providers: MultiWebSearchSettings['providers'] = {}

    if (effectiveProviders.includes('searxng')) {
      providers.searxng = {
        enabled: addedProviders.includes('searxng') ? searxngEnabled : true,
        baseUrls: validSearxngUrls,
        ...(defaultCategories.trim()
          ? { defaultCategories: defaultCategories.trim() }
          : {}),
        ...(defaultLanguage.trim()
          ? { defaultLanguage: defaultLanguage.trim() }
          : {}),
        ...(searxngTimeRange
          ? {
              timeRange: searxngTimeRange as SearxngProviderConfig['timeRange'],
            }
          : {}),
        ...(searxngSafeSearch
          ? {
              safeSearch: Number(
                searxngSafeSearch
              ) as SearxngProviderConfig['safeSearch'],
            }
          : {}),
      }
    }

    if (effectiveProviders.includes('ollama')) {
      providers.ollama = {
        enabled: addedProviders.includes('ollama') ? ollamaEnabled : true,
        apiKeys: validOllamaKeys,
        ...(ollamaMaxResults.trim() &&
        Number.isFinite(Math.trunc(Number(ollamaMaxResults)))
          ? {
              maxResults: Math.min(
                10,
                Math.max(1, Math.trunc(Number(ollamaMaxResults)))
              ),
            }
          : {}),
      }
    }

    if (effectiveProviders.includes('websearchapi')) {
      providers.websearchapi = {
        enabled: addedProviders.includes('websearchapi')
          ? websearchapiEnabled
          : true,
        apiKeys: validWebsearchapiKeys,
        ...websearchapiOptionsFromDraft(websearchapiDraft),
      }
    }

    if (effectiveProviders.includes('tavily')) {
      providers.tavily = {
        enabled: addedProviders.includes('tavily') ? tavilyEnabled : true,
        apiKeys: validTavilyKeys,
        ...tavilyOptionsFromDraft(tavilyDraft),
      }
    }

    if (effectiveProviders.includes('firecrawl')) {
      providers.firecrawl = {
        enabled: addedProviders.includes('firecrawl') ? firecrawlEnabled : true,
        apiKeys: validFirecrawlKeys,
        ...firecrawlOptionsFromDraft(firecrawlDraft, { cloud: true }),
      }
    }

    if (effectiveProviders.includes('firecrawlSelfHosted')) {
      providers.firecrawlSelfHosted = {
        enabled: addedProviders.includes('firecrawlSelfHosted')
          ? firecrawlSelfHostedEnabled
          : true,
        baseUrls: validFirecrawlSelfHostedUrls,
        ...firecrawlOptionsFromDraft(firecrawlSelfHostedDraft, {
          cloud: false,
        }),
      }
    }

    if (effectiveProviders.includes('jina')) {
      providers.jina = {
        enabled: addedProviders.includes('jina') ? jinaEnabled : true,
        apiKeys: validJinaKeys,
        ...jinaOptionsFromDraft(jinaDraft),
      }
    }

    if (effectiveProviders.includes('langsearch')) {
      providers.langsearch = {
        enabled: addedProviders.includes('langsearch')
          ? langsearchEnabled
          : true,
        apiKeys: validLangsearchKeys,
        ...langsearchOptionsFromDraft(langsearchDraft),
      }
    }

    if (effectiveProviders.includes('exa')) {
      providers.exa = {
        enabled: addedProviders.includes('exa') ? exaEnabled : true,
        apiKeys: validExaKeys,
        ...exaOptionsFromDraft(exaDraft),
      }
    }

    if (effectiveProviders.includes('mcp')) {
      providers.mcp = {
        enabled: addedProviders.includes('mcp') ? mcpEnabled : true,
        ...mcpOptionsFromDraft(mcpDraft),
      }
    }

    const effectivePrimary = effectiveProviders.includes(primaryProvider)
      ? primaryProvider
      : effectiveProviders[0] || 'searxng'

    return {
      sourceMode: 'custom',
      providers,
      rotationStrategy,
      primaryProvider: effectivePrimary,
    }
  }, [
    sourceMode,
    effectiveProviders,
    addedProviders,
    searxngEnabled,
    validSearxngUrls,
    defaultCategories,
    defaultLanguage,
    searxngTimeRange,
    searxngSafeSearch,
    ollamaEnabled,
    validOllamaKeys,
    ollamaMaxResults,
    websearchapiEnabled,
    validWebsearchapiKeys,
    websearchapiDraft,
    tavilyEnabled,
    validTavilyKeys,
    tavilyDraft,
    firecrawlEnabled,
    validFirecrawlKeys,
    firecrawlDraft,
    firecrawlSelfHostedEnabled,
    validFirecrawlSelfHostedUrls,
    firecrawlSelfHostedDraft,
    jinaEnabled,
    validJinaKeys,
    jinaDraft,
    langsearchEnabled,
    validLangsearchKeys,
    langsearchDraft,
    exaEnabled,
    validExaKeys,
    exaDraft,
    mcpEnabled,
    mcpDraft,
    primaryProvider,
    rotationStrategy,
  ])

  const onTest = useCallback(async () => {
    setProbe({ state: 'busy' })
    try {
      const payload = current()
      const hasAnyEnabled = Object.values(payload.providers).some(
        p => (p as any)?.enabled
      )
      if (!hasAnyEnabled) {
        for (const p of Object.values(payload.providers)) {
          if (p) (p as any).enabled = true
        }
      }
      const { latencyMs, activeEndpoints, provider } =
        await testWebSearch(payload)
      const details = [
        `Search answered in ${latencyMs} ms`,
        provider ? `via ${provider}` : null,
        typeof activeEndpoints === 'number'
          ? `(${activeEndpoints} endpoint${activeEndpoints === 1 ? '' : 's'} available)`
          : null,
      ]
        .filter(Boolean)
        .join(' ')
      setProbe({ state: 'ok', message: `${details}.` })
    } catch (error: any) {
      setProbe({
        state: 'failed',
        message: (error as ProviderError)?.message || 'The search test failed.',
      })
    }
  }, [current])

  const toggleExpand = useCallback((type: WebSearchProviderType) => {
    setExpandedProviders(prev =>
      prev.includes(type) ? prev.filter(p => p !== type) : [...prev, type]
    )
  }, [])

  const handleToggleProvider = useCallback(
    (type: WebSearchProviderType, enabled: boolean) => {
      setProbe({ state: 'idle' })
      switch (type) {
        case 'searxng':
          setSearxngEnabled(enabled)
          break
        case 'ollama':
          setOllamaEnabled(enabled)
          break
        case 'websearchapi':
          setWebsearchapiEnabled(enabled)
          break
        case 'tavily':
          setTavilyEnabled(enabled)
          break
        case 'firecrawl':
          setFirecrawlEnabled(enabled)
          break
        case 'firecrawlSelfHosted':
          setFirecrawlSelfHostedEnabled(enabled)
          break
        case 'jina':
          setJinaEnabled(enabled)
          break
        case 'langsearch':
          setLangsearchEnabled(enabled)
          break
        case 'exa':
          setExaEnabled(enabled)
          break
        case 'mcp':
          setMcpEnabled(enabled)
          break
      }
    },
    []
  )

  const handleAddProvider = useCallback((type: WebSearchProviderType) => {
    setSourceMode('custom')
    setAddedProviders(prev => (prev.includes(type) ? prev : [...prev, type]))
    setExpandedProviders(prev => (prev.includes(type) ? prev : [...prev, type]))
    switch (type) {
      case 'searxng':
        setSearxngEnabled(true)
        break
      case 'ollama':
        setOllamaEnabled(true)
        break
      case 'websearchapi':
        setWebsearchapiEnabled(true)
        break
      case 'tavily':
        setTavilyEnabled(true)
        break
      case 'firecrawl':
        setFirecrawlEnabled(true)
        break
      case 'firecrawlSelfHosted':
        setFirecrawlSelfHostedEnabled(true)
        break
      case 'jina':
        setJinaEnabled(true)
        break
      case 'langsearch':
        setLangsearchEnabled(true)
        break
      case 'exa':
        setExaEnabled(true)
        break
      case 'mcp':
        setMcpEnabled(true)
        break
    }
    setIsAddingProvider(false)
    setSelectedNewProvider('')
    setProbe({ state: 'idle' })
  }, [])

  const handleRemoveProvider = useCallback(
    (type: WebSearchProviderType) => {
      setAddedProviders(prev => {
        const next = prev.filter(p => p !== type)
        if (primaryProvider === type) {
          setPrimaryProvider(next[0] || 'searxng')
        }
        return next
      })
      setExpandedProviders(prev => prev.filter(p => p !== type))
      setProbe({ state: 'idle' })
      switch (type) {
        case 'searxng':
          setSearxngEnabled(false)
          setSearxngUrls([''])
          setDefaultCategories('')
          setDefaultLanguage('')
          break
        case 'ollama':
          setOllamaEnabled(false)
          setOllamaKeys([''])
          setOllamaMaxResults('')
          break
        case 'websearchapi':
          setWebsearchapiEnabled(false)
          setWebsearchapiKeys([''])
          setWebsearchapiDraft(draftFromWebsearchapi(undefined))
          break
        case 'tavily':
          setTavilyEnabled(false)
          setTavilyKeys([''])
          setTavilyDraft(draftFromTavily(undefined))
          break
        case 'firecrawl':
          setFirecrawlEnabled(false)
          setFirecrawlKeys([''])
          setFirecrawlDraft(draftFromFirecrawl(undefined))
          break
        case 'firecrawlSelfHosted':
          setFirecrawlSelfHostedEnabled(false)
          setFirecrawlSelfHostedUrls([''])
          setFirecrawlSelfHostedDraft(draftFromFirecrawl(undefined))
          break
        case 'jina':
          setJinaEnabled(false)
          setJinaKeys([''])
          setJinaDraft(draftFromJina(undefined))
          break
        case 'langsearch':
          setLangsearchEnabled(false)
          setLangsearchKeys([''])
          setLangsearchDraft(draftFromLangsearch(undefined))
          break
        case 'exa':
          setExaEnabled(false)
          setExaKeys([''])
          setExaDraft(draftFromExa(undefined))
          break
        case 'mcp':
          setMcpEnabled(false)
          setMcpDraft(draftFromMcp(undefined))
          break
      }
    },
    [primaryProvider]
  )

  const getProviderSummary = useCallback(
    (type: WebSearchProviderType): string => {
      switch (type) {
        case 'searxng':
          return validSearxngUrls.length > 0
            ? plural(validSearxngUrls.length, 'instance')
            : 'No instances'
        case 'ollama':
          return validOllamaKeys.length > 0
            ? plural(validOllamaKeys.length, 'API key')
            : 'No API keys'
        case 'websearchapi':
          return validWebsearchapiKeys.length > 0
            ? plural(validWebsearchapiKeys.length, 'API key')
            : 'No API keys'
        case 'tavily':
          return validTavilyKeys.length > 0
            ? plural(validTavilyKeys.length, 'API key')
            : 'No API keys'
        case 'firecrawl':
          return validFirecrawlKeys.length > 0
            ? plural(validFirecrawlKeys.length, 'API key')
            : 'No API keys'
        case 'firecrawlSelfHosted':
          return validFirecrawlSelfHostedUrls.length > 0
            ? plural(validFirecrawlSelfHostedUrls.length, 'instance')
            : 'No instances'
        case 'jina':
          return validJinaKeys.length > 0
            ? plural(validJinaKeys.length, 'API key')
            : 'No API keys'
        case 'langsearch':
          return validLangsearchKeys.length > 0
            ? plural(validLangsearchKeys.length, 'API key')
            : 'No API keys'
        case 'exa':
          return validExaKeys.length > 0
            ? plural(validExaKeys.length, 'API key')
            : 'No API keys'
        case 'mcp':
          return validMcpUrls.length > 0
            ? plural(validMcpUrls.length, 'custom endpoint')
            : 'No custom endpoints'
      }
    },
    [
      validSearxngUrls.length,
      validOllamaKeys.length,
      validWebsearchapiKeys.length,
      validTavilyKeys.length,
      validFirecrawlKeys.length,
      validFirecrawlSelfHostedUrls.length,
      validJinaKeys.length,
      validLangsearchKeys.length,
      validExaKeys.length,
      validMcpUrls.length,
    ]
  )

  const getProviderEnabled = useCallback(
    (type: WebSearchProviderType): boolean => {
      switch (type) {
        case 'searxng':
          return searxngEnabled
        case 'ollama':
          return ollamaEnabled
        case 'websearchapi':
          return websearchapiEnabled
        case 'tavily':
          return tavilyEnabled
        case 'firecrawl':
          return firecrawlEnabled
        case 'firecrawlSelfHosted':
          return firecrawlSelfHostedEnabled
        case 'jina':
          return jinaEnabled
        case 'langsearch':
          return langsearchEnabled
        case 'exa':
          return exaEnabled
        case 'mcp':
          return mcpEnabled
      }
    },
    [
      searxngEnabled,
      ollamaEnabled,
      websearchapiEnabled,
      tavilyEnabled,
      firecrawlEnabled,
      firecrawlSelfHostedEnabled,
      jinaEnabled,
      langsearchEnabled,
      exaEnabled,
      mcpEnabled,
    ]
  )

  const useServerDefault = useCallback(() => {
    onSave({ sourceMode: 'server', providers: {} })
  }, [onSave])

  const renderProviderFields = (type: WebSearchProviderType) => {
    switch (type) {
      case 'searxng':
        return (
          <>
            <SettingsGroup title="Instances">
              <ListSetting
                id="ai-web-search-searxng-url"
                label="Instance URLs"
                description="Each instance must allow JSON output. Searches rotate across them."
                itemLabel="URL"
                values={searxngUrls}
                placeholder="http://searxng:8080"
                onChange={next => {
                  setSearxngUrls(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <SettingsGroup title="Search parameters">
              <TextSetting
                id="ai-web-search-searxng-categories"
                label="Default categories"
                description="Used when the assistant does not pick any, separated by commas."
                placeholder="general, science"
                value={defaultCategories}
                onChange={setDefaultCategories}
                wide
              />
              <TextSetting
                id="ai-web-search-searxng-language"
                label="Default language"
                description="A language code such as en, or all. Used when the assistant does not pick one."
                placeholder="en"
                value={defaultLanguage}
                onChange={setDefaultLanguage}
              />
              <DropdownSetting
                id="ai-web-search-searxng-time-range"
                label="Time range"
                description="Only results from this window, on engines that support it."
                width="wide"
                options={[
                  { value: '', label: 'Any time (default)' },
                  { value: 'day', label: 'Past day' },
                  { value: 'week', label: 'Past week' },
                  { value: 'month', label: 'Past month' },
                  { value: 'year', label: 'Past year' },
                ]}
                value={searxngTimeRange}
                onChange={setSearxngTimeRange}
              />
              <DropdownSetting
                id="ai-web-search-searxng-safe-search"
                label="Safe search"
                description="Filter explicit results, on engines that support it."
                width="wide"
                options={[
                  { value: '', label: 'Instance default' },
                  { value: '0', label: 'Off' },
                  { value: '1', label: 'Moderate' },
                  { value: '2', label: 'Strict' },
                ]}
                value={searxngSafeSearch}
                onChange={setSearxngSafeSearch}
              />
            </SettingsGroup>
          </>
        )
      case 'ollama':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-ollama-key"
                label="API keys"
                description="Free keys from your Ollama account, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={ollamaKeys}
                placeholder="Ollama API key"
                secret
                onChange={next => {
                  setOllamaKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <SettingsGroup title="Search parameters">
              <TextSetting
                id="ai-web-search-ollama-maxResults"
                label="Max results"
                description="Results per search, from 1 to 10. Default 10."
                placeholder="10"
                type="number"
                min={1}
                max={10}
                value={ollamaMaxResults}
                onChange={value => {
                  setOllamaMaxResults(value)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
          </>
        )
      case 'websearchapi':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-websearchapi-key"
                label="API keys"
                description="Keys from your WebSearchAPI.ai dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={websearchapiKeys}
                placeholder="WebSearchAPI.ai API key"
                secret
                onChange={next => {
                  setWebsearchapiKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <WebsearchapiOptions
              draft={websearchapiDraft}
              onChange={next => {
                setWebsearchapiDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'tavily':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-tavily-key"
                label="API keys"
                description="Keys from your Tavily dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={tavilyKeys}
                placeholder="tvly-..."
                secret
                onChange={next => {
                  setTavilyKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
              <TextSetting
                id="ai-web-search-tavily-projectId"
                label="Project ID"
                description="Files usage under this Tavily project."
                placeholder="Optional"
                value={tavilyDraft.projectId}
                onChange={projectId => {
                  setTavilyDraft({ ...tavilyDraft, projectId })
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <TavilyOptions
              draft={tavilyDraft}
              onChange={next => {
                setTavilyDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'firecrawl':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-firecrawl-key"
                label="API keys"
                description="Keys from your Firecrawl dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={firecrawlKeys}
                placeholder="fc-..."
                secret
                onChange={next => {
                  setFirecrawlKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <FirecrawlOptions
              idPrefix="ai-web-search-firecrawl"
              cloud
              draft={firecrawlDraft}
              onChange={next => {
                setFirecrawlDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'firecrawlSelfHosted':
        return (
          <>
            <SettingsGroup title="Instances">
              <ListSetting
                id="ai-web-search-firecrawlSelfHosted-url"
                label="Instance URLs"
                description="The address of each Firecrawl API. Requests rotate across them."
                itemLabel="URL"
                values={firecrawlSelfHostedUrls}
                placeholder="http://firecrawl:3002"
                onChange={next => {
                  setFirecrawlSelfHostedUrls(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <FirecrawlOptions
              idPrefix="ai-web-search-firecrawlSelfHosted"
              cloud={false}
              draft={firecrawlSelfHostedDraft}
              onChange={next => {
                setFirecrawlSelfHostedDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'jina':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-jina-key"
                label="API keys"
                description="Keys from your Jina API dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={jinaKeys}
                placeholder="jina_..."
                secret
                onChange={next => {
                  setJinaKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <JinaOptions
              draft={jinaDraft}
              onChange={next => {
                setJinaDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'langsearch':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-langsearch-key"
                label="API keys"
                description="Keys from your LangSearch dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={langsearchKeys}
                placeholder="ls-..."
                secret
                onChange={next => {
                  setLangsearchKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <LangsearchOptions
              draft={langsearchDraft}
              onChange={next => {
                setLangsearchDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'exa':
        return (
          <>
            <SettingsGroup title="Authentication">
              <ListSetting
                id="ai-web-search-exa-key"
                label="API keys"
                description="Keys from your Exa dashboard, stored in this browser only. Requests rotate across them."
                itemLabel="key"
                values={exaKeys}
                placeholder="Exa API key"
                secret
                onChange={next => {
                  setExaKeys(next)
                  setProbe({ state: 'idle' })
                }}
              />
            </SettingsGroup>
            <ExaOptions
              draft={exaDraft}
              onChange={next => {
                setExaDraft(next)
                setProbe({ state: 'idle' })
              }}
            />
          </>
        )
      case 'mcp':
        return (
          <McpOptions
            value={mcpDraft}
            onChange={next => {
              setMcpDraft(next)
              setProbe({ state: 'idle' })
            }}
          />
        )
    }
  }

  const availableProviders = ALL_PROVIDERS.filter(
    p => !addedProviders.includes(p)
  )

  const renderAddProviderBox = () => {
    if (!isAddingProvider) {
      return (
        <div
          className="web-search-add-box"
          role="button"
          tabIndex={0}
          onClick={() => {
            setIsAddingProvider(true)
            setSelectedNewProvider('')
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setIsAddingProvider(true)
              setSelectedNewProvider('')
            }
          }}
        >
          <div className="d-flex align-items-center justify-content-center gap-1">
            <Plus size={16} aria-hidden="true" />
            <span>Add search provider</span>
          </div>
        </div>
      )
    }

    return (
      <div className="web-search-add-box is-active">
        <OLFormGroup
          controlId="ai-web-search-select-new-provider"
          className="mb-0"
        >
          <div className="d-flex align-items-center justify-content-between mb-2">
            <OLFormLabel className="small fw-semibold mb-0">
              Select provider to add
            </OLFormLabel>
            <OLButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                setIsAddingProvider(false)
                setSelectedNewProvider('')
              }}
            >
              Cancel
            </OLButton>
          </div>
          <OLFormSelect
            size="sm"
            value={selectedNewProvider}
            onChange={e => {
              setSelectedNewProvider(
                e.target.value as WebSearchProviderType | ''
              )
              setProbe({ state: 'idle' })
            }}
          >
            <option value="">Choose a provider to configure...</option>
            {availableProviders.map((p: WebSearchProviderType) => (
              <option key={p} value={p}>
                {WEB_SEARCH_LABELS[p]}
              </option>
            ))}
          </OLFormSelect>
        </OLFormGroup>

        {selectedNewProvider && (
          <div className="web-search-add-box-config mt-3">
            <div className="mb-3">
              <div className="d-flex align-items-center gap-2 mb-1">
                <SiteIcon url={WEB_SEARCH_LINKS[selectedNewProvider].icon} />
                <strong>{WEB_SEARCH_LABELS[selectedNewProvider]}</strong>
              </div>
              <p className="small text-muted mb-1">
                {WEB_SEARCH_NOTES[selectedNewProvider]}
              </p>
              <p className="small mb-0">
                {WEB_SEARCH_LINKS[selectedNewProvider].links.map(
                  ({ label, href }, index) => (
                    <Fragment key={href}>
                      {index > 0 ? ' · ' : null}
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {label}
                      </a>
                    </Fragment>
                  )
                )}
              </p>
            </div>

            {renderProviderFields(selectedNewProvider)}

            <div className="d-flex gap-2 justify-content-end mt-3">
              <OLButton
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => {
                  setIsAddingProvider(false)
                  setSelectedNewProvider('')
                }}
              >
                Cancel
              </OLButton>
              <OLButton
                variant="primary"
                size="sm"
                type="button"
                disabled={!isProviderConfigured(selectedNewProvider)}
                onClick={() => handleAddProvider(selectedNewProvider)}
              >
                Add {WEB_SEARCH_LABELS[selectedNewProvider]}
              </OLButton>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <form
      className="linking-ai-assist-form"
      onSubmit={event => {
        event.preventDefault()
        onSave(current())
      }}
    >
      {serverAvailable && (
        <div className="d-flex flex-column gap-3 mb-3">
          <div className="form-check">
            <input
              className="form-check-input"
              type="radio"
              name="webSearchSourceMode"
              id="source-mode-server"
              checked={sourceMode === 'server'}
              onChange={() => {
                setSourceMode('server')
                setProbe({ state: 'idle' })
              }}
            />
            <label className="form-check-label" htmlFor="source-mode-server">
              <span className="fw-semibold">Server default search</span>
              <span className="d-block small text-muted">
                Uses this server&apos;s pre-configured web search.
              </span>
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="radio"
              name="webSearchSourceMode"
              id="source-mode-custom"
              checked={sourceMode === 'custom'}
              onChange={() => {
                setSourceMode('custom')
                setProbe({ state: 'idle' })
              }}
            />
            <label className="form-check-label" htmlFor="source-mode-custom">
              <span className="fw-semibold">Custom search providers</span>
              <span className="d-block small text-muted">
                Configure your own web search providers.
              </span>
            </label>
          </div>
        </div>
      )}

      {sourceMode === 'custom' && (
        <div className={serverAvailable ? 'border-top pt-3 mt-3' : ''}>
          <div className="mb-3">
            <div className="d-flex align-items-center justify-content-between mb-2">
              <span className="small fw-bold">
                Search providers ({addedProviders.length})
              </span>
            </div>

            {addedProviders.length === 0 ? (
              <p className="small text-muted mb-2">
                No search providers added yet. Use the button below to add a
                provider.
              </p>
            ) : (
              <div className="web-search-added-providers-list mb-2">
                {addedProviders.map((type: WebSearchProviderType) => (
                  <ProviderCard
                    key={type}
                    type={type}
                    enabled={getProviderEnabled(type)}
                    onToggle={enabled => handleToggleProvider(type, enabled)}
                    summary={getProviderSummary(type)}
                    isExpanded={expandedProviders.includes(type)}
                    onToggleExpand={() => toggleExpand(type)}
                    onRemove={() => handleRemoveProvider(type)}
                  >
                    {renderProviderFields(type)}
                  </ProviderCard>
                ))}
              </div>
            )}

            {availableProviders.length > 0 ? (
              renderAddProviderBox()
            ) : (
              <p className="small text-muted mb-2">
                All supported search providers have been added.
              </p>
            )}
          </div>

          {addedProviders.length > 1 && (
            <div className="mb-3">
              <OLFormGroup controlId="ai-web-search-strategy" className="mb-2">
                <OLFormLabel className="small fw-semibold">
                  Rotation strategy
                </OLFormLabel>
                <OLFormSelect
                  size="sm"
                  value={rotationStrategy}
                  onChange={e => {
                    setRotationStrategy(
                      e.target.value as WebSearchRotationStrategy
                    )
                    setProbe({ state: 'idle' })
                  }}
                >
                  <option value="round-robin">
                    Round-robin (Cycle across all active endpoints)
                  </option>
                  <option value="provider-priority">
                    Provider priority (Use primary provider with fallback)
                  </option>
                  <option value="sticky">
                    Sticky (Stick to one endpoint until rate-limited)
                  </option>
                </OLFormSelect>
              </OLFormGroup>

              {rotationStrategy === 'provider-priority' && (
                <OLFormGroup controlId="ai-web-search-primary" className="mb-2">
                  <OLFormLabel className="small fw-semibold">
                    Primary provider
                  </OLFormLabel>
                  <OLFormSelect
                    size="sm"
                    value={primaryProvider}
                    onChange={e => {
                      setPrimaryProvider(
                        e.target.value as WebSearchPrimaryProvider
                      )
                      setProbe({ state: 'idle' })
                    }}
                  >
                    {addedProviders.map((p: WebSearchProviderType) => (
                      <option key={p} value={p}>
                        {WEB_SEARCH_LABELS[p]}
                      </option>
                    ))}
                  </OLFormSelect>
                </OLFormGroup>
              )}
            </div>
          )}

        </div>
      )}

      {probe.state === 'ok' ? (
        <div className="notification-list mt-3">
          <Notification type="success" content={probe.message} />
        </div>
      ) : null}
      {probe.state === 'failed' ? (
        <div className="notification-list mt-3">
          <Notification type="error" content={probe.message} />
        </div>
      ) : null}

      <div className="linking-ai-assist-form-actions mt-3 d-flex gap-2 align-items-center">
        <OLButton variant="primary" type="submit" disabled={!complete}>
          Save
        </OLButton>
        {sourceMode === 'custom' && (
          <OLButton
            variant="secondary"
            type="button"
            onClick={onTest}
            isLoading={probe.state === 'busy'}
            loadingLabel="Testing search…"
            disabled={probe.state === 'busy' || !complete}
          >
            Test search
          </OLButton>
        )}
        <OLButton variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </OLButton>
      </div>
    </form>
  )
}
