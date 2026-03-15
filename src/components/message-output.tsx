"use client";

import { useState } from "react";
import type { PlanVersion } from "@/lib/store";
import { generateMessage } from "@/lib/store";

interface MessageOutputProps {
  version: PlanVersion;
}

export function MessageOutput({ version }: MessageOutputProps) {
  const [copied, setCopied] = useState(false);
  const message = generateMessage(version);

  if (!message) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="rounded-lg border"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="font-[family-name:var(--font-mono)] text-xs"
          style={{ color: "var(--text-tertiary)" }}
        >
          {version.annotations.length} change
          {version.annotations.length !== 1 ? "s" : ""} — ready to send
        </span>
        <button
          onClick={handleCopy}
          className="rounded-md px-4 py-1.5 font-[family-name:var(--font-mono)] text-xs font-medium transition-all"
          style={{
            background: copied ? "var(--diff-add-bar)" : "var(--accent)",
            color: copied ? "#fff" : "var(--bg)",
          }}
        >
          {copied ? "Copied!" : "Copy to clipboard"}
        </button>
      </div>
      <pre
        className="max-h-[300px] overflow-y-auto whitespace-pre-wrap p-4 font-[family-name:var(--font-mono)] text-[13px] leading-relaxed"
        style={{ color: "var(--text)" }}
      >
        {message}
      </pre>
    </div>
  );
}
