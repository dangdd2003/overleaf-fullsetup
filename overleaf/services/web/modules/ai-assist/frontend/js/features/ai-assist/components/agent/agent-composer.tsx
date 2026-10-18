import {
  ChangeEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  FileText,
  HandPalm,
  PencilSimple,
  ListChecks,
  CaretUp,
  Wrench,
  PencilSimpleLine,
  CheckCircle,
  Translate,
  Quotes,
  Table,
  Image,
  Function,
  MagnifyingGlass,
  Scales,
  Article,
  Package,
  Books,
  Ruler,
  ChatCircleText,
  ClockCounterClockwise,
  ArrowUp,
  ArrowDown,
  ArrowBendDownLeft,
  Lightning,
} from "@phosphor-icons/react";
import {
  OLDropdown,
  OLDropdownMenu,
  OLDropdownToggle,
  OLDropdownItem,
} from "@/shared/components/ol/ol-dropdown-menu";
import useEventListener from "@/shared/hooks/use-event-listener";
import { AttachmentRef } from "../../agent/context/types";
import { parseAttachmentRef } from "../../agent/context/attachments";
import { AgentMode, nextMode } from "../../agent/agent-mode";
import { ReasoningEffortPicker } from "./reasoning-effort-picker";
import { ChatSendButton } from "./chat-send-button";
import { SelectionScope } from "../../agent/starters/selection-types";
import { SelectionQuickActions } from "./selection-quick-actions";
import { useChatConnectors } from "../../connectors/use-chat-connectors";
import {
  filterSlashCommands,
  findSlashCommand,
  parseSlashInput,
} from "../../agent/slash-commands/catalog";
import {
  SlashCommandDefinition,
  SlashCommandId,
  SlashCommandInvocation,
} from "../../agent/slash-commands/types";
import { missingSlashParams } from "../../agent/slash-commands/params";
import {
  getTopUsedCommandIds,
  recordSlashCommandUsage,
} from "../../agent/slash-commands/usage-store";
import {
  normalizeImage,
  imageFromClipboard,
  formatBytes,
  GeneratorImage,
} from "../../generator/image";
import { ChatImage } from "../../providers/types";
import { ComposerPlusMenu } from "./composer-plus-menu";
import { CodeIcon, ContextChip } from "./context-chip";
import getMeta from "@/utils/meta";
import {
  cancelPdfBoxSelect,
  startPdfBoxSelect,
  usePdfTurnContext,
} from "../../pdf/turn-context";
import { usePdfViewerAvailable } from "../../pdf/use-pdf-context";
import { PdfContextChips } from "../../pdf/pdf-context-chips";

export interface SelectionRangeItem {
  from: number;
  to: number;
  text: string;
  scope?: SelectionScope;
}

export interface AttachedSelection {
  path: string;
  from: number;
  to: number;
  text: string;
  /** What the selection is, classified in the editor; absent from older senders. */
  scope?: SelectionScope;
  ranges?: SelectionRangeItem[];
}

export function isSameSelection(
  a: AttachedSelection | null | undefined,
  b: AttachedSelection | null | undefined,
): boolean {
  if (!a || !b) return false;
  if (
    a.path !== b.path ||
    a.from !== b.from ||
    a.to !== b.to ||
    a.text !== b.text
  ) {
    return false;
  }
  const aRanges = a.ranges || [];
  const bRanges = b.ranges || [];
  if (aRanges.length !== bRanges.length) return false;
  for (let i = 0; i < aRanges.length; i++) {
    if (
      aRanges[i].from !== bRanges[i].from ||
      aRanges[i].to !== bRanges[i].to ||
      aRanges[i].text !== bRanges[i].text
    ) {
      return false;
    }
  }
  return true;
}

const MENTION_RE = /@([^\s@]*)$/;

/**
 * The `@` token being typed immediately before the caret, or null.
 *
 * Stops at whitespace so a completed mention does not reopen the menu on every
 * later keystroke.
 */
export function mentionQueryAt(value: string, caret: number): string | null {
  const match = value.slice(0, caret).match(MENTION_RE);
  return match ? match[1] : null;
}

const SLASH_TOKEN_RE = /^\/([a-z-]*)$/i;

/**
 * The command name typed at the start of the input, or null.
 *
 * Only a lone `/word` counts, with the caret inside it. As soon as a space is
 * typed the command is chosen and the rest is its arguments, so the menu closes.
 * A `/` anywhere else is just text, which keeps paths and `/` in prose safe.
 */
export function slashQueryAt(value: string, caret: number): string | null {
  const beforeCaret = value.slice(0, caret);
  const lastNewline = beforeCaret.lastIndexOf("\n");
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  const lineToCaret = beforeCaret.slice(lineStart);

  const afterCaret = value.slice(caret);
  const tokenRestMatch = afterCaret.match(/^[a-z-]*/i);
  const tokenRest = tokenRestMatch ? tokenRestMatch[0] : "";

  const fullLineToken = (lineToCaret + tokenRest).trimStart();
  const match = fullLineToken.match(SLASH_TOKEN_RE);
  if (!match) return null;
  return match[1];
}

