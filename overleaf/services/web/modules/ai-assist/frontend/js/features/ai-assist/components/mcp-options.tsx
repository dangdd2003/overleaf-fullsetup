import { useState } from "react";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import Setting from "@/features/ide-settings/components/setting";
import { ListSetting, SettingsGroup } from "./web-search-settings";
import { McpHeader, McpProviderConfig } from "../providers/types";

export interface DraftMcpConfig {
  serverUrls: string[];
  headers: McpHeader[];
}

export function isSensitiveHeaderKey(key: string): boolean {
  return /^(proxy-)?authorization$|api-?key|token|secret|bearer|password/.test(
    key.trim().toLowerCase()
  );
}

export function draftFromMcp(config?: McpProviderConfig): DraftMcpConfig {
  const serverUrls =
    config?.serverUrls && config.serverUrls.length > 0
      ? [...config.serverUrls]
      : [""];
  const headers = (config?.headers ?? []).map((h) => ({ ...h }));
  // A token saved before headers existed becomes its Authorization header,
  // so saving the form does not drop it
  const token = config?.bearerToken?.trim();
  if (
    token &&
    !headers.some((h) => h.key.trim().toLowerCase() === "authorization")
  ) {
    headers.push({
      key: "Authorization",
      value: /^bearer\s/i.test(token) ? token : `Bearer ${token}`,
    });
  }

  return {
    serverUrls,
    headers,
  };
}

export function mcpOptionsFromDraft(
  draft: DraftMcpConfig,
): Pick<McpProviderConfig, "serverUrls" | "headers"> {
  const serverUrls = draft.serverUrls.map((url) => url.trim()).filter(Boolean);

  const headers = draft.headers
    .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
    .filter((h) => h.key && h.value);

  return {
    serverUrls,
    ...(headers.length > 0 ? { headers } : {}),
  };
}

export default function McpOptions({
  value,
  onChange,
}: {
  value: DraftMcpConfig;
  onChange: (value: DraftMcpConfig) => void;
}) {
  const [revealedHeaders, setRevealedHeaders] = useState<
    Record<number, boolean>
  >({});

  const setServerUrls = (serverUrls: string[]) => {
    onChange({ ...value, serverUrls });
  };

  const setHeaders = (headers: McpHeader[]) => {
    onChange({ ...value, headers });
  };

  const addHeader = () => {
    setHeaders([...value.headers, { key: "", value: "" }]);
  };

  const updateHeader = (
    index: number,
    field: "key" | "value",
    newVal: string,
  ) => {
    const next = value.headers.map((header, idx) => {
      if (idx === index) {
        return { ...header, [field]: newVal };
      }
      return header;
    });
    setHeaders(next);
  };

  const removeHeader = (index: number) => {
    setHeaders(value.headers.filter((_, idx) => idx !== index));
    setRevealedHeaders((prev) => {
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k);
        if (idx < index) {
          next[idx] = v;
        } else if (idx > index) {
          next[idx - 1] = v;
        }
      }
      return next;
    });
  };

  return (
    <>
      <SettingsGroup title="Instances">
        <ListSetting
          id="ai-web-search-mcp-url"
          label="Instance URLs"
          description="The address of each search endpoint. Requests rotate across them."
          itemLabel="URL"
          values={value.serverUrls}
          placeholder="http://localhost:8000/search"
          onChange={setServerUrls}
        />
      </SettingsGroup>

      <SettingsGroup title="Authentication">
        <Setting
          controlId="ai-web-search-mcp-headers-add"
          label="Custom headers"
          description="Headers sent with each request, such as Authorization or API keys."
        >
          <OLButton
            variant="secondary"
            size="sm"
            type="button"
            onClick={addHeader}
          >
            Add header
          </OLButton>
        </Setting>

        {value.headers.length > 0 && (
          <div className="web-search-setting-list">
            {value.headers.map((header, idx) => {
              const isSensitive = isSensitiveHeaderKey(header.key);
              const isRevealed = Boolean(revealedHeaders[idx]);
              const inputType =
                !isSensitive || isRevealed ? "text" : "password";

              return (
                <div key={idx} className="d-flex gap-2 align-items-center">
                  <OLFormControl
                    id={`ai-web-search-mcp-header-key-${idx}`}
                    size="sm"
                    type="text"
                    autoComplete="off"
                    className="web-search-setting-input"
                    value={header.key}
                    placeholder="Header name"
                    onChange={(e) => updateHeader(idx, "key", e.target.value)}
                  />
                  <OLFormControl
                    id={`ai-web-search-mcp-header-value-${idx}`}
                    size="sm"
                    type={inputType}
                    autoComplete="off"
                    className="flex-grow-1"
                    value={header.value}
                    placeholder="Value"
                    onChange={(e) => updateHeader(idx, "value", e.target.value)}
                  />
                  {isSensitive && (
                    <OLTooltip
                      id={`ai-web-search-mcp-header-toggle-${idx}`}
                      description={
                        isRevealed ? "Hide header value" : "Show header value"
                      }
                    >
                      <span>
                        <OLIconButton
                          id={`ai-web-search-mcp-header-toggle-btn-${idx}`}
                          variant="secondary"
                          size="sm"
                          type="button"
                          onClick={() =>
                            setRevealedHeaders((prev) => ({
                              ...prev,
                              [idx]: !prev[idx],
                            }))
                          }
                          accessibilityLabel={
                            isRevealed
                              ? `Hide header value for ${header.key || idx + 1}`
                              : `Show header value for ${header.key || idx + 1}`
                          }
                          icon={isRevealed ? "visibility_off" : "visibility"}
                        />
                      </span>
                    </OLTooltip>
                  )}
                  <OLTooltip
                    id={`ai-web-search-mcp-header-remove-${idx}`}
                    description="Remove"
                  >
                    <span>
                      <OLIconButton
                        variant="danger-ghost"
                        size="sm"
                        type="button"
                        onClick={() => removeHeader(idx)}
                        accessibilityLabel={`Remove header ${idx + 1}`}
                        icon="delete"
                      />
                    </span>
                  </OLTooltip>
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
