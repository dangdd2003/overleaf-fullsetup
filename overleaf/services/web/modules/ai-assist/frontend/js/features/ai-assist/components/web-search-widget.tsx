import { useCallback, useEffect, useState } from "react";
import { Globe } from "@phosphor-icons/react";
import OLButton from "@/shared/components/ol/ol-button";
import LinkingStatus from "@/features/settings/components/linking/status";
import WebSearchForm from "./web-search-form";
import {
  MultiWebSearchSettings,
  WebSearchPrimaryProvider,
} from "../providers/types";
import {
  clearWebSearchSettings,
  isServerWebSearchAvailable,
  readWebSearchSettings,
  writeWebSearchSettings,
} from "../provider-store";

function plural(count: number, noun: string, nouns = `${noun}s`) {
  return `${count} ${count === 1 ? noun : nouns}`;
}

type ProviderList = "apiKeys" | "baseUrls" | "serverUrls";
type ProviderConfig = { enabled?: boolean } & Partial<
  Record<ProviderList, string[]>
>;

/** Every provider, in the order its summary line appears. */
const PROVIDER_SPECS: readonly {
  key: WebSearchPrimaryProvider;
  name: string;
  unit: string;
  list: ProviderList;
}[] = [
  { key: "searxng", name: "SearXNG", unit: "instance", list: "baseUrls" },
  { key: "ollama", name: "Ollama", unit: "API key", list: "apiKeys" },
  {
    key: "websearchapi",
    name: "WebSearchAPI.ai",
    unit: "API key",
    list: "apiKeys",
  },
  { key: "tavily", name: "Tavily", unit: "API key", list: "apiKeys" },
  { key: "firecrawl", name: "Firecrawl", unit: "API key", list: "apiKeys" },
  {
    key: "firecrawlSelfHosted",
    name: "Firecrawl self-hosted",
    unit: "instance",
    list: "baseUrls",
  },
  { key: "jina", name: "Jina AI", unit: "API key", list: "apiKeys" },
  { key: "langsearch", name: "LangSearch", unit: "API key", list: "apiKeys" },
  { key: "exa", name: "Exa", unit: "API key", list: "apiKeys" },
  { key: "tinyfish", name: "TinyFish", unit: "API key", list: "apiKeys" },
  { key: "parallel", name: "Parallel", unit: "API key", list: "apiKeys" },
  { key: "mcp", name: "MCP WebSearch", unit: "endpoint", list: "serverUrls" },
];

/**
 * What web search is using: a lead-in line, one bullet per enabled provider,
 * and plain lines for how searches are spread and cached. `configured` is
 * whether at least one provider is set up to answer.
 */
function statusSummary(settings: MultiWebSearchSettings) {
  if (settings.sourceMode === "server") {
    return {
      lead: "Using this server's pre-configured web search.",
      providers: [],
      notes: [],
      configured: true,
    };
  }

  const providers = PROVIDER_SPECS.flatMap((spec) => {
    const config = settings.providers?.[spec.key] as
      | ProviderConfig
      | undefined;
    const count = config?.enabled ? (config[spec.list]?.length ?? 0) : 0;
    return count ? [`${spec.name} (${plural(count, spec.unit)})`] : [];
  });
  const primary =
    PROVIDER_SPECS.find(
      (spec) => spec.key === (settings.primaryProvider ?? "searxng"),
    )?.name ?? "SearXNG";
  const rotation =
    settings.rotationStrategy === "provider-priority"
      ? `Searches go to ${primary} first, then the others.`
      : settings.rotationStrategy === "sticky"
        ? "Searches stay on one endpoint until it is rate-limited."
        : "Searches take turns across all endpoints.";
  return {
    lead: "Using your own web search:",
    providers,
    notes: [rotation],
    configured: providers.length > 0,
  };
}

