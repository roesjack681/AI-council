/** Layout consumers run next frame, outside the native observer's delivery cycle.
 * Keep the latest entry for every target; cancelling a pending batch must not drop other targets.
 * This module must execute before the component library constructs its shared observer.
 */
export function installFrameResizeObserver(): void {
  const NativeObserver = window.ResizeObserver;
  if (!NativeObserver) return;
  window.ResizeObserver = class FrameResizeObserver extends NativeObserver {
    private pending = new Map<Element, ResizeObserverEntry>();
    private frame = 0;
    constructor(callback: ResizeObserverCallback) {
      super((entries) => {
        for (const entry of entries) this.pending.set(entry.target, entry);
        if (this.frame) return;
        this.frame = window.requestAnimationFrame(() => {
          this.frame = 0;
          const batch = [...this.pending.values()];
          this.pending.clear();
          if (batch.length) callback.call(this, batch, this);
        });
      });
    }
    override unobserve(target: Element): void {
      this.pending.delete(target);
      super.unobserve(target);
    }
    override disconnect(): void {
      super.disconnect();
      this.pending.clear();
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  };
}

if (typeof window !== 'undefined') installFrameResizeObserver();
