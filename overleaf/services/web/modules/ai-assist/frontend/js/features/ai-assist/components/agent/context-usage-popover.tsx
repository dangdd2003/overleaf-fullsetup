import {
  CSSProperties,
  KeyboardEvent,
  RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CaretDown } from "@phosphor-icons/react";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import { useFloatingBox } from "../../floating/use-floating-box";
import type {
  ContextCategory,
  ContextCategoryId,
  ContextUsageSnapshot,
} from "../../agent/context/context-usage-types";
import {
  CONTEXT_CATEGORY_ORDER,
  formatPercent,
  formatTokens,
} from "../../agent/context/context-usage";
import { SLASH_COMMANDS } from "../../agent/slash-commands/catalog";

export type ContextUsagePopoverProps = {
  show: boolean;
  onHide: () => void;
  /** The meter button the popover is anchored to; focus returns to it on Escape. */
  targetRef: RefObject<HTMLElement | null>;
  snapshot: ContextUsageSnapshot;
};

/**
 * How many of the largest rows get a colour of their own, as Claude Code's
 * panel draws them; every smaller row is grey. Colours are in the stylesheet.
 */
const RANKED_COLOURS = 4;

/** The swatch and bar class of a row: by rank for content, fixed for the rest. */
function colourClass(id: ContextCategoryId, rank: number): string {
  if (id === "reserved") return "ai-assist-context-cat-reserved";
  if (id === "free") return "ai-assist-context-cat-free";
  return rank < RANKED_COLOURS
    ? `ai-assist-context-cat-rank-${rank + 1}`
    : "ai-assist-context-cat-other";
}

/** Rows that always show, even at zero. */
const ALWAYS_SHOWN: ContextCategoryId[] = ["reserved", "free"];

/** Whether the panel was last left open; a per-browser convenience. */
const OPEN_STORAGE_KEY = "ai-assist:context-panel-open";

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage blocked: the fold just isn't remembered
  }
}

/**
 * Claude Code's context panel: a "Context" header that folds everything under
 * it, a summary, a segmented bar, one row per category largest first, the
 * deferred MCP tools, and a collapsible list of the MCP tools. One continuous
 * dashboard: no divider lines, only spacing between the groups.
 *
 * It floats above the meter through the module's floating engine, so it keeps
 * tracking the meter, and the composer around it, while the panel is resized.
 */