function slashOptionId(command: SlashCommandDefinition): string {
  return `ai-assist-slash-option-${command.id}`;
}

export function getSlashCommandIcon(id: SlashCommandId) {
  switch (id) {
    case "fix":
      return Wrench;
    case "layout":
      return Ruler;
    case "explain":
      return ChatCircleText;
    case "rewrite":
      return PencilSimpleLine;
    case "proofread":
      return CheckCircle;
    case "translate":
      return Translate;
    case "cite":
      return Quotes;
    case "bib":
      return Books;
    case "table":
      return Table;
    case "figure":
      return Image;
    case "equation":
      return Function;
    case "review":
      return MagnifyingGlass;
    case "check":
      return Scales;
    case "summarize":
      return Article;
    case "preamble":
      return Package;
    default:
      return ChatCircleText;
  }
}

export function AgentComposer({
  running,
  disabled = false,
  paths = [],
  onSend,
  onStop,
  mode = "manual",
  onModeChange,
  attachments: externalAttachments,
  setAttachments: externalSetAttachments,
  attachedSelection: externalAttachedSelection,
  setAttachedSelection: externalSetAttachedSelection,
  history = [],
  restoredDraft = null,
  showSelectionActions = false,
  chatId = null,
}: {
  running: boolean;
  disabled?: boolean;
  paths?: string[];
  chatId?: string | null;
  /**
   * `text` is the words after a recognised slash command, or the whole input
   * when none is. `command` is set only for a recognised command.
   */
  onSend: (
    text: string,
    attachments: AttachmentRef[],
    attachedSelection?: AttachedSelection | null,
    command?: SlashCommandInvocation,
    images?: ChatImage[],
  ) => void;
  onStop: () => void;
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  attachments?: AttachmentRef[];
  setAttachments?: React.Dispatch<React.SetStateAction<AttachmentRef[]>>;
  attachedSelection?: AttachedSelection | null;
  setAttachedSelection?: React.Dispatch<
    React.SetStateAction<AttachedSelection | null>
  >;
  history?: string[];
  /** A queued message taken back to be edited; a new object each time. */
  restoredDraft?: { text: string; command?: SlashCommandInvocation } | null;
  showSelectionActions?: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const draftRef = useRef<string>("");
  const [internalAttachments, setInternalAttachments] = useState<
    AttachmentRef[]
  >([]);
  const [internalAttachedSelection, setInternalAttachedSelection] =
    useState<AttachedSelection | null>(null);
  const dismissedSelectionRef = useRef<AttachedSelection | null>(null);

  const handleSetAttachedSelection = useCallback(
    (action: React.SetStateAction<AttachedSelection | null>) => {
      setInternalAttachedSelection((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        if (next === null) {
          if (prev !== null) {
            dismissedSelectionRef.current = prev;
          }
        } else {
          dismissedSelectionRef.current = null;
        }
        return next;
      });
    },
    [],
  );

  const attachments = externalAttachments ?? internalAttachments;
  const setAttachments = externalSetAttachments ?? setInternalAttachments;
  const attachedSelection =
    externalAttachedSelection !== undefined
      ? externalAttachedSelection
      : internalAttachedSelection;
  const setAttachedSelection =
    externalSetAttachedSelection ?? handleSetAttachedSelection;

  const removeSelectionRange = useCallback(
    (index: number) => {
      if (!attachedSelection) return;
      const ranges = attachedSelection.ranges;
      if (!ranges || ranges.length <= 1) {
        setAttachedSelection(null);
        return;
      }
      const remaining = ranges.filter((_, i) => i !== index);
      if (remaining.length === 0) {
        setAttachedSelection(null);
      } else if (remaining.length === 1) {
        const single = remaining[0];
        setAttachedSelection({
          path: attachedSelection.path,
          from: single.from,
          to: single.to,
          text: single.text,
          scope: single.scope,
        });
      } else {
        setAttachedSelection({
          path: attachedSelection.path,
          from: remaining[0].from,
          to: remaining[remaining.length - 1].to,
          text: remaining.map((r) => r.text).join("\n\n"),
          ranges: remaining,
        });
      }
    },
    [attachedSelection, setAttachedSelection],
  );

  const [query, setQuery] = useState<string | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  // Records the connected connectors that runs in this chat may use, so it
  // stays mounted whether or not the Connectors submenu is ever opened
  useChatConnectors(chatId);
  const [images, setImages] = useState<GeneratorImage[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const pdfTurn = usePdfTurnContext();
  // The "Select PDF area" item only exists where there is a PDF to box
  const pdfViewerAvailable = usePdfViewerAvailable();
  const showPdfAreaButton =
    pdfViewerAvailable && Boolean(getMeta("ol-aiAssistEnabled"));
  // Esc cancels a box being drawn wherever the focus is, not just in the input
  useEventListener(
    "keydown",
    useCallback(
      (event: Event) => {
        if (
          pdfTurn.boxSelecting &&
          (event as globalThis.KeyboardEvent).key === "Escape"
        ) {
          cancelPdfBoxSelect();
        }
      },
      [pdfTurn.boxSelecting],
    ),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  // Set when a send was held for a missing required input, until the next edit
  const [slashMissing, setSlashMissing] = useState(false);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    const originalValue = el.value;
    if (!originalValue && el.placeholder) {
      el.value = el.placeholder;
    }

    el.style.height = "auto";
    const scrollHeight = el.scrollHeight;

    if (!originalValue) {
      el.value = "";
    }

    const panelEl = el.closest(".ai-assist-panel");
    const panelHeight = panelEl?.clientHeight || window.innerHeight;
    const maxAllowedHeight = Math.max(80, Math.floor(panelHeight / 3));
    const nextHeight = Math.max(24, Math.min(scrollHeight, maxAllowedHeight));
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = scrollHeight > maxAllowedHeight ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    autoResize();
    const el = textareaRef.current;
    if (!el) return;

    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        autoResize();
      });
    };

    window.addEventListener("resize", handleResize);

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && el.parentElement) {
      ro = new ResizeObserver(handleResize);
      ro.observe(el.parentElement);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleResize);
      if (ro) ro.disconnect();
    };
  }, [value, disabled, autoResize]);

  const modeConfig: Record<
    AgentMode,
    { label: string; desc: string; num: string; icon: React.ReactNode }
  > = {
    manual: {
      label: t("ai_assist_mode_manual", "Manual"),
      desc: t("ai_assist_mode_manual_desc", "Always ask before making changes"),
      num: "1",
      icon: <HandPalm size={15} weight="bold" />,
    },
    acceptEdits: {
      label: t("ai_assist_mode_accept_edits", "Accept edits"),
      desc: t(
        "ai_assist_mode_accept_edits_desc",
        "Automatically accept all file edits",
      ),
      num: "2",
      icon: <PencilSimple size={15} weight="bold" />,
    },
    plan: {
      label: t("ai_assist_mode_plan", "Plan"),
      desc: t(
        "ai_assist_mode_plan_desc",
        "Create a plan before making changes",
      ),
      num: "3",
      icon: <ListChecks size={15} weight="bold" />,
    },
  };

  const currentModeConfig = modeConfig[mode || "manual"] || modeConfig.manual;

  /**
   * Pick a mode by typing the number shown against it, like Claude Code.
   *
   * Only while the menu is open: the composer textarea has focus otherwise, and
   * there a digit is just text. The accepted keys come from the same `num` the
   * menu renders, so the badge and the shortcut cannot drift apart.
   */
  const onModeMenuKeyDown = (event: KeyboardEvent) => {
    const picked = (Object.keys(modeConfig) as AgentMode[]).find(
      (candidate) => modeConfig[candidate].num === event.key,
    );
    if (!picked) return;
    event.preventDefault();
    onModeChange?.(picked);
    setModeMenuOpen(false);
  };

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || files.length === 0) return;
      const imageFiles = files.filter(
        (f) =>
          f.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif)$/i.test(f.name),
      );
      if (imageFiles.length === 0) return;

      const normalizedList: GeneratorImage[] = [];
      for (const file of imageFiles) {
        try {
          const normalized = await normalizeImage(file);
          normalizedList.push(normalized);
        } catch {
          // Ignore unreadable images
        }
      }

      if (normalizedList.length > 0) {
        setImages((prev) => {
          const remaining = 2 - prev.length;
          if (remaining <= 0) return prev;
          return [...prev, ...normalizedList.slice(0, remaining)];
        });
      }
    },
    [disabled],
  );

  const handleFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      void addFiles(Array.from(files));
    }
    event.target.value = "";
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const imageFile = imageFromClipboard(event.clipboardData);
    if (imageFile) {
      event.preventDefault();
      void addFiles([imageFile]);
    }
  };

  const onDragOver = (event: React.DragEvent) => {
    if (disabled) return;
    event.preventDefault();
    setIsDragOver(true);
  };

  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void addFiles(Array.from(files));
    }
  };

  const handleSlashCommandsClick = () => {
    setValue((current) => (current.startsWith("/") ? current : `/${current}`));
    setSlashQuery("");
    setSlashIndex(0);
    const nextLen = value.startsWith("/")
      ? value.length
      : value ? value.length + 1 : 1;
    setCaretToEnd(nextLen);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    if (query === null) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setQuery(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [query]);

  const slashMatches =
    slashQuery === null ? [] : filterSlashCommands(slashQuery);
  const slashOpen = slashMatches.length > 0;
  const activeSlash = Math.min(slashIndex, slashMatches.length - 1);
  const topUsedIds = useMemo(
    () => (slashOpen ? getTopUsedCommandIds(3) : []),
    [slashOpen],
  );

  useEffect(() => {
    if (!slashOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        slashMenuRef.current?.contains(target) ||
        target === textareaRef.current
      ) {
        return;
      }
      setSlashQuery(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [slashOpen]);

  // Keep the highlighted row in view while arrowing through a long list
  useEffect(() => {
    if (!slashOpen) return;
    const option = document.getElementById(
      slashOptionId(slashMatches[activeSlash]),
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }, [slashOpen, activeSlash, slashQuery]);

  useEffect(() => {
    setHistoryIndex(-1);
  }, [history]);

  // Ahead of anything already typed, one message per line, as Claude Code
  // hands back what you queued
  useEffect(() => {
    if (!restoredDraft) return;
    const restoredText = restoredDraft.command
      ? `/${restoredDraft.command.id}${restoredDraft.text ? ` ${restoredDraft.text}` : ''}`
      : restoredDraft.text;
    setValue((current) =>
      current.trim() ? `${restoredText}\n${current}` : restoredText,
    );
    setSlashQuery(null);
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  }, [restoredDraft]);

  // "Custom prompt" in TeXGPT and Writing tools opens the chat here
  useEventListener("aiAssist:focusComposer", () => {
    textareaRef.current?.focus();
  });

  useEventListener("aiAssist:selectionChanged", (event: Event) => {
    if (externalSetAttachedSelection) return;
    const detail = (event as CustomEvent<AttachedSelection | null>).detail;
    if (detail && detail.text) {
      if (
        dismissedSelectionRef.current &&
        isSameSelection(detail, dismissedSelectionRef.current)
      ) {
        return;
      }
      dismissedSelectionRef.current = null;
      setAttachedSelection(detail);
    } else {
      dismissedSelectionRef.current = null;
      setAttachedSelection(null);
    }
  });

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;

    if (historyIndex !== -1) {
      setHistoryIndex(-1);
    }

    const completed = next.match(/@([^\s@]+)\s$/);
    if (completed) {
      const ref = parseAttachmentRef(completed[1]);
      if (ref && paths.includes(ref.path)) {
        setAttachments((current) => [...current, ref]);
        setValue(
          next.slice(0, completed.index) +
            next.slice(completed.index! + completed[0].length),
        );
        setQuery(null);
        return;
      }
    }

    setValue(next);
    setQuery(mentionQueryAt(next, caret));
    setSlashQuery(slashQueryAt(next, caret));
    setSlashMissing(false);
    setSlashIndex(0);
  };

  const choose = (path: string) => {
    setAttachments((current) => [...current, { path }]);
    setValue((current) => current.replace(MENTION_RE, ""));
    setQuery(null);
    textareaRef.current?.focus();
  };

  // A PDF selection or box is content to send, like an attached selection. A
  // box still being captured is not: it would miss this message.
  const hasPdfContent =
    pdfTurn.selections.length > 0 || pdfTurn.areas.length > 0;
  const hasPdfChips = hasPdfContent || pdfTurn.pendingAreas > 0;

  const hasContent =
    Boolean(value.trim()) ||
    attachments.length > 0 ||
    attachedSelection !== null ||
    images.length > 0 ||
    hasPdfContent;

  const sendText = (text: string) => {
    if (disabled) return;
    const trimmed = text.trim();
    if (
      !trimmed &&
      attachments.length === 0 &&
      !attachedSelection &&
      images.length === 0 &&
      !hasPdfContent
    ) {
      return;
    }
    const chatImages: ChatImage[] = images.map((img) => ({
      mediaType: img.mediaType,
      data: img.data,
    }));
    const imagesToSend = chatImages.length > 0 ? chatImages : undefined;

    // A known command goes out as its arguments plus the command; anything
    // else, including an unknown `/word`, goes out as typed
    const parsed = parseSlashInput(trimmed);
    // A command missing a required input stays in the box with its hint
    // flagged, completed to `/name ` so the input can be typed straight away
    if (parsed && missingSlashParams(parsed.command, parsed.args).length > 0) {
      if (!/\s$/.test(value)) {
        const completed = `${value.trimEnd()} `;
        setValue(completed);
        setCaretToEnd(completed.length);
      }
      setSlashQuery(null);
      setSlashMissing(true);
      textareaRef.current?.focus();
      return;
    }
    if (parsed) {
      recordSlashCommandUsage(parsed.command.id);
      const commandInvocation: SlashCommandInvocation = {
        id: parsed.command.id,
        args: parsed.args,
      };
      if (imagesToSend) {
        onSend(
          parsed.args,
          attachments,
          attachedSelection,
          commandInvocation,
          imagesToSend,
        );
      } else {
        onSend(parsed.args, attachments, attachedSelection, commandInvocation);
      }
    } else if (imagesToSend) {
      onSend(
        trimmed,
        attachments,
        attachedSelection,
        undefined,
        imagesToSend,
      );
    } else {
      onSend(trimmed, attachments, attachedSelection);
    }
    setValue("");
    setAttachments([]);
    setImages([]);
    setQuery(null);
    setSlashQuery(null);
    setAttachedSelection(null);
    setHistoryIndex(-1);
    draftRef.current = "";
  };

  const send = () => {
    sendText(value);
  };

  const setCaretToEnd = (len: number) => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.selectionStart = len;
      textarea.selectionEnd = len;
    }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(len, len);
        }
      });
    }
  };

  /**
   * Picking a command replaces the lone `/word` with `/id ` and keeps focus, so
   * the user can type the arguments straight away.
   */
  const pickCommand = (command: SlashCommandDefinition) => {
    const text = `/${command.id} `;
    setValue(text);
    setSlashQuery(null);
    setCaretToEnd(text.length);
    textareaRef.current?.focus();
  };

  // Each `t()` takes a literal key so the static extraction sees it, the same
  // rule as agent-empty-state.tsx. The catalog's English is the fallback.
  const slashLabelFor = (command: SlashCommandDefinition): string => {
    switch (command.id) {
      case "fix":
        return t("ai_assist_slash_fix", command.label);
      case "layout":
        return t("ai_assist_slash_layout", command.label);
      case "bib":
        return t("ai_assist_slash_bib", command.label);
      case "explain":
        return t("ai_assist_slash_explain", command.label);
      case "rewrite":
        return t("ai_assist_slash_rewrite", command.label);
      case "proofread":
        return t("ai_assist_slash_proofread", command.label);
      case "translate":
        return t("ai_assist_slash_translate", command.label);
      case "cite":
        return t("ai_assist_slash_cite", command.label);
      case "table":
        return t("ai_assist_slash_table", command.label);
      case "figure":
        return t("ai_assist_slash_figure", command.label);
      case "equation":
        return t("ai_assist_slash_equation", command.label);
      case "review":
        return t("ai_assist_slash_review", command.label);
      case "check":
        return t("ai_assist_slash_check", command.label);
      case "summarize":
        return t("ai_assist_slash_summarize", command.label);
      case "preamble":
        return t("ai_assist_slash_preamble", command.label);
    }
  };

  const slashDescriptionFor = (command: SlashCommandDefinition): string => {
    switch (command.id) {
      case "fix":
        return t("ai_assist_slash_fix_desc", command.description);
      case "layout":
        return t("ai_assist_slash_layout_desc", command.description);
      case "bib":
        return t("ai_assist_slash_bib_desc", command.description);
      case "explain":
        return t("ai_assist_slash_explain_desc", command.description);
      case "rewrite":
        return t("ai_assist_slash_rewrite_desc", command.description);
      case "proofread":
        return t("ai_assist_slash_proofread_desc", command.description);
      case "translate":
        return t("ai_assist_slash_translate_desc", command.description);
      case "cite":
        return t("ai_assist_slash_cite_desc", command.description);
      case "table":
        return t("ai_assist_slash_table_desc", command.description);
      case "figure":
        return t("ai_assist_slash_figure_desc", command.description);
      case "equation":
        return t("ai_assist_slash_equation_desc", command.description);
      case "review":
        return t("ai_assist_slash_review_desc", command.description);
      case "check":
        return t("ai_assist_slash_check_desc", command.description);
      case "summarize":
        return t("ai_assist_slash_summarize_desc", command.description);
      case "preamble":
        return t("ai_assist_slash_preamble_desc", command.description);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "u") {
      event.preventDefault();
      fileInputRef.current?.click();
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      onModeChange?.(nextMode(mode || "manual"));
      return;
    }
    if (slashOpen && !event.shiftKey) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((activeSlash + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(
          (activeSlash - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = slashMatches[activeSlash];
        // A name typed out in full is a command to run, as in Claude Code:
        // Enter sends it with no arguments. Tab, or a partial name, completes.
        const typedInFull =
          event.key === "Enter" &&
          slashQuery !== null &&
          findSlashCommand(slashQuery) === picked;
        if (typedInFull) {
          sendText(`/${slashQuery}`);
        } else {
          pickCommand(picked);
        }
        return;
      }
    }
    if (event.key === "Escape") {
      // Cancelling a box is the first Esc; it must not also clear the input
      if (pdfTurn.boxSelecting) {
        event.preventDefault();
        cancelPdfBoxSelect();
        return;
      }
      if (plusMenuOpen) {
        event.preventDefault();
        setPlusMenuOpen(false);
        return;
      }
      if (query !== null) {
        event.preventDefault();
        setQuery(null);
        return;
      }
      if (slashQuery !== null) {
        event.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (hasContent) {
        // Esc is the way out of whatever you just typed. Stopping the run as
        // well would throw away the model's work to clear a textarea.
        event.preventDefault();
        setValue("");
        setImages([]);
        setHistoryIndex(-1);
        draftRef.current = "";
        return;
      }
      if (running) {
        event.preventDefault();
        onStop();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // Enter picks from the menu rather than sending a half-typed mention.
      if (query !== null) return;
      // While a run is going this queues the message rather than starting a
      // second run; the panel decides which, so the composer just sends.
      send();
      return;
    }

    if (query === null && history.length > 0) {
      if (event.key === "ArrowUp") {
        const textarea = textareaRef.current;
        const caret = textarea?.selectionStart ?? 0;
        const isAtTopLine = !value.slice(0, caret).includes("\n");

        if (isAtTopLine || historyIndex >= 0 || value === "") {
          event.preventDefault();
          if (historyIndex === -1) {
            draftRef.current = value;
          }
          const nextIndex =
            historyIndex === -1
              ? 0
              : Math.min(historyIndex + 1, history.length - 1);
          const targetText = history[history.length - 1 - nextIndex];
          setValue(targetText);
          setHistoryIndex(nextIndex);
          setCaretToEnd(targetText.length);
        }
      } else if (event.key === "ArrowDown" && historyIndex >= 0) {
        event.preventDefault();
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          const targetText = history[history.length - 1 - nextIndex];
          setValue(targetText);
          setHistoryIndex(nextIndex);
          setCaretToEnd(targetText.length);
        } else {
          const draft = draftRef.current;
          setValue(draft);
          setHistoryIndex(-1);
          setCaretToEnd(draft.length);
        }
      }
    }
  };

  const matches =
    query === null
      ? []
      : paths
          .filter((path) => path.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8);

  const sendLabel = running
    ? t("ai_assist_send_to_running_agent", "Send to the running agent")
    : t("send", "Send");

  // The command the input starts with, once it is recognised
  const slashCommand = parseSlashInput(value);
  // A command chosen with no arguments yet: its argument hint shows in the
  // input, after the command, where the arguments will go
  const slashGhost =
    slashCommand !== null &&
    slashCommand.args === "" &&
    /\s$/.test(value) &&
    slashCommand.command.argumentHint
      ? slashCommand.command.argumentHint
      : null;

  return (
    <div className="ai-assist-composer">
      {showSelectionActions &&
        attachedSelection &&
        !running &&
        !disabled &&
        value.trim() === "" &&
        query === null && (
          <SelectionQuickActions
            variant="chips"
            selection={attachedSelection}
            disabled={disabled}
            onPick={(action) => sendText(action.prompt)}
          />
        )}
      <div
        className={`ai-assist-composer-box ${disabled ? "is-disabled" : ""} ${isDragOver ? "is-drag-over" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {query !== null && matches.length > 0 && (
          <ul ref={menuRef} className="ai-assist-mention-menu" role="listbox">
            {matches.map((path) => {
              const slash = path.lastIndexOf("/");
              const name = slash === -1 ? path : path.slice(slash + 1);
              const dir = slash === -1 ? null : path.slice(0, slash);
              return (
                <li key={path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-label={path}
                    onClick={() => choose(path)}
                  >
                    <FileText
                      size={15}
                      className="ai-assist-mention-menu-icon"
                      aria-hidden="true"
                    />
                    <span className="ai-assist-mention-menu-name">{name}</span>
                    {dir && (
                      <span className="ai-assist-mention-menu-dir">{dir}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {slashOpen && (
          <div
            ref={slashMenuRef}
            className="ai-assist-slash-menu-container"
          >
            <ul
              id="ai-assist-slash-menu"
              className="ai-assist-slash-menu"
              role="listbox"
              aria-label={t("ai_assist_slash_menu_label", "Commands")}
            >
              {slashMatches.map((command, index) => {
                const IconComponent = getSlashCommandIcon(command.id);
                const selectionUsed =
                  command.selection !== "none" && attachedSelection !== null;
                const isFrequent = topUsedIds.includes(command.id);
                const showFrequentHeader =
                  !slashQuery && index === 0 && isFrequent;
                const showAllHeader =
                  !slashQuery &&
                  topUsedIds.length > 0 &&
                  index > 0 &&
                  !isFrequent &&
                  topUsedIds.includes(slashMatches[index - 1].id);

                return (
                  <li key={command.id}>
                    {showFrequentHeader && (
                      <div className="ai-assist-slash-section-header">
                        <ClockCounterClockwise size={12} aria-hidden="true" />
                        <span>
                          {t(
                            "ai_assist_slash_recent_header",
                            "Frequently Used",
                          )}
                        </span>
                      </div>
                    )}
                    {showAllHeader && (
                      <div className="ai-assist-slash-section-header">
                        <span>
                          {t("ai_assist_slash_all_header", "All Commands")}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      id={slashOptionId(command)}
                      className={`ai-assist-slash-option ${index === activeSlash ? "is-active" : ""}`}
                      aria-selected={index === activeSlash}
                      onMouseEnter={() => setSlashIndex(index)}
                      onMouseMove={() => {
                        if (slashIndex !== index) {
                          setSlashIndex(index);
                        }
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickCommand(command)}
                    >
                      <span className="ai-assist-slash-option-icon">
                        <IconComponent size={16} aria-hidden="true" />
                      </span>
                      <div className="ai-assist-slash-option-content">
                        <div className="ai-assist-slash-option-top">
                          <span className="ai-assist-slash-menu-id">
                            /{command.id}
                          </span>
                          <span className="ai-assist-slash-menu-label">
                            {slashLabelFor(command)}
                          </span>
                          {command.argumentHint && (
                            <span className="ai-assist-slash-menu-args">
                              {command.argumentHint}
                            </span>
                          )}
                          <div className="ai-assist-slash-badges-wrapper">
                            {isFrequent && !slashQuery && (
                              <span
                                className="ai-assist-slash-badge ai-assist-slash-badge-frequent"
                                title="Frequently used"
                              >
                                <Lightning
                                  size={10}
                                  weight="fill"
                                  aria-hidden="true"
                                />
                              </span>
                            )}
                            {command.scope === "read" ? (
                              <span className="ai-assist-slash-badge ai-assist-slash-badge-readonly">
                                {t(
                                  "ai_assist_slash_badge_read_only",
                                  "read-only",
                                )}
                              </span>
                            ) : (
                              <span className="ai-assist-slash-badge ai-assist-slash-badge-edit">
                                {t(
                                  "ai_assist_slash_badge_edits",
                                  "edits files",
                                )}
                              </span>
                            )}
                            {selectionUsed && (
                              <span className="ai-assist-slash-badge ai-assist-slash-badge-selection">
                                {t(
                                  "ai_assist_slash_badge_uses_selection",
                                  "uses selection",
                                )}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="ai-assist-slash-menu-desc">
                          {slashDescriptionFor(command)}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="ai-assist-slash-footer" aria-hidden="true">
              <span className="ai-assist-slash-footer-item">
                <kbd>
                  <ArrowUp size={9} />
                  <ArrowDown size={9} />
                </kbd>{" "}
                {t("ai_assist_slash_nav_hint", "Navigate")}
              </span>
              <span className="ai-assist-slash-footer-item">
                <kbd>
                  <ArrowBendDownLeft size={9} />
                </kbd>{" "}
                {t("ai_assist_slash_select_hint", "Select")}
              </span>
              <span className="ai-assist-slash-footer-item">
                <kbd>Tab</kbd>{" "}
                {t("ai_assist_slash_complete_hint", "Complete")}
              </span>
              <span className="ai-assist-slash-footer-item">
                <kbd>Esc</kbd>{" "}
                {t("ai_assist_slash_dismiss_hint", "Dismiss")}
              </span>
            </div>
          </div>
        )}

        {slashCommand && (
          <div className="ai-assist-slash-hint">
            <span className="ai-assist-slash-hint-label">
              {slashLabelFor(slashCommand.command)}
            </span>
            {slashCommand.command.argumentHint && (
              <span
                className={`ai-assist-slash-hint-args ${slashMissing ? "is-missing" : ""}`}
              >
                {slashCommand.command.argumentHint}
              </span>
            )}
          </div>
        )}

        {pdfTurn.boxSelecting && (
          <div className="ai-assist-pdf-box-hint" role="status">
            {t("ai_assist_pdf_area_drawing", "Drag a box on the PDF · Esc to cancel")}
          </div>
        )}

        {(attachedSelection ||
          attachments.length > 0 ||
          images.length > 0 ||
          hasPdfChips) && (
          <div className="ai-assist-selection-chip-wrapper">
            {attachedSelection &&
              (attachedSelection.ranges && attachedSelection.ranges.length > 1
                ? attachedSelection.ranges.map((range, index) => (
                    <ContextChip
                      key={`attached-range-${index}-${range.from}-${range.to}`}
                      icon={<CodeIcon />}
                      source={attachedSelection.path}
                      detail={`${range.from}-${range.to}`}
                      removeLabel={t("remove_selection", "Remove selection")}
                      onRemove={() => removeSelectionRange(index)}
                    />
                  ))
                : (
                    <ContextChip
                      icon={<CodeIcon />}
                      source={attachedSelection.path}
                      detail={`${attachedSelection.from}-${attachedSelection.to}`}
                      removeLabel={t("remove_selection", "Remove selection")}
                      onRemove={() => setAttachedSelection(null)}
                    />
                  ))}
            {attachments.map((attachment, index) => (
              <ContextChip
                key={`${attachment.path}-${index}`}
                icon={<FileText size={12} />}
                source={attachment.path}
                detail={
                  attachment.from != null && attachment.to != null
                    ? `${attachment.from}-${attachment.to}`
                    : undefined
                }
                removeLabel={t("remove_attachment", "Remove attachment")}
                onRemove={() =>
                  setAttachments((current) =>
                    current.filter((_unused, at) => at !== index),
                  )
                }
              />
            ))}
            {images.map((img, index) => (
              <ContextChip
                key={`img-${index}-${img.name}`}
                className="ai-assist-image-chip"
                thumbnail={`data:${img.mediaType};base64,${img.data}`}
                source={t("ai_assist_image_chip_source", "Image")}
                detail={`${img.name} · ${formatBytes(img.size)}`}
                removeLabel={t("remove_image", "Remove image")}
                onRemove={() => removeImage(index)}
              />
            ))}
            <PdfContextChips />
          </div>
        )}

        <label
          htmlFor="ai-assist-composer-textarea"
          className="visually-hidden"
        >
          {t("ai_assist_composer_placeholder", "What would you like to do?")}
        </label>
        <div className="ai-assist-composer-input">
          {slashGhost && (
            // Mirrors the typed command so the hint sits right after it; the
            // placeholder cannot do this, as it only shows in an empty input
            <div className="ai-assist-slash-ghost" aria-hidden="true">
              <span>{value}</span>
              <span className="ai-assist-slash-ghost-hint">{slashGhost}</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            id="ai-assist-composer-textarea"
            value={value}
            disabled={disabled}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-controls={slashOpen ? "ai-assist-slash-menu" : undefined}
            aria-activedescendant={
              slashOpen ? slashOptionId(slashMatches[activeSlash]) : undefined
            }
            placeholder={
              disabled
                ? t(
                    "ai_assist_composer_no_provider_placeholder",
                    "Configure an AI provider in Account Settings to chat",
                  )
                : t(
                    "ai_assist_composer_placeholder",
                    "What would you like to do?",
                  )
            }
            rows={1}
          />
        </div>

        <div className="ai-assist-composer-actions">
          <div className="ai-assist-composer-left-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,image/*"
              onChange={handleFilesSelected}
              style={{ display: "none" }}
              tabIndex={-1}
              aria-hidden="true"
            />

            <div style={{ position: "relative", display: "inline-flex" }}>
              <button
                ref={plusBtnRef}
                type="button"
                className={`ai-assist-composer-plus-btn ${plusMenuOpen ? "is-active" : ""}`}
                aria-label={t("add_files_or_actions", "Add files or actions")}
                title={t("add_files_or_actions", "Add files or actions")}
                aria-expanded={plusMenuOpen}
                disabled={disabled}
                onMouseDown={(event) => {
                  if (plusMenuOpen) {
                    event.stopPropagation();
                  }
                }}
                onClick={() => setPlusMenuOpen((prev) => !prev)}
              >
                <Plus size={16} weight="bold" />
              </button>

              <ComposerPlusMenu
                isOpen={plusMenuOpen}
                onClose={() => setPlusMenuOpen(false)}
                onAddFiles={() => fileInputRef.current?.click()}
                onSlashCommands={handleSlashCommandsClick}
                chatId={chatId}
                onTogglePdfArea={
                  showPdfAreaButton && !disabled
                    ? () =>
                        pdfTurn.boxSelecting
                          ? cancelPdfBoxSelect()
                          : startPdfBoxSelect()
                    : undefined
                }
                pdfAreaSelecting={pdfTurn.boxSelecting}
              />
            </div>

            <OLDropdown
              drop="up"
              className="d-inline-flex"
              show={modeMenuOpen}
              onToggle={setModeMenuOpen}
              onKeyDown={onModeMenuKeyDown}
            >
              <OLDropdownToggle
                id="ai-assist-mode-toggle"
                as="button"
                className="ai-assist-mode-selector-btn"
                disabled={disabled}
                aria-label={t(
                  "ai_assist_select_mode",
                  "Select mode (Shift+Tab to cycle)",
                )}
              >
                <span className="ai-assist-mode-icon">
                  {currentModeConfig.icon}
                </span>
                <span className="ai-assist-mode-label">
                  {currentModeConfig.label}
                </span>
                <CaretUp
                  size={10}
                  weight="bold"
                  className="ai-assist-mode-caret"
                />
              </OLDropdownToggle>
              <OLDropdownMenu
                className="ai-assist-mode-menu"
                popperConfig={{
                  modifiers: [
                    {
                      name: "offset",
                      options: {
                        offset: [0, 6],
                      },
                    },
                    {
                      name: "preventOverflow",
                      options: {
                        altAxis: false,
                        mainAxis: false,
                      },
                    },
                  ],
                }}
              >
                <div className="ai-assist-mode-menu-header">Mode</div>
                {(["manual", "acceptEdits", "plan"] as AgentMode[]).map((m) => (
                  <OLDropdownItem
                    key={m}
                    className={`ai-assist-mode-menu-row ${m === (mode || "manual") ? "is-selected" : ""}`}
                    onClick={() => onModeChange?.(m)}
                  >
                    <span className="ai-assist-mode-item-icon">
                      {modeConfig[m].icon}
                    </span>
                    <div className="ai-assist-mode-item-content">
                      <span className="ai-assist-mode-item-title">
                        {modeConfig[m].label}
                      </span>
                      <span className="ai-assist-mode-item-desc">
                        {modeConfig[m].desc}
                      </span>
                    </div>
                    <span className="ai-assist-mode-item-num">
                      {modeConfig[m].num}
                    </span>
                  </OLDropdownItem>
                ))}
              </OLDropdownMenu>
            </OLDropdown>

          </div>

          <div className="ai-assist-composer-right-actions">
            <ReasoningEffortPicker />
            <ChatSendButton
              running={running && !hasContent}
              canSend={hasContent && !disabled}
              sendLabel={sendLabel}
              onSend={send}
              onStop={onStop}
            />
          </div>
        </div>
      </div>
      <p className="ai-assist-disclaimer">
        {t(
          "ai_assist_disclaimer",
          "AI can make mistakes. Always check responses.",
        )}
      </p>
    </div>
  );
}
