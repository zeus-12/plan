import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { $createTextNode, type TextNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { cn } from "@plan/shared/lib/utils";
import { FileIcon, FolderIcon } from "@/renderer/components/file-icon";
import { $createReferenceNode } from "./reference-node";
import { menuOpened, menuClosed } from "./mention-menu-state";
import {
  loadFileIndex,
  loadSkillIndex,
  searchFiles,
  searchSkills,
  type FileEntry,
} from "./mention-data";
import { searchBuiltinCommands, type BuiltinCommand } from "./builtin-commands";
import type { SkillInfo } from "@/common/shared-types";

class FileOption extends MenuOption {
  constructor(public entry: FileEntry) {
    super(entry.path);
  }
}

class SkillOption extends MenuOption {
  constructor(public skill: SkillInfo) {
    super(`skill:${skill.name}`);
  }
}

class CommandOption extends MenuOption {
  constructor(public command: BuiltinCommand) {
    super(`command:${command.name}`);
  }
}

/** The `/` menu mixes native commands (listed first) with on-disk skills. */
type SlashOption = CommandOption | SkillOption;

const MENU_MAX_H = 280;
const MENU_GAP = 6;

/**
 * Reads the caret's viewport rect — the live source of truth for where the menu
 * should anchor. We measure the DOM selection directly rather than Lexical's
 * anchor element: that anchor is created at the document origin and only moved
 * to the caret in `positionMenu` (a *parent* effect that runs after this child),
 * and it's reused across opens, so reading it races the positioning and can
 * return a stale or (0,0) rect — which is exactly what pinned the popover to the
 * top-left corner. The collapsed selection, by contrast, is always at the caret.
 *
 * Re-measured after every commit so the menu follows the caret as the query
 * grows, plus on scroll/resize while it's open.
 */
function useCaretRect(): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const measure = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    // A collapsed range with no laid-out geometry yet — don't anchor to (0,0).
    if (r.top === 0 && r.left === 0 && r.width === 0 && r.height === 0) return;
    setRect((prev) =>
      prev &&
      prev.top === r.top &&
      prev.left === r.left &&
      prev.bottom === r.bottom &&
      prev.right === r.right
        ? prev
        : r,
    );
  }, []);

  // No deps: re-run after every render so the rect tracks the caret per keystroke.
  useLayoutEffect(measure);

  useLayoutEffect(() => {
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [measure]);

  return rect;
}

/**
 * Shared popover chrome. The composer sits at the bottom of the window, and
 * Lexical's built-in menu flip only considers room *inside* the (tiny)
 * contenteditable, so it never flips and the menu overflows the viewport.
 * Instead we position the menu ourselves with `fixed`, measuring the caret
 * ({@link useCaretRect}) and opening upward when there's no room below — like
 * ChatGPT.
 */
function MenuShell({ children }: { children: ReactNode }) {
  const rect = useCaretRect();

  if (!rect) return null;

  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUp = spaceBelow < MENU_MAX_H && spaceAbove > spaceBelow;

  const width = Math.min(440, Math.round(window.innerWidth * 0.72));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const maxHeight = Math.max(
    120,
    Math.min(MENU_MAX_H, (openUp ? spaceAbove : spaceBelow) - MENU_GAP - 8),
  );

  const style: CSSProperties = openUp
    ? {
        position: "fixed",
        left,
        width,
        bottom: window.innerHeight - rect.top + MENU_GAP,
        maxHeight,
      }
    : {
        position: "fixed",
        left,
        width,
        top: rect.bottom + MENU_GAP,
        maxHeight,
      };

  // Portal to <body>, not into the anchor: the menu is `fixed` so it needn't
  // live inside it, and as the anchor's only child Lexical's positionMenu would
  // otherwise reposition the anchor from *our* menu's size — a feedback loop.
  return createPortal(
    <ul
      style={style}
      className="z-[70] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-xl"
    >
      {children}
    </ul>,
    document.body,
  );
}

function Row({
  option,
  selected,
  onSelect,
  onHighlight,
  icon,
  title,
  subtitle,
  badge,
}: {
  option: MenuOption;
  selected: boolean;
  onSelect: () => void;
  onHighlight: () => void;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
}) {
  return (
    <li
      role="option"
      aria-selected={selected}
      ref={(el) => option.setRefElement(el)}
      onMouseEnter={onHighlight}
      // Keep editor focus/selection so the insert lands on the right node.
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
        selected && "bg-[var(--bg-surface-hover)]",
      )}
    >
      <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="shrink-0 truncate font-[family-name:var(--font-mono)] text-[12px] text-[var(--text)]">
        {title}
      </span>
      {subtitle && (
        <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-tertiary)]">
          {subtitle}
        </span>
      )}
      {badge && (
        <span className="ml-auto shrink-0 rounded border border-[var(--border)] px-1 py-px text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
          {badge}
        </span>
      )}
    </li>
  );
}