export function ContextUsagePopover({
  show,
  onHide,
  targetRef,
  snapshot,
}: ContextUsagePopoverProps) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(readOpen);
  const [mcpOpen, setMcpOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const { refs, floatingStyles } = useFloatingBox({
    open: show,
    placement: "top-end",
    gap: 6,
  });

  // The meter is rendered by the composer, above this component; hand its
  // element to the engine as the anchor.
  useEffect(() => {
    if (show && targetRef.current) {
      refs.setReference(targetRef.current);
    }
  }, [show, refs, targetRef]);

  const setBox = useCallback(
    (node: HTMLDivElement | null) => {
      boxRef.current = node;
      refs.setFloating(node);
    },
    [refs]
  );

  const nameOf = (id: ContextCategoryId): string => {
    switch (id) {
      case "messages":
        return t("ai_assist_context_cat_messages", "Messages");
      case "systemTools":
        return t("ai_assist_context_cat_system_tools", "System tools");
      case "mcpTools":
        return t("ai_assist_context_cat_mcp_tools", "MCP tools");
      case "skills":
        return t("ai_assist_context_cat_skills", "Skills");
      case "systemPrompt":
        return t("ai_assist_context_cat_system_prompt", "System prompt");
      case "memoryFiles":
        return t("ai_assist_context_cat_memory_files", "Memory files");
      case "mcpInstructions":
        return t(
          "ai_assist_context_cat_mcp_instructions",
          "MCP server instructions"
        );
      case "sinceLastUpdate":
        return t("ai_assist_context_cat_since_last_update", "Since last update");
      case "reserved":
        return t("ai_assist_context_cat_reserved", "Autocompact buffer");
      case "free":
        return t("ai_assist_context_cat_free", "Free space");
    }
  };

  const byId = (id: ContextCategoryId): ContextCategory =>
    snapshot.categories.find((category) => category.id === id) ?? {
      id,
      tokens: 0,
      percent: 0,
    };

  // As in Claude Code's panel: content rows largest first, then the reserve and
  // free space. Zero rows are hidden except the reserve and free space; the
  // sort is stable, so ties keep the category order.
  const visible: ContextCategory[] = CONTEXT_CATEGORY_ORDER.map(byId).filter(
    (category) =>
      category.tokens > 0 || ALWAYS_SHOWN.includes(category.id)
  );
  const rows: ContextCategory[] = [
    ...visible
      .filter((category) => !ALWAYS_SHOWN.includes(category.id))
      .sort((a, b) => b.tokens - a.tokens),
    ...visible.filter((category) => ALWAYS_SHOWN.includes(category.id)),
  ];
  const classOf = (category: ContextCategory) =>
    colourClass(category.id, rows.indexOf(category));
  // The bar draws every row but free space; free is the track showing through.
  const segments = rows.filter(
    (category) => category.id !== "free" && category.tokens > 0
  );

  const breakdown = snapshot.breakdown;
  // Sent tools first; the sort is stable, so each group keeps its order.
  const mcpRows = [...(breakdown?.connectorToolDetails ?? [])].sort(
    (a, b) => Number(a.deferred === true) - Number(b.deferred === true)
  );
  const elided = breakdown?.elidedMessages ?? 0;
  const dropped = breakdown?.droppedMessages ?? 0;
  const showFooter = elided > 0 || dropped > 0;
  const percentUsed = `${Math.round(snapshot.percentUsed)}%`;

  // Claude Code's panel has no threshold line; the auto-compact point and
  // whether the count is exact live in the summary's tooltip instead.
  const summaryHint = [
    t(
      "ai_assist_context_auto_compact_at",
      "Auto-compacts at __tokens__ (__percent__)",
      {
        tokens: formatTokens(snapshot.thresholds.autoCompactAt),
        percent: formatPercent(
          (snapshot.thresholds.autoCompactAt / snapshot.contextWindow) * 100
        ),
      }
    ),
    snapshot.exact
      ? t(
          "ai_assist_context_exact_hint",
          "Anchored on the provider's reported usage"
        )
      : t(
          "ai_assist_context_estimated_hint",
          "Estimated from the text; the provider has not reported usage yet"
        ),
  ].join("\n");

  const skillNames = SLASH_COMMANDS.map((command) => `/${command.id}`).join(", ");

  const hintFor = (id: ContextCategoryId): string | undefined =>
    id === "sinceLastUpdate"
      ? t(
          "ai_assist_context_since_last_update_hint",
          "Not yet counted by the provider"
        )
      : undefined;

  /** A row name; Skills and Memory files carry a tooltip on a dotted underline. */
  const renderName = (id: ContextCategoryId) => {
    const label = (
      <span className="ai-assist-context-popover-name">{nameOf(id)}</span>
    );
    if (id === "skills") {
      return (
        <OLTooltip
          id="ai-assist-context-skills-tooltip"
          description={t(
            "ai_assist_context_skills_hint",
            "Slash commands counted in the system prompt: __commands__",
            { commands: skillNames }
          )}
          overlayProps={{ placement: "top" }}
        >
          <span className="ai-assist-context-popover-name is-hint">
            {nameOf(id)}
          </span>
        </OLTooltip>
      );
    }
    if (id === "memoryFiles") {
      return (
        <OLTooltip
          id="ai-assist-context-memory-tooltip"
          description={t(
            "ai_assist_context_memory_files_hint",
            "AGENTS.md"
          )}
          overlayProps={{ placement: "top" }}
        >
          <span className="ai-assist-context-popover-name is-hint">
            {nameOf(id)}
          </span>
        </OLTooltip>
      );
    }
    return label;
  };

  const togglePanel = () => {
    setPanelOpen((open) => {
      writeOpen(!open);
      return !open;
    });
  };

  const close = () => {
    onHide();
    targetRef.current?.focus();
  };

  // Closing on everything but this box and the meter: the meter's own click
  // toggles the panel from the composer, and must not be eaten by root-close.
  useEffect(() => {
    if (!show) return;
    const onMouseDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (boxRef.current?.contains(node) || targetRef.current?.contains(node)) {
        return;
      }
      onHide();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [show, onHide, targetRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  if (!show) {
    return null;
  }

  return (
    <div
      ref={setBox}
      style={floatingStyles}
      className="ai-assist-context-popover"
      role="dialog"
      aria-label={t("ai_assist_context_usage", "Context usage")}
      data-testid="ai-assist-context-popover"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="ai-assist-context-popover-header"
        aria-expanded={panelOpen}
        onClick={togglePanel}
      >
        <span className="ai-assist-context-popover-title">
          <span>{t("ai_assist_context", "Context")}</span>
          <CaretDown
            size={9}
            weight="bold"
            className={`ai-assist-context-popover-caret${panelOpen ? "" : " is-collapsed"}`}
            aria-hidden="true"
          />
        </span>
        {!panelOpen && (
          <span className="ai-assist-context-popover-folded">
            <span className="ai-assist-context-popover-folded-percent">
              {percentUsed}
            </span>
            <span
              className={`ai-assist-context-popover-mini-bar is-${snapshot.state}`}
              aria-hidden="true"
            >
              <span
                style={{ "--ai-ctx-fill": `${Math.min(100, Math.max(0, snapshot.percentUsed))}%` } as CSSProperties}
              />
            </span>
          </span>
        )}
      </button>

      {panelOpen && (
        <div className="ai-assist-context-popover-body">
          <div
            className="ai-assist-context-popover-summary"
            title={summaryHint}
          >
            <span className="ai-assist-context-popover-used">
              {t("ai_assist_context_percent_used", "__percent__ used", {
                percent: percentUsed,
              })}
            </span>
            <span className="ai-assist-context-popover-total">
              {`${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.contextWindow)}`}
            </span>
          </div>

          <div
            className="ai-assist-context-popover-bar"
            role="img"
            aria-label={t(
              "ai_assist_context_grid_label",
              "Context window by category"
            )}
          >
            {segments.map((category) => (
              <span
                key={category.id}
                className={classOf(category)}
                style={{
                  width: `${category.percent}%`,
                  minWidth: 2,
                }}
              />
            ))}
          </div>

          <ul className="ai-assist-context-popover-rows">
            {rows.map((category) => (
              <li
                key={category.id}
                className="ai-assist-context-popover-row"
                title={hintFor(category.id)}
              >
                <span
                  className={`ai-assist-context-popover-swatch ${classOf(category)}`}
                  aria-hidden="true"
                />
                {renderName(category.id)}
                <span className="ai-assist-context-popover-tokens">
                  {formatTokens(category.tokens)}
                </span>
                <span className="ai-assist-context-popover-percent">
                  {formatPercent(category.percent)}
                </span>
              </li>
            ))}
          </ul>

          {snapshot.deferred.length > 0 && (
            <ul className="ai-assist-context-popover-rows is-deferred">
              {snapshot.deferred.map((deferred) => (
                <li key={deferred.id} className="ai-assist-context-popover-row">
                  <span
                    className="ai-assist-context-popover-swatch ai-assist-context-cat-deferred"
                    aria-hidden="true"
                  />
                  <span className="ai-assist-context-popover-name">
                    {t(
                      "ai_assist_context_deferred_mcp_tools",
                      "MCP tools (deferred)"
                    )}
                  </span>
                  <span className="ai-assist-context-popover-tokens">
                    {formatTokens(deferred.tokens)}
                  </span>
                  <span className="ai-assist-context-popover-percent">—</span>
                </li>
              ))}
            </ul>
          )}

          {mcpRows.length > 0 && (
            <div className="ai-assist-context-popover-section">
              <button
                type="button"
                className="ai-assist-context-popover-section-toggle"
                aria-expanded={mcpOpen}
                onClick={() => setMcpOpen((open) => !open)}
              >
                <CaretDown
                  size={10}
                  weight="bold"
                  className={`ai-assist-context-popover-caret${mcpOpen ? "" : " is-collapsed"}`}
                  aria-hidden="true"
                />
                <span className="ai-assist-context-popover-section-title">
                  {t("ai_assist_context_mcp_tools", "MCP tools")}
                </span>
                <span className="ai-assist-context-popover-section-count">
                  {mcpRows.length}
                </span>
              </button>
              {mcpOpen && (
                <ul className="ai-assist-context-popover-list">
                  {mcpRows.map((row) => {
                    const label = `${row.server} · ${row.name}`;
                    return (
                      <li
                        key={`${row.server}/${row.name}`}
                        className={`ai-assist-context-popover-detail${row.deferred ? " is-deferred" : ""}`}
                      >
                        <span
                          className="ai-assist-context-popover-detail-name"
                          title={label}
                        >
                          {label}
                        </span>
                        <span className="ai-assist-context-popover-tokens">
                          {formatTokens(row.tokens)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {showFooter && (
            <div className="ai-assist-context-popover-footer">
              {t(
                "ai_assist_context_trim_summary",
                "__elided__ older messages were shortened and __dropped__ dropped to fit the window.",
                { elided, dropped }
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ContextUsagePopover;
