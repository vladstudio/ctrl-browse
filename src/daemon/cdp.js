// chrome.debugger plumbing: attach, CDP calls, page eval, load waits
import { sleep, warn, errMsg, script } from './util.js'
import { rpc } from './bridge.js'
import { applyRoutes } from './routes.js'
import { tabState, debuggerGone, attachedTabs } from './tabstate.js'

// chrome.debugger reports failures as message strings only; every match on
// them lives here
export const CHROME_ERR = {
  alreadyAttached: /already attached/i,
  // bookkeeping diverged from Chrome (SW restart, DevTools, Chromium-fork quirks)
  notAttached: /not attached|cannot access|detached/i,
  // the page navigated: its execution context (and objects in it) are gone
  staleContext: /cannot find (default )?(execution )?context|context .*destroyed|could not find object|cannot find object/i,
  extensionFrame: /chrome-extension/i,
}

// every page eval must run in the main frame's default-world execution context —
// with a password-manager's chrome-extension:// iframe on the page, default
// Runtime.evaluate fails with "Cannot access a chrome-extension:// URL…"
async function mainCtxFor(tabId) {
  const t = tabState(tabId)
  if (!t.noCtx) {
    for (let i = 0; i < 10 && !t.ctxId; i++) await sleep(50)
    if (!t.ctxId) t.noCtx = true
  }
  return t.ctxId
}

// one attach per tab even when commands race: callers share the in-flight
// promise (two parallel attaches made the loser detach the winner)
/** @param {import('./state.js').Session|null} s @param {number} tabId */
export function attach(s, tabId) {
  const t = tabState(tabId)
  if (!t.attaching) {
    const p = doAttach(s, tabId)
    t.attaching = p
    p.catch(() => { if (t.attaching === p) t.attaching = null })
  }
  return t.attaching
}

async function doAttach(s, tabId) {
  try {
    await rpc('debug.attach', { tabId }, 10000)
  } catch (e) {
    // a previous daemon (killed without detaching) may still hold the debugger
    if (!CHROME_ERR.alreadyAttached.test(errMsg(e))) throw e
    await rpc('debug.detach', { tabId }, 5000)
    await rpc('debug.attach', { tabId }, 10000)
  }
  const t = tabState(tabId)
  const send = (method) => rpc('debug.send', { tabId, method }, 8000)
  for (const m of ['Page.enable', 'Log.enable', 'Network.enable']) await send(m).catch(warn(`${m} (tab ${tabId})`))
  // main frame id before Runtime.enable, so the first executionContextCreated is not missed
  try { t.frameId = (await send('Page.getFrameTree')).frameTree.frame.id } catch (e) { warn(`Page.getFrameTree (tab ${tabId})`)(e) }
  await send('Runtime.enable').catch(warn(`Runtime.enable (tab ${tabId})`))
  if (s && s.routes.length) await applyRoutes(s, tabId).catch(warn(`applying routes (tab ${tabId})`))
}

/** @returns {Promise<any>} */
export async function cdp(s, tabId, method, params = {}, timeout = 0) {
  const ms = timeout || (method.startsWith('Page.') ? 25000 : 15000)
  const attached = attach(s, tabId)
  await attached
  try {
    return await rpc('debug.send', { tabId, method, params }, ms)
  } catch (e) {
    if (!CHROME_ERR.notAttached.test(errMsg(e))) throw e
    // force a fresh attach — but only once: when parallel commands all fail,
    // the first one resets and the rest share its new attach
    debuggerGone(tabId, attached)
    await attach(s, tabId)
    return rpc('debug.send', { tabId, method, params }, ms)
  }
}

function resultValue(r) {
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error('page eval error: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400))
  }
  return r && r.result ? r.result.value : undefined
}

// one retry after a navigation swapped the context out; explain extension frames
async function inPage(tabId, run) {
  try {
    return await run()
  } catch (e) {
    const msg = errMsg(e)
    if (CHROME_ERR.staleContext.test(msg)) {
      const t = tabState(tabId)
      t.ctxId = null
      t.actions = null
      return run()
    }
    if (CHROME_ERR.extensionFrame.test(msg)) {
      throw new Error(msg + ' — an extension frame we cannot control (usually a password manager) is injected on this page; disable it for this site or use a clean profile')
    }
    throw e
  }
}

