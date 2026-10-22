import React, { useCallback, useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ClockCounterClockwise,
  Trash,
  PencilSimple,
  Check,
  X,
} from "@phosphor-icons/react";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import { useFloatingBox } from "../../floating/use-floating-box";
import { ChatSummary, listChats } from "../../agent/chat-history-client";

const TIME_FORMAT = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
});
const DATE_FORMAT = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
});

function formatWhen(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? TIME_FORMAT.format(date)
    : DATE_FORMAT.format(date);
}

/**
 * The chat history menu in the panel header. The menu floats under its
 * toggle through the panel-tracking engine, so it follows the toggle,
 * and the header around it, while the panel is resized.
 */
export function ChatHistoryMenu({
  projectId,
  activeChatId,
  onOpen,
  onDelete,
  onRename,
}: {
  projectId: string;
  activeChatId: string;
  onOpen: (chatId: string, summary: ChatSummary) => void;
  onDelete: (chatId: string) => Promise<void>;
  onRename?: (chatId: string, newTitle: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const { refs, floatingStyles } = useFloatingBox({
    open,
    placement: "bottom-end",
    gap: 8,
  });

  useEffect(() => {
    if (editingChatId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingChatId]);

  const onToggle = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setEditingChatId(null);
        return;
      }
      setFailed(false);
      listChats(projectId)
        .then(setChats)
        .catch(() => setFailed(true));
    },
    [projectId],
  );

  // The toggle is rendered in the header, above this menu; hand its
  // element to the engine as the anchor.
  useEffect(() => {
    if (open && toggleRef.current) {
      refs.setReference(toggleRef.current);
    }
  }, [open, refs]);

  const setMenu = useCallback(
    (node: HTMLUListElement | null) => {
      menuRef.current = node;
      refs.setFloating(node);
    },
    [refs],
  );

  // Closing on everything but this menu and the toggle: clicks inside it,
  // such as the rename input, must not be eaten by root-close.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (
        menuRef.current?.contains(node) ||
        toggleRef.current?.contains(node)
      ) {
        return;
      }
      setOpen(false);
      setEditingChatId(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setEditingChatId(null);
    toggleRef.current?.focus();
  }, []);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeMenu();
  };

  const commitRename = useCallback(
    (id: string) => {
      const trimmed = editTitle.trim();
      setEditingChatId(null);
      const previous = chats?.find((c) => c.id === id)?.title;
      if (!onRename || previous === undefined) return;
      if (!trimmed || trimmed === previous) return;
      const retitle = (from: string, to: string) =>
        setChats((current) =>
          current
            ? current.map((c) =>
                c.id === id && c.title === from ? { ...c, title: to } : c,
              )
            : current,
        );
      // Shown at once; put back if the server does not save it
      retitle(previous, trimmed);
      onRename(id, trimmed).catch(() => retitle(trimmed, previous));
    },
    [chats, editTitle, onRename],
  );

  const label = t("ai_assist_chat_history", "Chat history");

  return (
    <>
      <OLTooltip
        id="ai-assist-history-tooltip"
        description={label}
        overlayProps={{ placement: "bottom" }}
        hidden={open}
      >
        <span>
          <button
            id="ai-assist-history-toggle"
            ref={toggleRef}
            type="button"
            className="btn icon-button-small rail-panel-header-button-subdued d-inline-flex align-items-center justify-content-center ai-assist-history-toggle"
            aria-haspopup="true"
            aria-expanded={open}
            aria-label={label}
            onClick={() => onToggle(!open)}
          >
            <ClockCounterClockwise size={18} />
          </button>
        </span>
      </OLTooltip>
      {open && (
        <ul
          ref={setMenu}
          style={floatingStyles}
          className="ai-assist-history-menu"
          role="menu"
          aria-labelledby="ai-assist-history-toggle"
          onKeyDown={onMenuKeyDown}
        >
          {failed ? (
            <li className="ai-assist-history-empty">
              {t(
                "ai_assist_chat_history_failed",
                "Could not load chat history",
              )}
            </li>
          ) : chats === null ? (
            <li className="ai-assist-history-empty">
              {t("loading", "Loading")}…
            </li>
          ) : chats.length === 0 ? (
            <li className="ai-assist-history-empty">
              {t("ai_assist_chat_history_empty", "No saved chats yet")}
            </li>
          ) : (
            chats.map((chat) => {
              const isActive = chat.id === activeChatId;
              const isEditingThis = editingChatId === chat.id;
              return (
                <li
                  key={chat.id}
                  className={`ai-assist-history-row ${isActive ? "is-active" : ""}`}
                >
                  {isEditingThis ? (
                    <div className="ai-assist-history-edit-row">
                      <input
                        ref={inputRef}
                        type="text"
                        className="ai-assist-history-edit-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(chat.id);
                          if (e.key === "Escape") setEditingChatId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        maxLength={60}
                      />
                      <button
                        type="button"
                        className="ai-assist-history-edit-btn ai-assist-history-edit-confirm"
                        aria-label={t("save", "Save")}
                        onClick={(e) => {
                          e.stopPropagation();
                          commitRename(chat.id);
                        }}
                      >
                        <Check size={14} weight="bold" />
                      </button>
                      <button
                        type="button"
                        className="ai-assist-history-edit-btn ai-assist-history-edit-cancel"
                        aria-label={t("cancel", "Cancel")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingChatId(null);
                        }}
                      >
                        <X size={14} weight="bold" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ai-assist-history-item-btn"
                        onClick={() => {
                          setOpen(false);
                          onOpen(chat.id, chat);
                        }}
                        title={
                          chat.title ||
                          t("ai_assist_untitled_chat", "Untitled chat")
                        }
                      >
                        <span className="ai-assist-history-title">
                          {chat.title ||
                            t("ai_assist_untitled_chat", "Untitled chat")}
                        </span>
                        <span className="ai-assist-history-when">
                          {formatWhen(chat.updatedAt)}
                        </span>
                      </button>
                      <div className="ai-assist-history-actions">
                        {onRename && (
                          <button
                            type="button"
                            className="ai-assist-history-rename"
                            aria-label={t("rename", "Rename")}
                            title={t("rename", "Rename")}
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingChatId(chat.id);
                              setEditTitle(chat.title || "");
                            }}
                          >
                            <PencilSimple size={14} weight="bold" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="ai-assist-history-delete"
                          aria-label={t("delete", "Delete")}
                          title={t("delete", "Delete")}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDelete(chat.id)
                              .then(() =>
                                setChats((current) =>
                                  current
                                    ? current.filter((c) => c.id !== chat.id)
                                    : current,
                                ),
                              )
                              .catch(() => {
                                // Delete failed: the chat stays in the list
                              });
                          }}
                        >
                          <Trash size={15} weight="bold" />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </>
  );
}
