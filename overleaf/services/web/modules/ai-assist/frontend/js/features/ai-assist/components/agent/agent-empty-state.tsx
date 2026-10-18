import { useTranslation } from "react-i18next";
import {
  ArrowBendDownRight,
  Bookmarks,
  Books,
  CheckSquareOffset,
  ImageSquare,
  MathOperations,
  Presentation,
  Quotes,
  Stamp,
  TreeStructure,
} from "@phosphor-icons/react";
import OLButton from "@/shared/components/ol/ol-button";
import { ProjectFile, ProjectHandle } from "../../agent/project-handle";
import { Starter } from "../../agent/starters/derive-starters";
import { useProjectStarters } from "../../agent/starters/use-project-starters";
import { AdvancedTool } from "../../agent/starters/derive-advanced-tools";
import { useAdvancedTools } from "../../agent/starters/use-advanced-tools";
import { SelectionInput } from "../../agent/starters/selection-types";
import { SelectionQuickActions } from "./selection-quick-actions";

/**
 * Every `t()` call below passes a string literal, and must keep doing so.
 *
 * The frontend does not ship the whole of `locales/en.json`: webpack runs it
 * through `frontend/translations-loader.js`, which keeps only the keys listed in
 * `frontend/extracted-translations.json`. That list is produced by
 * `yarn extract-translations`, a *static* scan that only sees calls whose key is
 * a string literal. Keys reached through a variable are invisible to the scan,
 * so they never reach the list, get dropped from the bundle, and render to the
 * user as the raw key.
 *
 * Unit tests do not catch this: they import `locales/en.json` directly and never
 * run the loader, so they see every key regardless.
 *
 * The prompts are deliberately not translated. They are instructions sent to the
 * model, not text shown to the user.
 */
export type PickedStarter = {
  prompt: string;
  oneShot?: boolean;
};

