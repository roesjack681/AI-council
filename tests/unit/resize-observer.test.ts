import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFrameResizeObserver } from '../../src/sidepanel/runtime/resize-observer';

describe('frame-batched UI resize observations', () => {
  afterEach(() => vi.unstubAllGlobals());
  function setup() {
    const observers: NativeObserver[] = [];
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    class NativeObserver {
      constructor(readonly notify: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(_target: Element) {}
      unobserve(_target: Element) {}
      disconnect() {}
    }
    vi.stubGlobal('window', {
      ResizeObserver: NativeObserver,
      requestAnimationFrame(callback: FrameRequestCallback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id: number) {
        frames.delete(id);
      },
    });
    installFrameResizeObserver();
    const callback = vi.fn<ResizeObserverCallback>();
    const observer = new window.ResizeObserver(callback);
    return {
      callback,
      observer,
      frames,
      notify: (entries: ResizeObserverEntry[]) => observers[0]!.notify(entries, observer),
      flush() {
        const batch = [...frames.values()];
        frames.clear();
        for (const frame of batch) frame(1);
      },
    };
  }
  const entry = (target: Element, width: number) =>
    ({ target, contentRect: { width } }) as ResizeObserverEntry;
  it('defers callbacks and keeps the latest entry for each target in a single frame', () => {
    const f = setup();
    const a = {} as Element,
      b = {} as Element;
    f.notify([entry(a, 10), entry(b, 20)]);
    f.notify([entry(a, 30)]);
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.frames.size).toBe(1);
    f.flush();
    expect(f.callback).toHaveBeenCalledExactlyOnceWith([entry(a, 30), entry(b, 20)], f.observer);
  });
  it('unobserve removes queued targets and disconnect cancels stale callbacks, then observe can restart', () => {
    const f = setup();
    const a = {} as Element,
      b = {} as Element;
    f.notify([entry(a, 10), entry(b, 20)]);
    f.observer.unobserve(a);
    f.flush();
    expect(f.callback).toHaveBeenLastCalledWith([entry(b, 20)], f.observer);
    f.notify([entry(b, 30)]);
    f.observer.disconnect();
    expect(f.frames.size).toBe(0);
    f.flush();
    expect(f.callback).toHaveBeenCalledTimes(1);
    f.observer.observe(a);
    f.notify([entry(a, 40)]);
    f.flush();
    expect(f.callback).toHaveBeenLastCalledWith([entry(a, 40)], f.observer);
  });
});
