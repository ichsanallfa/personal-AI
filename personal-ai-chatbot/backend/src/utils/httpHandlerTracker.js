import express from "express";

const activeHandlerPromises = new Set();
let isTrackingInitialized = false;

/**
 * Global HTTP asynchronous handler tracking for Express.
 * Wraps Route Layer dispatching to track the actual Promise returned by
 * async route handlers until they settle (fulfill or reject).
 * Does NOT rely on res.close, res.finish, or socket lifecycle.
 */
export const initHttpHandlerTracking = () => {
  if (isTrackingInitialized) return;
  isTrackingInitialized = true;

  const dummyRouter = express.Router();
  dummyRouter.get("/", () => {});
  const Layer = dummyRouter.stack[0].constructor;

  const origHandleRequest = Layer.prototype.handleRequest;
  const origHandleError = Layer.prototype.handleError;

  Layer.prototype.handleRequest = function (req, res, next) {
    const fn = this.handle;
    if (fn && fn.length <= 3 && !fn.__lucyTracked) {
      const wrapped = function (req, res, next) {
        const ret = fn.call(this, req, res, next);
        if (ret && typeof ret.then === "function") {
            const tracked = Promise.resolve(ret).catch(() => {}).finally(() => {
            activeHandlerPromises.delete(tracked);
          });
          activeHandlerPromises.add(tracked);
        }
        return ret;
      };
      wrapped.__lucyTracked = true;
      this.handle = wrapped;
    }
    return origHandleRequest.call(this, req, res, next);
  };

  Layer.prototype.handleError = function (error, req, res, next) {
    const fn = this.handle;
    if (fn && fn.length === 4 && !fn.__lucyTracked) {
      const wrapped = function (err, req, res, next) {
        const ret = fn.call(this, err, req, res, next);
        if (ret && typeof ret.then === "function") {
          const tracked = Promise.resolve(ret).catch(() => {}).finally(() => {
            activeHandlerPromises.delete(tracked);
          });
          activeHandlerPromises.add(tracked);
        }
        return ret;
      };
      wrapped.__lucyTracked = true;
      this.handle = wrapped;
    }
    return origHandleError.call(this, error, req, res, next);
  };
};

export const getActiveHandlersCount = () => activeHandlerPromises.size;

/**
 * Wait for all tracked asynchronous route handler promises to settle.
 * @param {number} timeoutMs Maximum time to wait in milliseconds.
 * @returns {Promise<boolean>} True if all handlers settled, false if timed out.
 */
export const waitForActiveHandlers = async (timeoutMs = 30000) => {
  if (activeHandlerPromises.size === 0) return true;

  const startTime = Date.now();
  while (activeHandlerPromises.size > 0) {
    const elapsed = Date.now() - startTime;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) break;

    const currentPromises = Array.from(activeHandlerPromises);
    if (currentPromises.length === 0) break;

    let timer;
    const timerPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(10, remaining));
      timer.unref?.();
    });

    await Promise.race([
      Promise.allSettled(currentPromises),
      timerPromise,
    ]);
    clearTimeout(timer);
  }

  return activeHandlerPromises.size === 0;
};

export const resetHandlerTrackingForTests = () => {
  activeHandlerPromises.clear();
};
