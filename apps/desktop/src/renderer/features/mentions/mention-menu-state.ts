import { useEffect, useId, useMemo } from "react";

/**
 * Which mention typeahead menus are currently open, across every editor on
 * screen. The chat composer's Enter handler reads this to defer to the menu
 * (select the option) instead of sending the message.
 *
 * Membership is keyed by plugin instance rather than counted: a menu is open or
 * it isn't, so a double open can't inflate the total, and — the reason this
 * isn't a counter — unmounting always releases the entry. Lexical's typeahead
 * fires `onClose` from its update listener but not on unmount, so a comment
 * popover dismissed with a half-typed `@foo` used to leak a permanent "open",
 * after which every Enter in the composer inserted a newline instead of sending.
 */
const openMenus = new Set<string>();

export function useMentionMenuFlag(): {
  onOpen: () => void;
  onClose: () => void;
} {
  const id = useId();
  useEffect(() => () => void openMenus.delete(id), [id]);
  return useMemo(
    () => ({
      onOpen: () => void openMenus.add(id),
      onClose: () => void openMenus.delete(id),
    }),
    [id],
  );
}

export function isMentionMenuOpen(): boolean {
  return openMenus.size > 0;
}
