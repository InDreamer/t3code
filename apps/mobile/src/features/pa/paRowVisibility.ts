/** A recycled row observes just its current key. Scrolling never invalidates the list itself. */
export class PaRowVisibility {
  private readonly visible = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  has(key: string) {
    return this.visible.has(key);
  }

  subscribe(key: string, listener: () => void) {
    const group = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, group);
    group.add(listener);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(key);
    };
  }

  update(changed: ReadonlyArray<{ key: string; isViewable: boolean }>) {
    for (const { key, isViewable } of changed) {
      if (this.visible.has(key) === isViewable) continue;
      if (isViewable) this.visible.add(key);
      else this.visible.delete(key);
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
  }
}
