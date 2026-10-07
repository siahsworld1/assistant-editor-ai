// Keyboard-shortcut hygiene shared by editor views.

/** Shortcuts never fire while the user is typing — in an input, a textarea,
 * a select, an editable region or anything announcing itself as a text box
 * (the Director prompt included). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']",
  );
}
