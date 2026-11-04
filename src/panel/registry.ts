/** Open session tabs of this window, keyed by session file path. */
export class PanelRegistry<Panel> {
  private readonly panels = new Map<string, Panel>();

  get(sessionPath: string): Panel | undefined {
    return this.panels.get(sessionPath);
  }

  add(sessionPath: string, panel: Panel): void {
    this.panels.set(sessionPath, panel);
  }

  /** With `panel`, removes the entry only if it still belongs to that panel. */
  remove(sessionPath: string, panel?: Panel): void {
    if (panel !== undefined && this.panels.get(sessionPath) !== panel) return;
    this.panels.delete(sessionPath);
  }

  rename(oldPath: string, newPath: string): void {
    const panel = this.panels.get(oldPath);
    if (panel === undefined) return;
    this.panels.delete(oldPath);
    this.panels.set(newPath, panel);
  }
}

/** Focuses the tab already showing `sessionPath`; only when there is none, opens a new one. */
export async function revealOrOpen<Panel extends { reveal(): void }>(
  registry: PanelRegistry<Panel>,
  sessionPath: string,
  open: () => Promise<Panel>,
): Promise<Panel> {
  const existing = registry.get(sessionPath);
  if (existing !== undefined) {
    existing.reveal();
    return existing;
  }
  return open();
}