/**
 * `@` → fuzzy file/folder picker. `@` may appear anywhere (Claude Code resolves
 * `@path` references mid-message), so the trigger fires after start-or-whitespace.
 */
export function FileMentionPlugin({
  projectEncoded,
}: {
  projectEncoded: string;
}) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<FileOption[]>([]);

  useEffect(() => {
    if (query === null) {
      setOptions([]);
      return;
    }
    let alive = true;
    void loadFileIndex(projectEncoded).then((idx) => {
      if (alive)
        setOptions(searchFiles(idx, query).map((e) => new FileOption(e)));
    });
    return () => {
      alive = false;
    };
  }, [query, projectEncoded]);

  const triggerFn = useCallback((text: string): MenuTextMatch | null => {
    const m = /(^|\s)@([\w./-]*)$/.exec(text);
    if (!m) return null;
    return {
      leadOffset: m.index + m[1].length,
      matchingString: m[2],
      replaceableString: `@${m[2]}`,
    };
  }, []);

  const onSelectOption = useCallback(
    (
      option: FileOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        const ref = $createReferenceNode(option.entry.kind, option.entry.path);
        if (nodeToReplace) nodeToReplace.replace(ref);
        const space = $createTextNode(" ");
        ref.insertAfter(space);
        space.select(1, 1);
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<FileOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={menuOpened}
      onClose={menuClosed}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        anchorRef.current && options.length > 0 ? (
          <MenuShell>
            {options.map((opt, i) => (
              <Row
                key={opt.key}
                option={opt}
                selected={selectedIndex === i}
                onHighlight={() => setHighlightedIndex(i)}
                onSelect={() => selectOptionAndCleanUp(opt)}
                icon={
                  opt.entry.kind === "folder" ? (
                    <FolderIcon open={false} />
                  ) : (
                    <FileIcon name={opt.entry.name} />
                  )
                }
                title={opt.entry.name}
                subtitle={opt.entry.path}
                badge={opt.entry.kind === "folder" ? "dir" : undefined}
              />
            ))}
          </MenuShell>
        ) : null
      }
    />
  );
}

/**
 * `/` → fuzzy skill/command picker. Fires after start-or-whitespace, like `@`.
 * Claude Code's TUI executes a `/name` command even mid-message (only its own
 * autocomplete popup is start-only), so a chip anywhere is a real invocation.
 */
export function SkillMentionPlugin({
  projectEncoded,
}: {
  projectEncoded: string;
}) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<SlashOption[]>([]);

  useEffect(() => {
    if (query === null) {
      setOptions([]);
      return;
    }
    let alive = true;
    // Native commands (e.g. `/branch`) rank above skills so they're one keystroke
    // away, then the fuzzy skill matches fill the rest.
    const commands = searchBuiltinCommands(query).map(
      (c) => new CommandOption(c),
    );
    void loadSkillIndex(projectEncoded).then((idx) => {
      if (alive)
        setOptions([
          ...commands,
          ...searchSkills(idx, query).map((s) => new SkillOption(s)),
        ]);
    });
    return () => {
      alive = false;
    };
  }, [query, projectEncoded]);

  const triggerFn = useCallback((text: string): MenuTextMatch | null => {
    const m = /(^|\s)\/([\w:-]*)$/.exec(text);
    if (!m) return null;
    return {
      leadOffset: m.index + m[1].length,
      matchingString: m[2],
      replaceableString: `/${m[2]}`,
    };
  }, []);

  const onSelectOption = useCallback(
    (
      option: SlashOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        // Both commands and skills serialize as `/name` (kind "skill" chip).
        const name =
          option instanceof CommandOption
            ? option.command.name
            : option.skill.name;
        const ref = $createReferenceNode("skill", name);
        if (nodeToReplace) nodeToReplace.replace(ref);
        const space = $createTextNode(" ");
        ref.insertAfter(space);
        space.select(1, 1);
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={menuOpened}
      onClose={menuClosed}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(
        anchorRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
      ) =>
        anchorRef.current && options.length > 0 ? (
          <MenuShell>
            {options.map((opt, i) => (
              <Row
                key={opt.key}
                option={opt}
                selected={selectedIndex === i}
                onHighlight={() => setHighlightedIndex(i)}
                onSelect={() => selectOptionAndCleanUp(opt)}
                icon={
                  <span className="font-[family-name:var(--font-mono)] text-[13px] font-semibold text-[var(--accent)]">
                    /
                  </span>
                }
                title={
                  opt instanceof CommandOption
                    ? opt.command.name
                    : opt.skill.name
                }
                subtitle={
                  opt instanceof CommandOption
                    ? opt.command.description
                    : opt.skill.description || undefined
                }
                badge={
                  opt instanceof CommandOption
                    ? "cmd"
                    : opt.skill.source === "project"
                      ? "proj"
                      : opt.skill.source === "plugin"
                        ? "plug"
                        : "user"
                }
              />
            ))}
          </MenuShell>
        ) : null
      }
    />
  );
}
