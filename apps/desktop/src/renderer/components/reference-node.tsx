import {
  $applyNodeReplacement,
  $getNodeByKey,
  $createTextNode,
  DecoratorNode,
  type DOMConversionMap,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@plan/shared/lib/utils";
import { FileIcon, FolderIcon } from "./file-icon";

export type ReferenceKind = "file" | "folder" | "skill";

export type SerializedReferenceNode = Spread<
  { kind: ReferenceKind; value: string },
  SerializedLexicalNode
>;

/**
 * An inline, atomic "@file" / "@folder" / "/skill" chip. It renders as a styled
 * pill (icon + label) but its {@link getTextContent} is the literal token the
 * Claude Code TUI understands — `@path` or `/name` — so serializing the message
 * to plain text Just Works when it's pasted into the terminal.
 */
export class ReferenceNode extends DecoratorNode<ReactNode> {
  __kind: ReferenceKind;
  __value: string;

  static getType(): string {
    return "reference";
  }

  static clone(node: ReferenceNode): ReferenceNode {
    return new ReferenceNode(node.__kind, node.__value, node.__key);
  }

  constructor(kind: ReferenceKind, value: string, key?: NodeKey) {
    super(key);
    this.__kind = kind;
    this.__value = value;
  }

  /** The exact text pasted into the terminal — Claude's native @-/ syntax. */
  getTextContent(): string {
    return this.__kind === "skill" ? `/${this.__value}` : `@${this.__value}`;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.style.display = "inline-flex";
    // An inline-flex box's baseline is its bottom edge, which floats the pill
    // above the following text — center it on the line instead.
    span.style.verticalAlign = "middle";
    span.setAttribute("spellcheck", "false");
    return span;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(json: SerializedReferenceNode): ReferenceNode {
    return $createReferenceNode(json.kind, json.value);
  }

  exportJSON(): SerializedReferenceNode {
    return {
      ...super.exportJSON(),
      type: "reference",
      version: 1,
      kind: this.__kind,
      value: this.__value,
    };
  }

  static importDOM(): DOMConversionMap | null {
    // Chips never need to round-trip through pasted HTML; nothing to import.
    return null;
  }

  decorate(): ReactNode {
    return (
      <ReferenceChip
        kind={this.__kind}
        value={this.__value}
        nodeKey={this.getKey()}
      />
    );
  }
}

export function $createReferenceNode(
  kind: ReferenceKind,
  value: string,
): ReferenceNode {
  return $applyNodeReplacement(new ReferenceNode(kind, value));
}

/** Last path segment — what we actually show on a file/folder chip. */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ReferenceChip({
  kind,
  value,
  nodeKey,
}: {
  kind: ReferenceKind;
  value: string;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close the little action menu on any outside interaction.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const remove = () => {
    editor.update(() => {
      $getNodeByKey(nodeKey)?.remove();
    });
    setMenuOpen(false);
  };

  // "Edit" = drop the chip back to its trigger char so the picker reopens and
  // the reference can be re-chosen. Honest: it removes then lets you retype.
  const edit = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!node) return;
      const trigger = $createTextNode(kind === "skill" ? "/" : "@");
      node.replace(trigger);
      trigger.select(1, 1);
    });
    setMenuOpen(false);
  };

  const label = kind === "skill" ? value : basename(value);
  const isSkill = kind === "skill";

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        // Don't let the editor steal/blur selection before our click lands.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMenuOpen((o) => !o)}
        title={isSkill ? `/${value}` : value}
        className={cn(
          "inline-flex max-w-[220px] items-center gap-1 rounded-[5px] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[12px] leading-none transition-colors",
          isSkill
            ? "bg-[var(--accent)]/12 text-[var(--accent)] hover:bg-[var(--accent)]/20"
            : "bg-[var(--bg-surface-hover)] text-[var(--text)] hover:bg-[var(--border)]",
        )}
      >
        <span className="shrink-0 opacity-70">
          {kind === "file" ? (
            <FileIcon name={value} className="h-[13px] w-[13px]" />
          ) : kind === "folder" ? (
            <FolderIcon open={false} className="h-[13px] w-[13px]" />
          ) : (
            <SlashGlyph />
          )}
        </span>
        <span className="truncate">{label}</span>
      </button>

      {menuOpen && (
        <span className="absolute bottom-full left-0 z-50 mb-1 flex min-w-[180px] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-surface)] py-1 shadow-lg">
          <span className="truncate px-2.5 py-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)]">
            {isSkill ? `/${value}` : value}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={edit}
            className="px-2.5 py-1.5 text-left font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)] hover:bg-[var(--bg-surface-hover)]"
          >
            Edit
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={remove}
            className="px-2.5 py-1.5 text-left font-[family-name:var(--font-mono)] text-[12px] text-[var(--removed-text,#f87171)] hover:bg-[var(--bg-surface-hover)]"
          >
            Remove
          </button>
        </span>
      )}
    </span>
  );
}

function SlashGlyph() {
  return (
    <span className="font-[family-name:var(--font-mono)] text-[12px] font-semibold leading-none">
      /
    </span>
  );
}