/** @returns {Promise<any>} */
export function evalJS(s, tabId, expression, opts = {}) {
  return inPage(tabId, async () => {
    const ctx = await mainCtxFor(tabId)
    return resultValue(await cdp(s, tabId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise !== false, userGesture: true,
      ...(ctx ? { contextId: ctx } : {}),
    }))
  })
}

// src/scripts/actions.js, evaluated once per page context; calls reuse the
// function's remote handle instead of re-sending its source
function actionsHandle(s, tabId) {
  const t = tabState(tabId)
  if (!t.actions) {
    const p = (async () => {
      const ctx = await mainCtxFor(tabId)
      const r = await cdp(s, tabId, 'Runtime.evaluate', { expression: `(${script('actions')})`, ...(ctx ? { contextId: ctx } : {}) })
      resultValue(r)
      return /** @type {string} */ (r.result.objectId)
    })()
    t.actions = p
    p.catch(() => { if (t.actions === p) t.actions = null })
  }
  return t.actions
}

// run one operation of src/scripts/actions.js in the page. Arguments travel
// as JSON values — command-line text is never spliced into code
/** @returns {Promise<any>} */
export function pageCall(s, tabId, op, arg = {}) {
  return inPage(tabId, async () => resultValue(await cdp(s, tabId, 'Runtime.callFunctionOn', {
    objectId: await actionsHandle(s, tabId),
    functionDeclaration: 'function (op, arg) { return this(op, arg) }',
    arguments: [{ value: op }, { value: arg }],
    returnByValue: true, awaitPromise: true, userGesture: true,
  })))
}

/** @param {import('./state.js').Session} s @param {number} tabId @param {'md'|'page'} name @param {any} [arg] */
export const pageScript = (s, tabId, name, arg) =>
  evalJS(s, tabId, `(${script(name)})(${arg === undefined ? '' : JSON.stringify(arg)})`)

// polls chrome.tabs until the tab is loaded. `navigating`: a navigation was
// just requested, so the old page's "complete" (or a pending url) doesn't count
export async function waitComplete(tabId, timeout, { navigating = false } = {}) {
  const t0 = Date.now()
  if (navigating) await sleep(150)
  for (;;) {
    const tab = await rpc('tabs.get', { tabId }).catch(() => { throw new Error('tab was closed') })
    if (tab.status === 'complete' && !tab.pendingUrl) return tab
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for page load (${timeout}ms)`)
    await sleep(150)
  }
}

// resolves on the tab's next Page.loadEventFired; call before navigating
export function waitLoadEvent(tabId, timeout) {
  const t = tabState(tabId)
  /** @type {NodeJS.Timeout|undefined} */
  let timer
  /** @type {import('./tabstate.js').LoadWaiter} */
  let w = { done() {}, fail() {} }
  /** @type {Promise<void>} */
  const promise = new Promise((resolve, reject) => {
    const settle = () => { clearTimeout(timer); t.loadWaiters.delete(w) }
    w = { done: () => { settle(); resolve() }, fail: (e) => { settle(); reject(e) } }
  })
  timer = setTimeout(() => w.fail(new Error(`timeout waiting for page load (${timeout}ms)`)), timeout)
  t.loadWaiters.add(w)
  promise.catch(() => {}) // callers that give up early must not leave an unhandled rejection
  return { promise, cancel: () => { clearTimeout(timer); t.loadWaiters.delete(w) } }
}

// detach all debuggers and exit — also used by the shutdown command
// (a killed daemon leaves tabs debugger-locked for the next daemon)
export async function quit() {
  for (const tabId of attachedTabs()) {
    await rpc('debug.detach', { tabId }, 2000).catch(warn(`detach (tab ${tabId})`))
    debuggerGone(tabId)
  }
  process.exit(0)
}
