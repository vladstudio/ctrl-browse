// navigation and waiting: goto/open, back/forward/reload, wait
import { sleep, int, errMsg, warn, redactUrl } from './util.js'
import { rpc } from './bridge.js'
import { attach, cdp, evalJS, pageCall, pageScript, waitComplete, waitLoadEvent, CHROME_ERR } from './cdp.js'
import { resolveTab } from './sessions.js'

/** @typedef {import('./state.js').Session} Session */

// pages Chrome never lets an extension debug: they're navigated with chrome.tabs
// and can't be read
const UNDEBUGGABLE = /^(chrome|chrome-extension|chrome-untrusted|devtools):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i

// Page.navigate (exact load event) when the current page can be debugged;
// chrome.tabs otherwise — e.g. leaving a chrome:// page, or going to one
async function navigate(s, tabId, url, timeout) {
  const debuggable = !UNDEBUGGABLE.test(url) && await attach(s, tabId).then(() => true, (e) => {
    if (!CHROME_ERR.notAttached.test(errMsg(e))) throw e
    return false
  })
  if (!debuggable) {
    await rpc('tabs.update', { tabId, props: { url } }, 10000)
    await waitComplete(tabId, timeout, { navigating: true })
    return
  }
  const load = waitLoadEvent(tabId, timeout)
  try {
    await cdp(s, tabId, 'Page.navigate', { url }, timeout + 5000)
  } catch (e) { load.cancel(); throw e }
  try { await load.promise } catch (e) {
    // no load event (e.g. same-document navigation) but the tab says it's done
    const t = await rpc('tabs.get', { tabId }).catch(() => null)
    if (!t || t.status !== 'complete') throw e
  }
}

/** @param {Session} s @param {string[]} args  args[0] is already normalized @param {import('../spec.js').Flags} flags */
export async function gotoCmd(s, [url], flags) {
  const tab = await resolveTab(s)
  const timeout = int(flags.timeout, 30000)
  const limit = int(flags.limit, 20000)
  if (s.freshUrl === url) {
    // the session's tab was just created with this url: attach early, so the
    // first page's console and network are tracked, and let it settle
    s.freshUrl = null
    if (!UNDEBUGGABLE.test(url)) await attach(s, tab.id).catch(warn(`attach to ${redactUrl(url)}`))
    await waitComplete(tab.id, timeout).catch(warn(`initial load of ${redactUrl(url)}`))
  } else {
    await navigate(s, tab.id, url, timeout)
  }
  const now = await rpc('tabs.get', { tabId: tab.id }).catch(() => tab)
  const head = (title, u) => `# ${title || url}\n${redactUrl(u || url)}\n\n`
  if (UNDEBUGGABLE.test(url)) {
    return { text: head(now.title, now.url) + '(Chrome does not let extensions read this page — navigated only)', data: { title: now.title, url: now.url, chars: 0 } }
  }
  await sleep(250)
  let unreadable = ''
  const md = await pageScript(s, tab.id, 'md').catch((e) => { unreadable = errMsg(e).slice(0, 200); return null })
  const markdown = String((md && md.markdown) || '')
  const shown = redactUrl(markdown).slice(0, limit) // tokens in URLs never reach output; --raw applies to network commands
  const text = head((md && md.title) || now.title, (md && md.url) || now.url) +
    (shown || (unreadable ? `(page content unavailable: ${unreadable})` : '(empty page)')) +
    (markdown.length > limit ? `\n\n[truncated at ${limit} chars — use "dom" or "get text <sel>" for more]` : '')
  return { text, data: { title: (md && md.title) || now.title, url: (md && md.url) || now.url, chars: markdown.length } }
}

const HISTORY = { back: ['tabs.goBack', 'navigated back'], forward: ['tabs.goForward', 'navigated forward'], reload: ['tabs.reload', 'reloaded'] }

