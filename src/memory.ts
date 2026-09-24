/** Tiny in-memory map whose entries expire after `ttlMs`. */
export class TtlMap<V> {
  private items = new Map<string | number, { value: V; expires: number }>();
  constructor(private ttlMs: number) {}

  get(key: string | number): V | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expires < Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key: string | number, value: V): void {
    this.items.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.items.size > 5000) this.sweep();
  }

  has(key: string | number): boolean {
    return this.get(key) !== undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.expires < now) this.items.delete(k);
  }
}
