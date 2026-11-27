/* Runs before the Vue module. Swallows the benign ResizeObserver loop ErrorEvent
 * that vueuc/Naive UI dispatches, which Chrome otherwise lists as an extension error. */
(function () {
  var noise = /ResizeObserver loop/i;

  var nativeDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      event &&
      event.type === 'error' &&
      typeof event.message === 'string' &&
      noise.test(event.message)
    ) {
      return true;
    }
    return nativeDispatch.call(this, event);
  };

  window.addEventListener(
    'error',
    function (event) {
      if (noise.test(event.message || '')) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true,
  );

  var NativeRO = window.ResizeObserver;
  if (!NativeRO) return;
  window.ResizeObserver = function (callback) {
    var frame = 0;
    return new NativeRO(function (entries, observer) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function () {
        callback(entries, observer);
      });
    });
  };
  window.ResizeObserver.prototype = NativeRO.prototype;
})();