/** @param {Session} s @param {'back'|'forward'|'reload'} which @param {import('../spec.js').Flags} flags */
export async function historyCmd(s, which, flags) {
  const [method, done] = HISTORY[which]
  const tab = await resolveTab(s)
  await rpc(method, { tabId: tab.id }, 10000)
  const loaded = await waitComplete(tab.id, int(flags.timeout, which === 'reload' ? 20000 : 5000), { navigating: true }).then(() => true, () => false)
  return { text: loaded ? done : `${done} (page still loading)` }
}

// errors that no amount of polling will fix
const FATAL = /not connected|connection lost|tab was closed|no tab with id|older ctrl-browse extension/i

/** @param {Session} s @param {string[]} args @param {import('../spec.js').Flags} flags */
export async function waitCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const timeout = int(flags.timeout, 10000)
  const interval = Math.max(50, int(flags.interval, 200))
  const t0 = Date.now()
  const poll = async (desc, test) => {
    /** @type {unknown} */
    let lastErr = null
    for (;;) {
      let hit = false
      try { hit = await test() } catch (e) {
        if (FATAL.test(errMsg(e))) throw e
        lastErr = e // page mid-navigation, context destroyed…: try again
      }
      if (hit) return { text: `${desc} after ${Date.now() - t0}ms` }
      if (Date.now() - t0 > timeout) throw new Error(`${desc} — timed out after ${timeout}ms${lastErr ? ` (last error: ${errMsg(lastErr).slice(0, 200)})` : ''}`)
      await sleep(interval)
    }
  }
  const op = (name, arg) => () => pageCall(s, tab.id, name, arg)
  if (flags.text) return poll(`found text "${flags.text}"`, op('has-text', { text: String(flags.text) }))
  if (flags['text-gone']) return poll(`text "${flags['text-gone']}" gone`, () => op('has-text', { text: String(flags['text-gone']) })().then((v) => !v))
  if (flags.gone) return poll(`element "${flags.gone}" gone`, () => op('exists', { sel: String(flags.gone) })().then((v) => !v))
  if (flags.fn) return poll(`--fn (${String(flags.fn).slice(0, 60)}) truthy`, () => evalJS(s, tab.id, String(flags.fn)).then(Boolean))
  if (flags['network-idle']) {
    // ms comes from the flag value (--network-idle=800) or, being boolean, the first positional arg
    const v = flags['network-idle']
    const idle = (typeof v === 'string' ? int(v, 0) : 0) || int(args[0], 500)
    return poll(`network idle (${idle}ms quiet)`, async () => networkQuietFor(s, tab.id) >= idle)
  }
  if (flags.load) {
    const t = await rpc('tabs.get', { tabId: tab.id }).catch(() => { throw new Error('tab was closed') })
    if (t.status === 'complete') return { text: 'page already loaded' }
    await waitComplete(tab.id, timeout)
    return { text: 'page loaded' }
  }
  const a = args[0]
  if (a === undefined) throw new Error('usage: wait <selector|ms> | wait --text <s> | --text-gone <s> | wait --gone <sel> | wait --fn <js> | wait --network-idle [ms] | wait --load  [--timeout ms] [--interval ms]')
  if (/^\d+$/.test(a)) { await sleep(parseInt(a, 10)); return { text: `waited ${a}ms` } }
  return poll(`element "${a}" appeared`, op('exists', { sel: a }))
}

// streams never finish and long-polls barely do; neither may hold "idle" off forever
const STREAMING = new Set(['eventsource', 'websocket'])
export const LONG_REQUEST_MS = 10000

/**
 * ms since the tab's last network activity (a request starting or ending),
 * or 0 while a request is in flight — except streams and requests open for
 * over LONG_REQUEST_MS (long-polls), which only count by when they started
 * @param {Session} s
 */
export function networkQuietFor(s, tabId, now = Date.now()) {
  let last = 0
  for (const e of s.requests) {
    if (e.tabId !== tabId) continue
    if (!e.done && !STREAMING.has(e.type || '') && now - e.ts < LONG_REQUEST_MS) return 0
    last = Math.max(last, e.ts, e.endTs || 0)
  }
  return now - last
}
