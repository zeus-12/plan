"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useTheme } from "../theme-provider";

const Toaster = ({ ...props }: ToasterProps) => {
  const { isDark } = useTheme();

  return (
    <Sonner
      theme={isDark ? "dark" : "light"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover-bg)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--popover-border)",
          "--border-radius": "0.5rem",
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
