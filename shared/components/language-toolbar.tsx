"use client";

import { useCallback, useState } from "react";
import { LANGUAGES } from "../lib/highlight";
import { canFormat } from "../lib/format";
import { Button } from "./ui/button";

interface Props {
  language: string;
  onLanguageChange: (id: string) => void;
  detectedLanguage?: string | null;
  /** If provided, the Format button is shown and clicking it calls this. */
  onFormat?: () => Promise<void> | void;
  formatDisabled?: boolean;
}

export function LanguageToolbar({
  language,
  onLanguageChange,
  detectedLanguage,
  onFormat,
  formatDisabled,
}: Props) {
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);

  const handleFormat = useCallback(async () => {
    if (!onFormat) return;
    setFormatting(true);
    setFormatError(null);
    try {
      await onFormat();
    } catch (err) {
      setFormatError(err instanceof Error ? err.message : String(err));
    } finally {
      setFormatting(false);
    }
  }, [onFormat]);

  const effectiveLang =
    language === "auto" && detectedLanguage ? detectedLanguage : language;
  const formatAvailable = canFormat(effectiveLang);

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="cursor-pointer appearance-none rounded-md border bg-transparent px-2.5 py-1 pr-6 font-[family-name:var(--font-mono)] text-[11px] focus:outline-none focus:ring-1 focus:ring-[var(--border-strong)]"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 4px center",
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.id === "auto" && detectedLanguage
                ? `Auto · ${detectedLanguage}`
                : l.label}
            </option>
          ))}
        </select>
      </div>

      {onFormat && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleFormat}
          disabled={!formatAvailable || formatting || formatDisabled}
          title={
            !formatAvailable
              ? `No formatter for ${effectiveLang}`
              : formatError ?? "Format with Prettier"
          }
        >
          {formatting ? "Formatting…" : "Format"}
        </Button>
      )}
    </div>
  );
}
