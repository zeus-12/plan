"use client";

import Link from "next/link";

type Section = "diff" | "doc";

const ITEMS: { id: Section; label: string; href: string }[] = [
  { id: "diff", label: "Diff", href: "/" },
  { id: "doc", label: "Doc", href: "/doc" },
];

/**
 * Segmented switch between the two tools, sitting next to the wordmark. The
 * hash payloads live on each route independently, so switching is a plain
 * navigation — no shared state to thread through.
 */
export function SectionNav({ current }: { current: Section }) {
  return (
    <nav
      className="flex items-center gap-0.5 rounded-md border p-0.5"
      style={{ borderColor: "var(--border)" }}
    >
      {ITEMS.map((item) => {
        const active = item.id === current;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="rounded px-2 py-0.5 font-[family-name:var(--font-mono)] text-[11px] transition-colors"
            style={{
              background: active ? "var(--bg-surface-hover)" : "transparent",
              color: active ? "var(--text)" : "var(--text-tertiary)",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
