// chrome.debugger plumbing: attach, CDP calls, page eval, load waits
import { sleep } from './util.js'
import { rpc } from './bridge.js'
import { applyRoutes } from './network.js'

export const attached = new Set()
export const loadWaiters = new Map() // tabId -> Set<entry>
// every page eval must run in the main frame's default-world execution context —
// with a password-manager's chrome-extension:// iframe on the page, default
// Runtime.evaluate fails with "Cannot access a chrome-extension:// URL…"
export const mainFrameId = new Map() // tabId -> main frame id (via Page.getFrameTree)
export const mainCtxId = new Map()   // tabId -> main-frame default-world context id
export const noCtx = new Set()       // tabs that never report contexts (stub extensions, old Chrome)
export const navTs = new Map()       // tabId -> last load time (console/errors --since-nav)

export async function mainCtxFor(tabId) {
  if (!noCtx.has(tabId)) {
    for (let i = 0; i < 10 && !mainCtxId.has(tabId); i++) await sleep(50)
    if (!mainCtxId.has(tabId)) noCtx.add(tabId)
  }
  return mainCtxId.get(tabId)
}

export async function attach(s, tabId) {
  if (attached.has(tabId)) return
  try {
    await rpc('debug.attach', { tabId }, 10000)
  } catch (e) {
    // a previous daemon (killed without detaching) may still hold the debugger
    if (/already attached/i.test(String(e && e.message))) {
      await rpc('debug.detach', { tabId }, 5000)
      await rpc('debug.attach', { tabId }, 10000)
    } else throw e
  }
  attached.add(tabId)
  for (const m of ['Page.enable', 'Log.enable', 'Network.enable']) {
    try { await rpc('debug.send', { tabId, method: m }, 8000) } catch {}
  }
  // main frame id before Runtime.enable, so the first executionContextCreated is not missed
  try {
    const t = await rpc('debug.send', { tabId, method: 'Page.getFrameTree' }, 8000)
    mainFrameId.set(tabId, t.frameTree.frame.id)
  } catch {}
  try { await rpc('debug.send', { tabId, method: 'Runtime.enable' }, 8000) } catch {}
  if (s && s.routes.length) { try { await applyRoutes(s, tabId) } catch {} }
}

export async function cdp(s, tabId, method, params = {}, timeout) {
  const t = timeout || (method.startsWith('Page.') ? 25000 : 15000)
  await attach(s, tabId)
  try {
    return await rpc('debug.send', { tabId, method, params }, t)
  } catch (e) {
    // our `attached` bookkeeping can diverge from Chrome (SW restarts, DevTools,
    // Chromium-fork quirks) — drop the tab and force a fresh attach before giving up
    if (!/not attached|cannot access|detached/i.test(String(e && e.message))) throw e
    attached.delete(tabId)
    await attach(s, tabId)
    return rpc('debug.send', { tabId, method, params }, t)
  }
}

export async function evalJS(s, tabId, expression, opts = {}) {
  const evaluate = async () => {
    const ctx = await mainCtxFor(tabId)
    const r = await cdp(s, tabId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: opts.awaitPromise !== false, userGesture: true,
      ...(ctx ? { contextId: ctx } : {}),
    })
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error('page eval error: ' + String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400))
    }
    return r && r.result ? r.result.value : undefined
  }
  try {
    return await evaluate()
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/cannot find.*context|context .*destroyed/i.test(msg)) { mainCtxId.delete(tabId); return evaluate() } // stale after a navigation
    if (/chrome-extension/i.test(msg))
      throw new Error(msg + ' — an extension frame we cannot control (usually a password manager) is injected on this page; disable it for this site or use a clean profile')
    throw e
  }
}

export async function waitComplete(tabId, timeout) {
  const t0 = Date.now()
  for (;;) {
    const tab = await rpc('tabs.get', { tabId }).catch(() => { throw new Error('tab was closed') })
    if (tab.status === 'complete') return tab
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for page load (${timeout}ms)`)
    await sleep(150)
  }
}

export function waitLoadEvent(tabId, timeout) {
  let entry
  const p = new Promise((resolve, reject) => {
    entry = { resolve, reject, tabId }
    entry.timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for page load (${timeout}ms)`)) }, timeout)
    entry.cleanup = cleanup
    entry.cancel = () => { cleanup(); reject(new Error('cancelled')) }
  })
  function cleanup() {
    clearTimeout(entry.timer)
    const set = loadWaiters.get(entry.tabId)
    if (set) { set.delete(entry); if (!set.size) loadWaiters.delete(entry.tabId) }
  }
  const set = loadWaiters.get(tabId) || new Set()
  set.add(entry); loadWaiters.set(tabId, set)
  p.cleanup = cleanup
  p.catch(() => {})
  return p
}

// detach all debuggers and exit — also used by the shutdown command
// (a killed daemon leaves tabs debugger-locked for the next daemon)
export async function quit() {
  for (const tabId of [...attached]) {
    try { await rpc('debug.detach', { tabId }, 2000) } catch {}
    attached.delete(tabId)
  }
  process.exit(0)
}
