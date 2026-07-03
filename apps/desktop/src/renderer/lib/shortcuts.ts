/**
 * Canonical keyboard-shortcut reference, grouped by the surface you're on when
 * you press the key. This is the SINGLE place a shortcut's human label lives —
 * the shortcuts modal renders from here, and anywhere else that names a shortcut
 * (button tooltips, menu labels) should reuse `label` from this list rather than
 * spelling it out again.
 *
 * NOTE: this is a DISPLAY source, not the matcher. The actual keydown handlers
 * still live next to the features they drive (project-workspace, App, terminal,
 * …). Keep an entry here in sync when you add or change a handler — the labels
 * and keys shown to users are only as honest as this file.
 */

export type Mod = "ctrl" | "alt" | "shift" | "meta";

export interface Chord {
  mods?: Mod[];
  /** The display key: "D", "Tab", "/", "Enter", "Esc", "`", "←", "1". */
  key: string;
}

export interface Shortcut {
  id: string;
  /** Canonical human label — reused everywhere this action is named. */
  label: string;
  /** One or more key combinations that trigger it (alternates / next+prev). */
  chords: Chord[];
  /** When it applies, shown muted next to the label (e.g. "chat selected"). */
  when?: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  shortcuts: Shortcut[];
}

// ── Rendering helpers ───────────────────────────────────────────────────────

const MAC_GLYPHS: Record<Mod, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const WIN_LABELS: Record<Mod, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
};

// Conventional macOS modifier order: ⌃ ⌥ ⇧ ⌘.
const MOD_ORDER: Mod[] = ["ctrl", "alt", "shift", "meta"];

function isMac(): boolean {
  if (typeof navigator === "undefined") return true; // mac-first default
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Tokens to render as individual <kbd> chips for one chord, modifiers first. */
export function chordTokens(chord: Chord): string[] {
  const mac = isMac();
  const mods = (chord.mods ?? [])
    .slice()
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
    .map((m) => (mac ? MAC_GLYPHS[m] : WIN_LABELS[m]));
  return [...mods, chord.key];
}

// ── The registry ────────────────────────────────────────────────────────────

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: "global",
    title: "Global",
    shortcuts: [
      {
        id: "showShortcuts",
        label: "Show keyboard shortcuts",
        chords: [{ mods: ["meta"], key: "/" }],
      },
      {
        id: "settings",
        label: "Open settings",
        chords: [{ mods: ["meta"], key: "," }],
      },
      {
        id: "toggleWorktreesRail",
        label: "Toggle worktrees rail",
        chords: [{ mods: ["meta"], key: "D" }],
      },
      {
        id: "cycleTabs",
        label: "Cycle open tabs (next / prev)",
        chords: [
          { mods: ["ctrl"], key: "Tab" },
          { mods: ["ctrl", "shift"], key: "Tab" },
        ],
      },
      {
        id: "cycleProjects",
        label: "Cycle projects (next / prev)",
        chords: [
          { mods: ["ctrl"], key: "`" },
          { mods: ["ctrl", "shift"], key: "`" },
        ],
      },
      {
        id: "cycleWorktrees",
        label: "Cycle worktrees (next / prev)",
        chords: [
          { mods: ["ctrl"], key: "1" },
          { mods: ["ctrl", "shift"], key: "1" },
        ],
      },
    ],
  },
  {
    id: "sidebar",
    title: "Sidebar",
    shortcuts: [
      {
        id: "listChat",
        label: "Chat list",
        chords: [{ mods: ["meta"], key: "1" }],
      },
      {
        id: "listDiffs",
        label: "Diffs list",
        chords: [{ mods: ["meta"], key: "2" }],
      },
      {
        id: "listFiles",
        label: "Files list",
        chords: [{ mods: ["meta"], key: "3" }],
      },
      {
        id: "listSearch",
        label: "Search list",
        chords: [
          { mods: ["meta"], key: "4" },
          { mods: ["meta", "shift"], key: "F" },
        ],
      },
      {
        id: "toggleTerminalPane",
        label: "Toggle terminal pane",
        chords: [{ mods: ["meta"], key: "T" }],
      },
    ],
  },
  {
    id: "chats",
    title: "Chats",
    shortcuts: [
      {
        id: "newChat",
        label: "New chat",
        chords: [{ mods: ["meta"], key: "N" }],
      },
      {
        id: "focusComposer",
        label: "Focus composer / resume chat",
        chords: [{ mods: ["meta"], key: "L" }],
      },
      {
        id: "switchChatPalette",
        label: "Switch-chat palette",
        chords: [{ mods: ["meta"], key: "K" }],
      },
      {
        id: "quickOpenFile",
        label: "Quick-open file",
        chords: [{ mods: ["meta"], key: "P" }],
      },
      {
        id: "closeTab",
        label: "Close active tab",
        chords: [{ mods: ["meta"], key: "W" }],
      },
      {
        id: "archiveChat",
        label: "Archive chat",
        chords: [{ mods: ["meta", "shift"], key: "A" }],
        when: "chat selected",
      },
      {
        id: "renameChat",
        label: "Rename chat",
        chords: [{ mods: ["meta", "shift"], key: "R" }],
        when: "chat selected",
      },
    ],
  },
  {
    id: "composer",
    title: "Chat composer",
    shortcuts: [
      { id: "send", label: "Send message", chords: [{ key: "Enter" }] },
      {
        id: "newline",
        label: "Insert newline",
        chords: [{ mods: ["shift"], key: "Enter" }],
      },
      {
        id: "undoComposer",
        label: "Undo add-to-chat / restore last sent",
        chords: [{ mods: ["meta"], key: "Z" }],
      },
    ],
  },
  {
    id: "filesDiffs",
    title: "Files & diffs",
    shortcuts: [
      {
        id: "findInView",
        label: "Find in view",
        chords: [{ mods: ["meta"], key: "F" }],
      },
      {
        id: "goToSymbol",
        label: "Go to symbol",
        chords: [{ mods: ["meta", "shift"], key: "O" }],
        when: "file view",
      },
      {
        id: "cycleDiff",
        label: "Cycle file ⇄ unstaged ⇄ staged",
        chords: [{ mods: ["meta", "shift"], key: "D" }],
      },
      {
        id: "undoHunk",
        label: "Undo last hunk",
        chords: [{ mods: ["meta"], key: "Z" }],
        when: "diff view",
      },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    shortcuts: [
      {
        id: "toggleTerminal",
        label: "Toggle terminal",
        chords: [{ mods: ["meta"], key: "J" }],
      },
      {
        id: "newShell",
        label: "New shell",
        chords: [{ mods: ["meta", "shift"], key: "T" }],
      },
      {
        id: "clearTerminal",
        label: "Clear terminal",
        chords: [{ mods: ["meta"], key: "K" }],
      },
      {
        id: "closeShell",
        label: "Close scratch shell",
        chords: [{ mods: ["meta"], key: "W" }],
      },
      {
        id: "closeTerminalPanel",
        label: "Close terminal panel",
        chords: [{ key: "Esc" }],
      },
    ],
  },
  {
    id: "findDialogs",
    title: "Find & dialogs",
    shortcuts: [
      {
        id: "matchNav",
        label: "Next / previous match",
        chords: [{ key: "Enter" }, { mods: ["shift"], key: "Enter" }],
      },
      {
        id: "confirmDialog",
        label: "Confirm (commit, PR, worktree…)",
        chords: [{ mods: ["meta"], key: "Enter" }],
      },
      {
        id: "cancelDialog",
        label: "Cancel / close",
        chords: [{ key: "Esc" }],
      },
    ],
  },
];
