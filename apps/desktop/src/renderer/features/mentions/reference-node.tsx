import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMConversionMap,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { type ReactNode } from "react";
import { cn } from "@plan/shared/lib/utils";
import { basename } from "@plan/shared/lib/path";
import { FileIcon, FolderIcon } from "@/renderer/components/file-icon";

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
  const label = kind === "skill" ? value : basename(value);
  const isSkill = kind === "skill";

  // Clicking a chip used to open an edit/remove menu. It now just drops the
  // caret after the chip — Backspace deletes it, typing continues the sentence.
  // The menu had nowhere to go inside a comment popover, and "edit" only ever
  // meant "remove, then retype", which Backspace already does.
  const placeCaretAfter = () => {
    editor.update(() => {
      $getNodeByKey(nodeKey)?.selectNext(0, 0);
    });
    editor.focus();
  };

  return (
    <span
      // Not a button: there is nothing to open. The editor owns the caret, and
      // preventDefault keeps the mousedown from collapsing the selection we are
      // about to set.
      onMouseDown={(e) => {
        e.preventDefault();
        placeCaretAfter();
      }}
      title={isSkill ? `/${value}` : value}
      className={cn(
        "inline-flex max-w-[220px] cursor-text items-center gap-1 rounded-[5px] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[12px] leading-none transition-colors",
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
