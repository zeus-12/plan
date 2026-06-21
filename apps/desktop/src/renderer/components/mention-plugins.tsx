import {
  useCallback,
  useEffect,
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
import { FileIcon, FolderIcon } from "./file-icon";
import { $createReferenceNode } from "./reference-node";
import { menuOpened, menuClosed } from "./mention-menu-state";
import {
  loadFileIndex,
  loadSkillIndex,
  searchFiles,
  searchSkills,
  type FileEntry,
} from "./mention-data";
import type { SkillInfo } from "../../shared-types";

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

const MENU_MAX_H = 280;
const MENU_GAP = 6;

/**
 * Shared popover chrome. The composer sits at the bottom of the window, and
 * Lexical's built-in menu flip only considers room *inside* the (tiny)
 * contenteditable, so it never flips and the menu overflows the viewport.
 * Instead we position the menu ourselves with `fixed`, measuring the caret
 * anchor and opening upward whenever there isn't room below — like ChatGPT.
 */
function MenuShell({
  anchor,
  children,
}: {
  anchor: HTMLElement;
  children: ReactNode;
}) {
  const rect = anchor.getBoundingClientRect();
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

  return createPortal(
    <ul
      style={style}
      className="z-[70] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-xl"
    >
      {children}
    </ul>,
    anchor,
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
export function FileMentionPlugin({ projectEncoded }: { projectEncoded: string }) {
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
      if (alive) setOptions(searchFiles(idx, query).map((e) => new FileOption(e)));
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
    (option: FileOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
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
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && options.length > 0 ? (
          <MenuShell anchor={anchorRef.current}>
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
export function SkillMentionPlugin({ projectEncoded }: { projectEncoded: string }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<SkillOption[]>([]);

  useEffect(() => {
    if (query === null) {
      setOptions([]);
      return;
    }
    let alive = true;
    void loadSkillIndex(projectEncoded).then((idx) => {
      if (alive) setOptions(searchSkills(idx, query).map((s) => new SkillOption(s)));
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
    (option: SkillOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const ref = $createReferenceNode("skill", option.skill.name);
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
    <LexicalTypeaheadMenuPlugin<SkillOption>
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      onOpen={menuOpened}
      onClose={menuClosed}
      triggerFn={triggerFn}
      options={options}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current && options.length > 0 ? (
          <MenuShell anchor={anchorRef.current}>
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
                title={opt.skill.name}
                subtitle={opt.skill.description || undefined}
                badge={
                  opt.skill.source === "project"
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
