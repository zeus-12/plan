import { useEffect } from "react";
import { cn } from "@plan/shared/lib/utils";
import { Switch } from "@plan/shared/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plan/shared/components/ui/select";
import {
  SOUND_OPTIONS,
  useNotificationSettings,
  type SoundId,
} from "../lib/notification-settings";
import { playSound } from "../lib/notification-sounds";
import { useAutoModeEnabled } from "../lib/auto-mode-settings";
import {
  PROSE_BRIGHTNESS,
  PROSE_FONTS,
  PROSE_SIZES,
  useTranscriptPrefs,
  type ProseBrightnessId,
  type ProseFontId,
} from "../lib/transcript-prefs";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Open the keyboard-shortcuts reference (a separate, focused modal). */
  onShowShortcuts: () => void;
}

/**
 * Settings modal — opened from the sidebar's gear button. Today it configures
 * the "session finished" notification: a master toggle and the chime preset.
 * Same overlay/panel shell as the sessions dashboard for visual consistency.
 */
export function SettingsModal({ open, onClose, onShowShortcuts }: Props) {
  const [settings, update] = useNotificationSettings();
  const [autoMode, setAutoMode] = useAutoModeEnabled();
  const [prose, setProse] = useTranscriptPrefs();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pickSound = (id: SoundId) => {
    update({ sound: id });
    playSound(id); // Preview the choice immediately.
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(480px,86vw)] flex-col overflow-hidden rounded-xl border border-[var(--popover-border)] bg-[var(--popover-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
            Settings
          </span>
          <button
            onClick={onClose}
            className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text)]"
          >
            esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <section className="mb-6 flex flex-col gap-3">
            <h3 className="font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--text)]">
              Reading
            </h3>
            <p className="-mt-1.5 text-[11px] text-[var(--text-tertiary)]">
              Font, size, and contrast for chat and PR text.
            </p>

            {/* Reading font. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Font
              </span>
              <Select
                value={prose.fontFamily}
                onValueChange={(v) => setProse({ fontFamily: v as ProseFontId })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROSE_FONTS.map((opt) => (
                    <SelectItem
                      key={opt.id}
                      value={opt.id}
                      style={{ fontFamily: opt.stack }}
                    >
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Size. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Text size
              </span>
              <Select
                value={String(prose.fontSize)}
                onValueChange={(v) => setProse({ fontSize: Number(v) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROSE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}px
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Contrast (text brightness against the reading background). */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Contrast
              </span>
              <Select
                value={prose.brightness}
                onValueChange={(v) =>
                  setProse({ brightness: v as ProseBrightnessId })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROSE_BRIGHTNESS.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Closes the section with a hairline rule. */}
            <div className="mt-2 h-px bg-[var(--border)]" />
          </section>

          <section className="mb-6 flex flex-col gap-3">
            <h3 className="font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--text)]">
              Auto mode
            </h3>

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[12px] text-[var(--text)]">
                  Run Claude Code in auto mode
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  New sessions start with{" "}
                  <code className="font-[family-name:var(--font-mono)] text-[10px]">
                    --permission-mode auto
                  </code>
                  .
                </span>
              </div>
              <Switch checked={autoMode} onCheckedChange={setAutoMode} />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--text)]">
              Notifications
            </h3>

            {/* Master toggle. */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[12px] text-[var(--text)]">
                  Notify when a session finishes
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  Any running Claude session, whether or not it&apos;s on
                  screen.
                </span>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(on) => update({ enabled: on })}
              />
            </div>

            {/* Sound picker. */}
            <div
              className={cn(
                "flex flex-col gap-1.5",
                !settings.enabled && "pointer-events-none opacity-40",
              )}
            >
              <span className="text-[11px] text-[var(--text-tertiary)]">
                Sound
              </span>
              <Select
                value={settings.sound}
                onValueChange={(v) => pickSound(v as SoundId)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_OPTIONS.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="mt-6 flex flex-col gap-3">
            <h3 className="font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--text)]">
              Keyboard shortcuts
            </h3>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-[12px] text-[var(--text)]">
                  View all keyboard shortcuts
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  Also reachable anywhere with{" "}
                  <code className="font-[family-name:var(--font-mono)] text-[10px]">
                    ⌘/
                  </code>
                  .
                </span>
              </div>
              <button
                onClick={onShowShortcuts}
                className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text)]"
              >
                Show
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