export function AgentEmptyState({
  onPick,
  handle,
  files,
  projectId,
  refreshSeed,
  disabled = false,
  selection,
}: {
  onPick: (starter: PickedStarter) => void;
  handle: ProjectHandle;
  files: ProjectFile[];
  projectId?: string;
  refreshSeed?: number;
  disabled?: boolean;
  selection?: SelectionInput | null;
}) {
  const { t } = useTranslation();
  const starters = useProjectStarters({
    handle,
    files,
    projectId,
    refreshSeed,
  });

  // One literal `t()` per rule, so the static scan sees every key. Values from
  // the project are interpolated, never concatenated into the key. Every option
  // is written out by name: the scanner parses this object with esprima, and a
  // spread (`...starter.params`) makes it throw and drop the key's default.
  // Count-bearing labels pass `count`, which is what selects the `_plural` form.
  const labelFor = (starter: Starter): string => {
    const params = starter.params;
    switch (starter.id) {
      case "fix_compile_errors":
        return t("ai_assist_starter_fix_compile_errors", {
          count: Number(params.error_count),
          defaultValue: `Fix ${params.error_count} compile errors`,
        });
      case "resolve_warnings":
        return t("ai_assist_starter_resolve_warnings", {
          count: Number(params.warning_count),
          defaultValue: `Resolve ${params.warning_count} compile warnings`,
        });
      case "add_missing_package":
        return t("ai_assist_starter_add_missing_package", {
          package_name: String(params.package_name),
          defaultValue: `Add \\usepackage{${params.package_name}}`,
        });
      case "add_bibliography":
        return t("ai_assist_starter_add_bibliography", {
          count: Number(params.cite_count),
          defaultValue: `Add bibliography for ${params.cite_count} citations`,
        });
      case "add_missing_bib_entries":
        return t("ai_assist_starter_add_missing_bib_entries", {
          count: Number(params.cite_count),
          defaultValue: `Add ${params.cite_count} missing BibTeX entries`,
        });
      case "fix_duplicate_labels":
        return t("ai_assist_starter_fix_duplicate_labels", {
          count: Number(params.count),
          defaultValue: `Fix ${params.count} duplicate labels`,
        });
      case "resolve_broken_refs":
        return t("ai_assist_starter_resolve_broken_refs", {
          count: Number(params.unresolved_ref_count),
          defaultValue: `Resolve ${params.unresolved_ref_count} broken references`,
        });
      case "init_document_structure":
        return t(
          "ai_assist_starter_init_document_structure",
          "Set up document structure and compile",
        );
      case "draft_conclusion":
        return t("ai_assist_starter_draft_conclusion", {
          file: String(params.file),
          defaultValue: `Draft a conclusion for ${params.file}`,
        });
      case "draft_abstract_title":
        return t("ai_assist_starter_draft_abstract_title", {
          root_file: String(params.root_file),
          defaultValue: `Draft abstract and title in ${params.root_file}`,
        });
      case "proofread_active_file":
        return t("ai_assist_starter_proofread_active_file", {
          file: String(params.file),
          defaultValue: `Proofread ${params.file} for academic tone`,
        });
      case "add_summary_table":
        return t("ai_assist_starter_add_summary_table", {
          file: String(params.file),
          defaultValue: `Add a summary table to ${params.file}`,
        });
      case "add_figure_placeholder":
        return t("ai_assist_starter_add_figure_placeholder", {
          file: String(params.file),
          defaultValue: `Add a figure placeholder to ${params.file}`,
        });
      case "what_can_you_do":
        return t(
          "ai_assist_starter_what_can_you_do",
          "What can the assistant do for me?",
        );
      case "beamer":
        return t("ai_assist_starter_beamer", "Create a Beamer presentation");
      case "generate_table":
        return t("ai_assist_starter_generate_table", "Generate a table");
      case "generate_tikz":
        return t("ai_assist_starter_generate_tikz", "Create a TikZ diagram");
      case "manage_bibliography":
        return t("ai_assist_starter_manage_bibliography", "Add a bibliography");
      case "insert_equation":
        return t("ai_assist_starter_insert_equation", "Insert an equation");
      case "summarize":
        return t("ai_assist_starter_summarize", "Summarize this file");
    }
  };

  const advancedTools = useAdvancedTools({
    handle,
    files,
    projectId,
    refreshSeed,
  });

  // Same rule as labelFor: one literal key per card and per description, so
  // the static scan sees them all. A card with no params is the generic one
  // shown when the project offers no evidence.
  const advancedTitleFor = (tool: AdvancedTool): string => {
    switch (tool.id) {
      case "unsupported_statements":
        return t(
          "ai_assist_tool_scan_unsupported_statements",
          "Scan for unsupported statements",
        );
      case "reference_audit":
        return t(
          "ai_assist_tool_audit_references",
          "Audit cross-references and citations",
        );
      case "figures_tables":
        return t("ai_assist_tool_figures_tables", "Audit figures and tables");
      case "notation":
        return t("ai_assist_tool_notation", "Check notation consistency");
      case "unused_bib":
        return t("ai_assist_tool_unused_bib", "Clean up the bibliography");
      case "abstract_results":
        return t(
          "ai_assist_tool_abstract_results",
          "Check the abstract against the results",
        );
      case "structure_flow":
        return t("ai_assist_tool_structure_flow", "Review structure and flow");
      case "venue_format":
        return t("ai_assist_tool_venue_format", {
          venue: String(tool.params.venue),
          defaultValue: `Check ${tool.params.venue} formatting`,
        });
      case "slide_density":
        return t("ai_assist_tool_slide_density", "Review slide density");
    }
  };

  const advancedDescriptionFor = (tool: AdvancedTool): string => {
    const params = tool.params;
    switch (tool.id) {
      case "unsupported_statements":
        if (params.line_count === undefined) {
          return t(
            "ai_assist_tool_scan_unsupported_statements_description",
            "Get ready for peer review by checking if you've missed any references.",
          );
        }
        if (Number(params.citation_count) === 0) {
          return t("ai_assist_tool_unsupported_no_citations", {
            line_count: Number(params.line_count),
            defaultValue: `No citations yet across ${params.line_count} lines. Find the claims that need one.`,
          });
        }
        return t("ai_assist_tool_unsupported_density", {
          lines_per_citation: Number(params.lines_per_citation),
          defaultValue: `About one citation every ${params.lines_per_citation} lines. Find the claims still missing one.`,
        });
      case "reference_audit":
        if (params.label_count === undefined) {
          return t(
            "ai_assist_tool_audit_references_description",
            "Check for duplicate labels, unresolved cross-references, and missing bibliography entries.",
          );
        }
        if (Number(params.unreferenced_count) > 0) {
          return t("ai_assist_tool_audit_references_unreferenced", {
            unreferenced_count: Number(params.unreferenced_count),
            label_count: Number(params.label_count),
            defaultValue: `Never referenced: ${params.unreferenced_count} of ${params.label_count} labels. Also checks placement and citation style.`,
          });
        }
        return t(
          "ai_assist_tool_audit_references_style",
          "Everything resolves. Check label placement, spacing and citation style.",
        );
      case "figures_tables":
        if (Number(params.unreferenced_count) > 0) {
          return t("ai_assist_tool_figures_tables_unreferenced", {
            unreferenced_count: Number(params.unreferenced_count),
            float_count: Number(params.float_count),
            defaultValue: `Never referenced in the text: ${params.unreferenced_count} of ${params.float_count} figures and tables.`,
          });
        }
        return t("ai_assist_tool_figures_tables_description", {
          float_count: Number(params.float_count),
          defaultValue: `Figures and tables: ${params.float_count}. Check captions, references and placement.`,
        });
      case "notation":
        return t("ai_assist_tool_notation_description", {
          equation_count: Number(params.equation_count),
          file_count: Number(params.file_count),
          defaultValue: `Equations: ${params.equation_count} across ${params.file_count} files. Find symbols that drift or go undefined.`,
        });
      case "unused_bib":
        return t("ai_assist_tool_unused_bib_description", {
          unused_count: Number(params.unused_count),
          entry_count: Number(params.entry_count),
          defaultValue: `Never cited: ${params.unused_count} of ${params.entry_count} entries. Also finds duplicates and missing fields.`,
        });
      case "abstract_results":
        return t(
          "ai_assist_tool_abstract_results_description",
          "Make sure every claim and number in the abstract is backed by your results.",
        );
      case "structure_flow":
        return t("ai_assist_tool_structure_flow_description", {
          section_count: Number(params.section_count),
          defaultValue: `Read ${params.section_count} sections as a referee: argument, balance and repetition.`,
        });
      case "venue_format":
        return t(
          "ai_assist_tool_venue_format_description",
          "Check front matter, captions, references and packages against the template.",
        );
      case "slide_density":
        return t(
          "ai_assist_tool_slide_density_description",
          "Find overloaded frames and text-heavy slides before you present.",
        );
    }
  };

  const advancedIconFor = (tool: AdvancedTool) => {
    const props = {
      size: 18,
      weight: "fill" as const,
      className: "ai-assist-empty-state-icon",
    };
    switch (tool.id) {
      case "unsupported_statements":
        return <Quotes {...props} />;
      case "reference_audit":
        return <Bookmarks {...props} />;
      case "figures_tables":
        return <ImageSquare {...props} />;
      case "notation":
        return <MathOperations {...props} />;
      case "unused_bib":
        return <Books {...props} />;
      case "abstract_results":
        return <CheckSquareOffset {...props} />;
      case "structure_flow":
        return <TreeStructure {...props} />;
      case "venue_format":
        return <Stamp {...props} />;
      case "slide_density":
        return <Presentation {...props} />;
    }
  };

  return (
    <div className={`ai-assist-empty-state ${disabled ? "is-disabled" : ""}`}>
      <h5>{t("ai_assist_advanced_tools", "Advanced tools")}</h5>
      {advancedTools.map((tool, index) => (
        <OLButton
          key={tool.id}
          type="button"
          variant="secondary"
          disabled={disabled}
          className="ai-assist-advanced-tool ai-assist-suggestion-enter"
          style={{ animationDelay: `${index * 40}ms` }}
          leadingIcon={advancedIconFor(tool)}
          onClick={() =>
            !disabled && onPick({ prompt: tool.prompt, oneShot: true })
          }
        >
          <span className="ai-assist-advanced-tool-text">
            <strong>{advancedTitleFor(tool)}</strong>
            <span className="ai-assist-advanced-tool-description">
              {advancedDescriptionFor(tool)}
            </span>
          </span>
        </OLButton>
      ))}

      {selection ? (
        <SelectionQuickActions
          variant="list"
          selection={selection}
          disabled={disabled}
          onPick={(action) =>
            !disabled && onPick({ prompt: action.prompt, oneShot: false })
          }
        />
      ) : (
        <>
          <h5>{t("ai_assist_start_a_chat", "Start a chat")}</h5>
          {starters.map((starter, index) => (
            <OLButton
              key={starter.id}
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              className="ai-assist-starter ai-assist-suggestion-enter"
              style={{
                animationDelay: `${(advancedTools.length + index) * 40}ms`,
              }}
              leadingIcon={
                <ArrowBendDownRight
                  size={16}
                  className="ai-assist-empty-state-icon"
                />
              }
              onClick={() => !disabled && onPick(starter)}
            >
              {labelFor(starter)}
            </OLButton>
          ))}
        </>
      )}

      <p className="ai-assist-slash-tip">
        {t("ai_assist_slash_tip", "Type / for commands")}
      </p>
    </div>
  );
}
