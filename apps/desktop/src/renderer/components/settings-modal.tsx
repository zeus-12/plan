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

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings modal — opened from the sidebar's gear button. Today it configures
 * the "session finished" notification: a master toggle and the chime preset.
 * Same overlay/panel shell as the sessions dashboard for visual consistency.
 */
export function SettingsModal({ open, onClose }: Props) {
  const [settings, update] = useNotificationSettings();
  const [autoMode, setAutoMode] = useAutoModeEnabled();

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
                  Any running Claude session, whether or not it&apos;s on screen.
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
        </div>
      </div>
    </div>
  );
}
