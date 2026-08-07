/** Ordered-panel operations both apps implement identically. */

export function movePanel<T>(panels: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= panels.length || toIndex >= panels.length) {
    return panels;
  }
  const next = [...panels];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function insertPanelRight<T>(panels: T[], focused: number, panel: T): { panels: T[]; focus: number } {
  const insertAt = Math.min(Math.max(0, focused + 1), panels.length);
  const nextPanels = [...panels];
  nextPanels.splice(insertAt, 0, panel);
  return { panels: nextPanels, focus: insertAt };
}
