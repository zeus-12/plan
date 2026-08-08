// Shared, module-level flag for whether a mention typeahead menu is open. The
// composer's Enter handler reads this to defer to the menu (select option)
// instead of sending the message. A counter tolerates the brief overlap when
// one menu closes as another opens.
let openCount = 0;

export function menuOpened(): void {
  openCount += 1;
}

export function menuClosed(): void {
  openCount = Math.max(0, openCount - 1);
}

export function isMentionMenuOpen(): boolean {
  return openCount > 0;
}
