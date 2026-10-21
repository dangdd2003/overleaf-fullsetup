import { CSSProperties, forwardRef } from "react";
import { useTranslation } from "react-i18next";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import type { ContextUsageSnapshot } from "../../agent/context/context-usage-types";
import { formatTokens } from "../../agent/context/context-usage";

const RING_SIZE = 16;
const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** The smallest arc drawn once anything is used, so a near-empty chat shows a mark. */
const MIN_VISIBLE_ARC = 0.8;
/** Half the length of a threshold tick, across the ring. */
const TICK_HALF = 2.5;

/**
 * A tick across the ring at a share of the window, clockwise from the top
 * (the ring is rotated -90 degrees to start there).
 */
function tickPath(fraction: number): string {
  const angle = fraction * 2 * Math.PI;
  const c = RING_SIZE / 2;
  const point = (radius: number) =>
    `${(c + radius * Math.sin(angle)).toFixed(2)} ${(c - radius * Math.cos(angle)).toFixed(2)}`;
  return `M${point(RING_RADIUS - TICK_HALF)}L${point(RING_RADIUS + TICK_HALF)}`;
}

export type ContextUsageMeterProps = {
  snapshot: ContextUsageSnapshot | null;
  /** Whether the popover is open; the button then shows its active state. */
  open?: boolean;
  onToggle: () => void;
};

/**
 * How full the chat's context window is, as a small ring beside the effort
 * picker. A click toggles the context popover anchored to it. Renders nothing
 * until a provider is configured (the snapshot is null).
 */
export const ContextUsageMeter = forwardRef<
  HTMLButtonElement,
  ContextUsageMeterProps
>(function ContextUsageMeter({ snapshot, open = false, onToggle }, ref) {
  const { t } = useTranslation();

  if (!snapshot) return null;

  const percent = Math.min(100, Math.max(0, snapshot.percentUsed));
  const filled = (percent / 100) * RING_CIRCUMFERENCE;
  const visibleArc =
    percent > 0 ? Math.max(filled, MIN_VISIBLE_ARC) : 0;
  const showLabel = snapshot.state !== "ok";
  const windowSize = snapshot.contextWindow;
  const warnFraction = Math.min(1, snapshot.thresholds.warnAt / windowSize);
  const compactFraction = Math.min(
    1,
    snapshot.thresholds.autoCompactAt / windowSize
  );
  const compactPercent = Math.round(compactFraction * 100);

  const used = formatTokens(snapshot.usedTokens);
  const max = formatTokens(snapshot.contextWindow);
  const usedPercent = `${Math.round(snapshot.percentUsed)}%`;
  const summary = t(
    "ai_assist_context_meter_summary",
    "Context: __used__ / __max__ tokens (__percent__)",
    { used, max, percent: usedPercent }
  );
  const note = t(
    "ai_assist_context_autocompact_note",
    "Auto-compacts at __percent__%",
    { percent: compactPercent }
  );
  const ariaLabel = t("ai_assist_context_usage", "Context usage");

  const arcStyle: CSSProperties = {
    strokeDasharray: `${visibleArc} ${RING_CIRCUMFERENCE}`,
  };

  return (
    <OLTooltip
      id="ai-assist-context-meter-tooltip"
      hidden={open}
      description={
        <span className="ai-assist-context-meter-tooltip">
          <span>{summary}</span>
          <span className="ai-assist-context-meter-tooltip-note">{note}</span>
        </span>
      }
      overlayProps={{ placement: "top" }}
    >
      <button
        type="button"
        className={`ai-assist-mode-selector-btn ai-assist-context-meter is-${snapshot.state}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={snapshot.state}
        ref={ref}
        onClick={onToggle}
      >
        <svg
          className="ai-assist-context-meter-ring"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden="true"
        >
          <circle
            className="ai-assist-context-meter-track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={2}
          />
          <path
            className="ai-assist-context-meter-tick ai-assist-context-meter-tick-warn"
            d={tickPath(warnFraction)}
            strokeWidth={1.5}
          />
          <path
            className="ai-assist-context-meter-tick ai-assist-context-meter-tick-compact"
            d={tickPath(compactFraction)}
            strokeWidth={1.5}
          />
          <circle
            className="ai-assist-context-meter-arc"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            style={arcStyle}
          />
        </svg>
        {showLabel && (
          <span className="ai-assist-context-meter-label">
            {`${Math.round(percent)}%`}
          </span>
        )}
      </button>
    </OLTooltip>
  );
});
