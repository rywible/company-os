import React, { useRef, useState } from "react";
import { Bold, Italic, Heading2, List, Link, Code } from "lucide-react";

type Format = "bold" | "italic" | "heading" | "list" | "link" | "code";
const formats = [
  { key: "bold", label: "Bold", icon: Bold },
  { key: "italic", label: "Italic", icon: Italic },
  { key: "heading", label: "Heading", icon: Heading2 },
  { key: "list", label: "Bullet list", icon: List },
  { key: "link", label: "Link", icon: Link },
  { key: "code", label: "Code block", icon: Code },
] as const;

export function MarkdownEditor({
  value,
  change,
  preview,
  disabled,
}: {
  value: string;
  change(value: string): void;
  preview(value: string): React.ReactNode;
  disabled: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  function format(kind: Format) {
    const el = input.current;
    if (!el || disabled) return;
    let start = el.selectionStart,
      end = el.selectionEnd;
    let selected = el.value.slice(start, end);
    let before = "",
      after = "";
    if (kind === "heading" || kind === "list") {
      start = start === 0 ? 0 : el.value.lastIndexOf("\n", start - 1) + 1;
      selected = el.value.slice(start, end);
      before = kind === "heading" ? "## " : "- ";
      selected = (
        selected || (kind === "heading" ? "Heading" : "List item")
      ).replaceAll("\n", "\n" + before);
    } else {
      [before, after] =
        kind === "bold"
          ? ["**", "**"]
          : kind === "italic"
            ? ["_", "_"]
            : kind === "link"
              ? ["[", "](https://)"]
              : ["```\n", "\n```"];
      selected ||=
        kind === "link" ? "link text" : kind === "code" ? "code" : "text";
      if (kind === "code") {
        if (start > 0 && el.value[start - 1] !== "\n") before = "\n" + before;
        if (end < el.value.length && el.value[end] !== "\n") after += "\n";
      }
    }
    el.focus();
    el.setSelectionRange(start, end);
    // Native insertion keeps formatting in the textarea's undo history.
    const replacement = before + selected + after;
    if (!document.execCommand("insertText", false, replacement)) {
      el.setRangeText(replacement, start, end, "end");
    }
    change(el.value);
    el.setSelectionRange(
      start + before.length,
      start + before.length + selected.length,
    );
  }
  return (
    <section className="markdown-editor" aria-label="Markdown editor">
      <div className="markdown-toolbar">
        <div className="view-switch" role="group" aria-label="Editor view">
          <button
            type="button"
            aria-pressed={mode === "write"}
            onClick={() => setMode("write")}
          >
            Write
          </button>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
        </div>
        {mode === "write" && (
          <div
            className="format-tools"
            role="group"
            aria-label="Markdown formatting"
          >
            {formats.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                title={label}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => format(key)}
              >
                <Icon size={17} />
              </button>
            ))}
          </div>
        )}
      </div>
      <textarea
        ref={input}
        hidden={mode !== "write"}
        aria-label="Document content"
        placeholder="Start writing…"
        value={value}
        onChange={(e) => change(e.target.value)}
        disabled={disabled}
        maxLength={500000}
        spellCheck
        rows={16}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            ["b", "i", "k"].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            format(
              e.key.toLowerCase() === "b"
                ? "bold"
                : e.key.toLowerCase() === "i"
                  ? "italic"
                  : "link",
            );
          }
        }}
      />
      {mode === "preview" && (
        <div
          className="document-preview"
          role="region"
          aria-label="Document preview"
        >
          {value.trim() ? (
            preview(value)
          ) : (
            <p className="muted">Nothing to preview yet.</p>
          )}
        </div>
      )}
      <p className="markdown-hint">
        Markdown supported · ⌘ / Ctrl B for bold, I for italic
      </p>
    </section>
  );
}
