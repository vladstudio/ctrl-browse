// per-tab bookkeeping for tabs we've touched: debugger attach, execution
// contexts, load waiters, mouse position. One object per tab instead of
// parallel maps, so a closed or detached tab is cleaned up in one place.

/**
 * @typedef {object} LoadWaiter
 * @property {() => void} done
 * @property {(e: Error) => void} fail
 *
 * @typedef {object} TabState
 * @property {Promise<void>|null} attaching  debugger attach, in flight or done; null = not attached
 * @property {string|null} frameId   main frame id (Page.getFrameTree)
 * @property {number|null} ctxId     main frame's default-world execution context
 * @property {Promise<string>|null} actions  remote handle of actions.js in that context
 * @property {boolean} noCtx         tab never reports contexts (stub extensions, old Chrome)
 * @property {number} navTs          last load event (console/errors --since-nav)
 * @property {{ x: number, y: number }} mouse
 * @property {Set<LoadWaiter>} loadWaiters
 */

/** @type {Map<number, TabState>} */
const tabs = new Map()

/** @returns {TabState} */
export function tabState(id) {
  let t = tabs.get(id)
  if (!t) {
    t = { attaching: null, frameId: null, ctxId: null, actions: null, noCtx: false, navTs: 0, mouse: { x: 0, y: 0 }, loadWaiters: new Set() }
    tabs.set(id, t)
  }
  return t
}
export const peekTab = (id) => tabs.get(id)

// the page's JS world was replaced (navigation): contexts and handles into it are gone
/** @param {TabState} t */
export function contextGone(t) { t.ctxId = null; t.actions = null; t.noCtx = false }

/**
 * debugger gone (DevTools opened, extension restarted): attach and contexts must
 * be redone. With `onlyIf`, only when that attach is still the current one —
 * so of several callers that noticed the same failure, only the first resets
 * @param {number} id @param {Promise<void>} [onlyIf]
 */
export function debuggerGone(id, onlyIf) {
  const t = tabs.get(id)
  if (!t || (onlyIf && t.attaching !== onlyIf)) return
  t.attaching = null
  t.frameId = null
  contextGone(t)
}

export function forgetTab(id) {
  const t = tabs.get(id)
  if (!t) return
  for (const w of [...t.loadWaiters]) w.fail(new Error('tab was closed'))
  tabs.delete(id)
}

// a fresh extension connection (e.g. service worker restart) holds no debugger sessions
export function resetAllTabs() {
  for (const [id, t] of tabs) { debuggerGone(id); t.mouse = { x: 0, y: 0 } }
}

export const attachedTabs = () => [...tabs].filter(([, t]) => t.attaching).map(([id]) => id)