function WebSearchStatus({
  lead,
  providers,
  notes,
  configured,
}: {
  lead: string;
  providers: string[];
  notes: string[];
  configured: boolean;
}) {
  return (
    <div className="web-search-status">
      <p>
        {configured ? (
          <LinkingStatus status="success" description={lead} />
        ) : (
          <span className="small">{lead}</span>
        )}
      </p>
      <ul className="small">
        {providers.map((provider) => (
          <li key={provider}>{provider}</li>
        ))}
      </ul>
      {notes.map((note) => (
        <p key={note} className="small">
          {note}
        </p>
      ))}
    </div>
  );
}

export default function WebSearchWidget() {
  const [settings, setSettings] = useState<MultiWebSearchSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const serverAvailable = isServerWebSearchAvailable();

  useEffect(() => {
    setSettings(readWebSearchSettings());
    const onSearchChanged = () => setSettings(readWebSearchSettings());
    window.addEventListener("aiAssist:webSearchChanged", onSearchChanged);
    return () => {
      window.removeEventListener("aiAssist:webSearchChanged", onSearchChanged);
    };
  }, []);

  const save = useCallback((values: MultiWebSearchSettings) => {
    writeWebSearchSettings(values);
    setSettings(values);
    setEditing(false);
  }, []);

  const disable = useCallback(() => {
    const disabledSettings: MultiWebSearchSettings = {
      sourceMode: "disabled",
      providers: {},
    };
    writeWebSearchSettings(disabledSettings);
    setSettings(disabledSettings);
  }, []);

  const useServerSearch = useCallback(() => {
    const serverSettings: MultiWebSearchSettings = {
      sourceMode: "server",
      providers: {},
    };
    writeWebSearchSettings(serverSettings);
    setSettings(serverSettings);
  }, []);

  const remove = useCallback(() => {
    clearWebSearchSettings();
    setSettings(readWebSearchSettings());
  }, []);

  const isDisabled = settings?.sourceMode === "disabled";
  const isServer = settings?.sourceMode === "server";
  const isCustom = settings?.sourceMode === "custom";

  return (
    <div
      className="settings-widget-container"
      data-testid="web-search-settings"
    >
      <div className="linking-icon-fixed-position">
        <Globe size={40} aria-hidden="true" />
      </div>
      <div className="description-container">
        <div className="title-row">
          <h4 id="ai-web-search">Web search</h4>
        </div>
        <p className="small">
          Enables the AI assistant to fetch the latest data, information and
          documentation.
        </p>
        {settings && !editing && !isDisabled ? (
          <WebSearchStatus {...statusSummary(settings)} />
        ) : null}
        {editing ? (
          <WebSearchForm
            initial={settings ?? undefined}
            onSave={save}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </div>
      <div>
        {editing ? null : settings && !isDisabled ? (
          <div className="d-flex gap-2">
            <OLButton
              variant="secondary"
              onClick={() => setEditing(true)}
              aria-label={isServer ? "Customize web search" : "Edit web search"}
            >
              {isServer ? "Customize" : "Edit"}
            </OLButton>
            {isCustom ? (
              <OLButton
                variant="secondary"
                onClick={useServerSearch}
                aria-label="Use server default web search"
              >
                Use server default
              </OLButton>
            ) : null}
            <OLButton
              variant="danger-ghost"
              onClick={serverAvailable ? disable : remove}
            >
              {serverAvailable ? "Disable" : "Remove"}
            </OLButton>
          </div>
        ) : isDisabled ? (
          <div className="d-flex gap-2">
            <OLButton
              variant="secondary"
              onClick={
                serverAvailable ? useServerSearch : () => setEditing(true)
              }
              aria-label="Enable web search"
            >
              Enable
            </OLButton>
            <OLButton
              variant="secondary"
              onClick={() => setEditing(true)}
              aria-label="Configure custom web search"
            >
              Customize
            </OLButton>
          </div>
        ) : (
          <OLButton
            variant="secondary"
            onClick={() => setEditing(true)}
            aria-label="Set up web search"
          >
            Set up
          </OLButton>
        )}
      </div>
    </div>
  );
}
