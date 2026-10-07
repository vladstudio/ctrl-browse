// command dispatch
import { PORT, MD_SRC, PAGE_SRC, sleep, tsf, globToRegex, statusMatch, redactUrl, redactHeaders, selExpr } from './util.js'
import { sessions, saveSession, dropSession } from './state.js'
import { ext, rpc } from './bridge.js'
import { attached, navTs, attach, cdp, evalJS, waitComplete, waitLoadEvent } from './cdp.js'
import { syncRoutes, renderRequests, requestDetail } from './network.js'
import { quit } from './cdp.js'
import { ensureSession, resolveTab, resolveTabRef } from './sessions.js'
import { posOf, mouseMoveCmd, clickCmd, fillCmd, typeCmd, pressCmd, selectCmd } from './input.js'

export async function gotoCmd(s, url, flags) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'http://' + url
  const tab = await resolveTab(s)
  const timeout = parseInt(flags.timeout || 30000, 10)
  const limit = parseInt(flags.limit || 20000, 10)
  try { await attach(s, tab.id) } catch {}

  if (s._fresh) {
    // tab was just created with this url — just wait for it to settle
    s._fresh = false
    try { await waitComplete(tab.id, timeout) } catch {}
  } else {
    const lp = waitLoadEvent(tab.id, timeout)
    try {
      await cdp(s, tab.id, 'Page.navigate', { url }, timeout + 5000)
    } catch (e) { lp.cleanup(); throw e }
    try { await lp } catch (e) {
      const t = await rpc('tabs.get', { tabId: tab.id }).catch(() => null)
      if (!t || t.status !== 'complete') throw e
    }
  }
  await sleep(250)
  const md = await evalJS(s, tab.id, `(${MD_SRC})()`).catch(() => null)
  const markdown = String((md && md.markdown) || '')
  const shown = redactUrl(markdown).slice(0, limit) // tokens in URLs never reach output; --raw applies to network commands
  const text = `# ${(md && md.title) || tab.title || url}\n${(md && md.url) || tab.url || url}\n\n${shown || '(empty page)'}` +
    (markdown.length > limit ? `\n\n[truncated at ${limit} chars — use "dom" or "get text <sel>" for more]` : '')
  return { text, data: { title: md && md.title, url: (md && md.url) || tab.url, chars: markdown.length } }
}

export async function closeCmd(s) {
  let tabs = []
  try { tabs = await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000) } catch {}
  if (tabs.length) { try { await rpc('tabs.remove', { tabId: tabs.map((t) => t.id) }, 10000) } catch {} }
  for (const t of tabs) attached.delete(t.id)
  dropSession(s)
  return { text: `session "${s.name}" closed (${tabs.length} tab${tabs.length === 1 ? '' : 's'})` }
}

export function renderSnapshot(res) {
  const L = [`page: ${res.title}`, `url: ${res.url}`, '']
  for (const e of res.elements || []) {
    const bits = []
    if (e.text) bits.push(`"${e.text}"`)
    if (e.name) bits.push(`name="${e.name}"`)
    if (e.value !== undefined) bits.push(`value="${e.value}"`)
    if (e.type) bits.push(`(${e.type})`)
    if (e.href) bits.push(e.href)
    if (e.checked) bits.push('[x]')
    if (e.disabled) bits.push('[disabled]')
    for (const a of ['pressed', 'expanded', 'selected']) if (e[a]) bits.push(`[${a}=${e[a]}]`)
    L.push(`@${String(e.ref).padEnd(6)}${String(e.role).padEnd(10)}${bits.join(' ').slice(0, 150)}`)
  }
  if (!res.elements || !res.elements.length) L.push('(no matching elements)')
  L.push('', 'use @refs with click/fill/type/select — e.g. click @e3')
  return L.join('\n')
}

export async function tabList(s) {
  const tabs = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 8000)).sort((a, b) => a.index - b.index)
  s.tabs = new Map(tabs.map((t) => [t.id, { title: t.title, url: t.url }]))
  const lines = tabs.map((t, i) =>
    `t${i + 1}${t.id === s.activeTabId ? '*' : ' '} tabId=${t.id}${s.labels[t.id] ? ` label=${s.labels[t.id]}` : ''} "${String(t.title || '').slice(0, 50)}"\n      ${t.url}`)
  const data = tabs.map((t, i) => ({ ref: `t${i + 1}`, tabId: t.id, label: s.labels[t.id] || null, title: t.title, url: t.url, active: t.id === s.activeTabId }))
  return { text: lines.join('\n') || '(no tabs)', data: { tabs: data } }
}

export async function tabNew(s, url, label) {
  const tab = await rpc('tabs.create', { props: { url: url || 'about:blank', active: true } }, 20000)
  try {
    await rpc('tabs.group', { tabIds: [tab.id], groupId: s.groupId }, 8000)
  } catch (e) {
    await rpc('tabs.remove', { tabId: tab.id }, 5000).catch(() => {})
    throw new Error('could not add tab to session group: ' + e.message)
  }
  if (label) s.labels[tab.id] = String(label)
  s.activeTabId = tab.id
  s.tabs.set(tab.id, { title: tab.title || '', url: tab.url || url || '' })
  saveSession(s)
  return { text: `opened tab tabId=${tab.id}${label ? ` label=${label}` : ''} in "${s.name}"` }
}

export async function tabSwitch(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  await rpc('tabs.update', { tabId: tab.id, props: { active: true } }, 8000)
  try { await rpc('windows.update', { windowId: tab.windowId, props: { focused: true } }, 5000) } catch {}
  s.activeTabId = tab.id
  saveSession(s)
  const i = tabs.findIndex((t) => t.id === tab.id)
  return { text: `switched to t${i + 1} (tabId=${tab.id})` }
}

export async function tabClose(s, ref) {
  const { tab, tabs } = await resolveTabRef(s, ref)
  const i = tabs.findIndex((t) => t.id === tab.id)
  await rpc('tabs.remove', { tabId: tab.id }, 8000)
  attached.delete(tab.id)
  delete s.labels[tab.id]
  s.tabs.delete(tab.id)
  if (s.activeTabId === tab.id) {
    const rest = tabs.filter((t) => t.id !== tab.id)
    s.activeTabId = rest.length ? rest[0].id : null
  }
  saveSession(s)
  return { text: `closed t${i + 1} (tabId=${tab.id})` }
}

export const USAGE = {
  goto: ['open|goto <url>', 1], open: ['open|goto <url>', 1],
  screenshot: ['screenshot <path> [--full] [--scale n] [--max-width n] [--el <sel|@ref> [--pad px]]', 1],
  click: ['click <selector|@ref> [--force]', 1],
  fill: ['fill <selector> <text>', 2], type: ['type <selector> <text> [--delay ms]', 2],
  press: ['press <key[+mod]>', 1],
  get: ['get text|html <sel>', 2],
  select: ['select <selector> <value|label>', 2], eval: ['eval <js>', 1],
  scrollintoview: ['scrollintoview <selector|@ref>', 1],
  viewport: ['viewport <w> <h> [--dpr n] | viewport reset', 1],
  storage: ['storage get|set|clear local|session <key> [value]', 2],
}

export async function dispatch(session, cmd, args, flags) {
  if (cmd === 'shutdown') { setTimeout(quit, 100); return { text: 'daemon shutting down', data: { managed: !!process.env.CTRL_BROWSE_MANAGED } } }
  if (cmd === 'status') {
    if (!ext) {
      // give the extension's service worker a moment to wake up and connect
      const t0 = Date.now()
      while (!ext && Date.now() - t0 < 8000) await sleep(250)
    }
    return {
      text: `daemon: pid ${process.pid} on 127.0.0.1:${PORT}${process.env.CTRL_BROWSE_MANAGED ? ' (launchagent)' : ''}\nbrowser: ${ext ? 'connected' : 'not connected (open Chrome with the ctrl-browse extension loaded — it connects within ~30s of the daemon starting)'}\nsessions: ${sessions.size ? [...sessions.keys()].join(', ') : '(none)'}`,
    }
  }
  if (cmd === 'sessions') {
    const out = []
    for (const s of sessions.values()) {
      let n = '?'
      try { n = (await rpc('tabs.query', { query: { groupId: s.groupId } }, 5000)).length } catch {}
      out.push(`${s.name}  groupId=${s.groupId}  tabs=${n}`)
    }
    return { text: out.length ? out.join('\n') : 'no sessions', data: { sessions: [...sessions.keys()] } }
  }

  const wantsUrl = cmd === 'goto' || cmd === 'open'
  const u = USAGE[cmd]
  if (u && args.length < u[1]) throw new Error('usage: ' + u[0])
  const s = await ensureSession(session, { create: cmd !== 'close', url: wantsUrl ? args[0] : undefined })

  switch (cmd) {
    case 'goto': case 'open': return gotoCmd(s, args[0], flags)
    case 'close': return closeCmd(s)
    case 'back': case 'forward': {
      const tab = await resolveTab(s)
      await rpc(cmd === 'back' ? 'tabs.goBack' : 'tabs.goForward', { tabId: tab.id }, 10000)
      try { await waitComplete(tab.id, 5000) } catch {}
      return { text: cmd === 'back' ? 'navigated back' : 'navigated forward' }
    }
    case 'reload': {
      const tab = await resolveTab(s)
      await rpc('tabs.reload', { tabId: tab.id }, 10000)
      try { await waitComplete(tab.id, parseInt(flags.timeout || 20000, 10)) } catch {}
      return { text: 'reloaded' }
    }
    case 'dom': {
      const tab = await resolveTab(s)
      const html = await evalJS(s, tab.id, 'document.documentElement.outerHTML')
      const limit = parseInt(flags.limit || 200000, 10)
      const out = String(html).slice(0, limit)
      return { text: out + (String(html).length > limit ? `\n\n[truncated at ${limit} chars]` : ''), data: { html: out } }
    }
    case 'snapshot': {
      const tab = await resolveTab(s)
      const res = await evalJS(s, tab.id, `(${PAGE_SRC})(${JSON.stringify({ interactive: !!flags.i, limit: parseInt(flags.limit || 150, 10) })})`)
      return { text: renderSnapshot(res), data: res }
    }
    case 'screenshot': {
      const tab = await resolveTab(s)
      // clip is in document coords; CDP rejects a clip without scale, or scale > 2
      const r = await evalJS(s, tab.id, flags.el
        ? `(() => { const el = ${selExpr(flags.el)}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(), p = ${parseFloat(flags.pad) || 0}, x = Math.max(0, b.left + scrollX - p), y = Math.max(0, b.top + scrollY - p); return { x, y, width: b.right + scrollX + p - x, height: b.bottom + scrollY + p - y, dpr: devicePixelRatio } })()`
        : flags.full
          ? '({ x: 0, y: 0, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, dpr: devicePixelRatio })'
          : '({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')
      if (!r) throw new Error(`element not found: ${flags.el}`)
      const { dpr, ...clip } = r
      clip.scale = Math.min(2, parseFloat(flags.scale) || 1, parseFloat(flags['max-width']) / (clip.width * dpr) || 1)
      const shot = await cdp(s, tab.id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!(flags.full || flags.el), clip }, 20000)
      return { text: 'ok', data: { bytes: shot.data } }
    }
    case 'press': return pressCmd(s, args[0])
    case 'viewport': {
      const tab = await resolveTab(s)
      if (args[0] === 'reset') { await cdp(s, tab.id, 'Emulation.clearDeviceMetricsOverride'); return { text: 'viewport reset' } }
      const [w, h] = [parseInt(args[0], 10), parseInt(args[1], 10)]
      if (!w || !h) throw new Error('usage: viewport <w> <h> [--dpr n] | viewport reset')
      const dpr = parseFloat(flags.dpr)
      await cdp(s, tab.id, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: isNaN(dpr) ? 0 : dpr, mobile: false })
      return { text: `viewport ${w}×${h}${isNaN(dpr) ? '' : ` dpr ${dpr}`}` }
    }
    case 'storage': {
      const [sub, kind, key] = args
      const sto = kind === 'local' ? 'localStorage' : kind === 'session' ? 'sessionStorage' : null
      const k = JSON.stringify(String(key || ''))
      if (!sub || !sto || (sub !== 'clear' && !key)) throw new Error('usage: storage get|set|clear local|session <key> [value]')
      const tab = await resolveTab(s)
      const js = sub === 'get' ? `${sto}.getItem(${k})`
        : sub === 'set' ? `${sto}.setItem(${k}, ${JSON.stringify(args.slice(3).join(' '))})`
        : key ? `${sto}.removeItem(${k})` : `${sto}.clear()`
      const v = await evalJS(s, tab.id, js)
      if (sub === 'get') return { text: String(v), data: { key, value: v } }
      return { text: `cleared ${sto}${key ? `.${key}` : ''}` }
    }
    case 'click': return clickCmd(s, args[0], flags)
    case 'fill': return fillCmd(s, args[0], args.slice(1).join(' '))
    case 'type': return typeCmd(s, args[0], args.slice(1).join(' '), flags)
    case 'select': return selectCmd(s, args[0], args.slice(1).join(' '))
    case 'find': {
      let a = [...args]
      let action = flags.action
      const last = a[a.length - 1]
      if (!action && (last === 'click' || last === 'show')) { action = last; a = a.slice(0, -1) }
      action = action || 'show'
      const kind = a[0]
      if (!['role', 'text', 'label'].includes(kind)) throw new Error('usage: find role <role> [--name <s>] | find label <accessible name> | find text <text>  [--nth N] [click|show]')
      const needle = kind === 'role' ? a[1] : a.slice(1).join(' ')
      if (!needle) throw new Error(`missing ${kind}`)
      const tab = await resolveTab(s)
      const res = (await evalJS(s, tab.id, `(${PAGE_SRC})(${JSON.stringify({ find: { kind, needle, name: flags.name } })})`)) || []
      // --nth is 1-based, matching the numbers in the listing
      const nth = flags.nth === undefined ? null : parseInt(flags.nth, 10)
      if (nth !== null && !(nth >= 1)) throw new Error('--nth takes a 1-based index, e.g. --nth 2')
      if (nth !== null && nth > res.length) throw new Error(`--nth ${nth}, but only ${res.length} match${res.length === 1 ? '' : 'es'} for ${kind} "${needle}"`)
      const pick = nth || 1
      let text = res.length ? res.map((e, i) => `${String(i + 1).padStart(2)}${nth === i + 1 ? '*' : ' '} @${e.ref}  ${String(e.role).padEnd(9)} ${e.text || ''}`).join('\n') : 'no matches'
      if (action === 'click') {
        if (!res.length) throw new Error(`no match for ${kind} "${needle}" — cannot click`)
        if (res.length > 1 && !nth) text += `\n${res.length} matches — clicked the first (add --nth N to target another)`
        const r = await clickCmd(s, '@' + res[pick - 1].ref, flags)
        text += `\n${r.text}`
      }
      return { text, data: { matches: res } }
    }
    case 'wait': return waitCmd(s, args, flags)
    case 'eval': {
      const tab = await resolveTab(s)
      const v = await evalJS(s, tab.id, args.join(' '))
      let text
      try { text = typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v, null, 2) } catch { text = String(v) }
      return { text, data: { result: v } }
    }
    case 'scrollintoview': {
      const tab = await resolveTab(s)
      const ok = await evalJS(s, tab.id, `(() => { const el = ${selExpr(args[0])}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
      if (!ok) throw new Error(`element not found: ${args[0]}`)
      return { text: `scrolled into view: ${args[0]}` }
    }
    case 'get': {
      const sub = args[0]
      if ((sub !== 'text' && sub !== 'html') || !args[1]) throw new Error('usage: get text <sel> | get html <sel>')
      const tab = await resolveTab(s)
      const r = await evalJS(s, tab.id, `(() => { const el = ${selExpr(args[1])}; if (!el) return null; return ${sub === 'text' ? 'el.innerText' : 'el.innerHTML'} })()`)
      if (r === null) throw new Error(`element not found: ${args[1]}`)
      return { text: String(r), data: sub === 'text' ? { text: r } : { html: r } }
    }
    case 'mouse': {
      const sub = args[0]
      const tab = await resolveTab(s)
      if (sub === 'move') {
        const x = Number(args[1]); const y = Number(args[2])
        if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('usage: mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n]')
        await mouseMoveCmd(s, tab.id, x, y, flags)
        return { text: `mouse at ${x},${y}` }
      }
      if (sub === 'down' || sub === 'up') {
        const btn = args[1] || 'left'
        if (!['left', 'right', 'middle'].includes(btn)) throw new Error('button: left|right|middle')
        const p = posOf(tab.id)
        const mask = btn === 'left' ? 1 : btn === 'right' ? 2 : 4
        await cdp(s, tab.id, 'Input.dispatchMouseEvent',
          sub === 'down'
            ? { type: 'mousePressed', x: p.x, y: p.y, button: btn, buttons: mask, clickCount: 1 }
            : { type: 'mouseReleased', x: p.x, y: p.y, button: btn, buttons: 0, clickCount: 1 })
        return { text: `${sub} ${btn} at ${p.x},${p.y}` }
      }
      if (sub === 'wheel') {
        const dy = Number(args[1] || 0); const dx = Number(args[2] || 0)
        const p = posOf(tab.id)
        await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy })
        return { text: `wheel dy=${dy} dx=${dx} at ${p.x},${p.y}` }
      }
      throw new Error('usage: mouse move <x> <y> | mouse down [button] | mouse up [button] | mouse wheel <dy> [dx]')
    }
    case 'network': {
      const sub = args[0]
      if (sub === 'route') {
        const pat = args[1]
        if (!pat) throw new Error('usage: network route <pattern> [--body <json>] [--status n] [--method M] [--times n] [--header "Name: value"] [--content-type ct] [--resource-type t] [--abort]')
        const headers = (Array.isArray(flags.header) ? flags.header : flags.header ? [flags.header] : [])
          .map((kv) => { const i = String(kv).indexOf(':'); return i === -1 ? null : { name: String(kv).slice(0, i).trim(), value: String(kv).slice(i + 1).trim() } })
          .filter(Boolean)
        const times = flags.times ? parseInt(flags.times, 10) : undefined
        s.routes.push({
          url: pat, abort: !!flags.abort, headers,
          // --status alone fulfills with an empty body (it used to silently pass through)
          body: flags.body !== undefined ? flags.body : flags.status !== undefined ? '' : undefined,
          status: flags.status ? parseInt(flags.status, 10) : undefined,
          method: flags.method ? String(flags.method).toUpperCase() : undefined,
          times: Number.isFinite(times) ? times : undefined,
          contentType: flags['content-type'], resourceType: flags['resource-type'],
        })
        await syncRoutes(s)
        return { text: `route added (${s.routes.length} active — applies to every tab in "${s.name}")` }
      }
      if (sub === 'unroute') {
        const pat = args[1]
        const before = s.routes.length
        s.routes = pat ? s.routes.filter((r) => r.url !== pat) : []
        await syncRoutes(s)
        return { text: `removed ${before - s.routes.length} route(s), ${s.routes.length} remain` }
      }
      if (sub === 'requests') {
        if (flags.clear) { s.requests = []; s.reqMap = new Map(); return { text: 'request log cleared' } }
        let list = s.requests
        if (flags.filter) { const re = globToRegex(flags.filter, { anchored: false, ignoreCase: true }); list = list.filter((e) => re.test(e.url)) }
        if (flags.type) { const want = String(flags.type).split(',').map((x) => x.trim().toLowerCase()); list = list.filter((e) => want.includes(String(e.type || '').toLowerCase())) }
        if (flags.method) { const want = String(flags.method).split(',').map((x) => x.trim().toUpperCase()); list = list.filter((e) => want.includes(String(e.method || '').toUpperCase())) }
        if (flags.status) list = list.filter((e) => (typeof e.status === 'number' ? statusMatch(flags.status, e.status) : String(e.status || '').includes(String(flags.status))))
        if (!flags.raw) list = list.map((e) => ({ ...e, url: redactUrl(e.url), requestHeaders: redactHeaders(e.requestHeaders), responseHeaders: redactHeaders(e.responseHeaders) }))
        return { text: renderRequests(list, !!flags.raw), data: { requests: list.slice(-200) } }
      }
      if (sub === 'request') {
        if (!args[1]) throw new Error('usage: network request <n|id> [--raw]')
        return requestDetail(s, args[1], !!flags.raw)
      }
      throw new Error('usage: network route|unroute|requests|request')
    }
    case 'tab': {
      if (args[0] === undefined || args[0] === 'list') return tabList(s)
      if (args[0] === 'new') return tabNew(s, args[1], flags.label)
      if (args[0] === 'close') return tabClose(s, args[1])
      return tabSwitch(s, args[0])
    }
    case 'console': {
      if (flags.clear) { s.console = []; return { text: 'console cleared' } }
      const list = s.console.filter((e) => !flags['since-nav'] || e.ts >= (navTs.get(e.tabId) || 0)).slice(-200)
      if (flags.json) return { text: 'ok', data: { entries: list } }
      return {
        text: list.length
          ? list.map((e) => `${tsf(e.ts)}  ${String(e.type).padEnd(8)} ${String(e.text).slice(0, 200)}`).join('\n')
          : 'no console messages (only tabs touched by commands are tracked)',
      }
    }
    case 'errors': {
      if (flags.clear) { s.errors = []; return { text: 'errors cleared' } }
      const list = s.errors.filter((e) => !flags['since-nav'] || e.ts >= (navTs.get(e.tabId) || 0)).slice(-100)
      return {
        text: list.length
          ? list.map((e) => `${tsf(e.ts)}  ${e.text}`).join('\n')
          : 'no page errors (only tabs touched by commands are tracked)',
      }
    }
    default:
      throw new Error(`unknown command: ${cmd} — run "ctrl-browse help"`)
  }
}

export async function waitCmd(s, args, flags) {
  const tab = await resolveTab(s)
  const timeout = parseInt(flags.timeout || 10000, 10)
  const interval = Math.max(50, parseInt(flags.interval || 200, 10))
  const t0 = Date.now()
  const poll = async (desc, test) => {
    for (;;) {
      const hit = await test().catch(() => false)
      if (hit) return { text: `${desc} after ${Date.now() - t0}ms` }
      if (Date.now() - t0 > timeout) throw new Error(`${desc} — timed out after ${timeout}ms`)
      await sleep(interval)
    }
  }
  const page = (js) => () => evalJS(s, tab.id, js)
  const q = (v) => JSON.stringify(String(v))
  if (flags.text) return poll(`found text "${flags.text}"`, page(`document.body ? document.body.innerText.indexOf(${q(flags.text)}) !== -1 : false`))
  if (flags['text-gone']) return poll(`text "${flags['text-gone']}" gone`, page(`document.body ? document.body.innerText.indexOf(${q(flags['text-gone'])}) === -1 : true`))
  if (flags.gone) return poll(`element "${flags.gone}" gone`, page(`!document.querySelector(${q(flags.gone)})`))
  if (flags.fn) return poll(`--fn (${String(flags.fn).slice(0, 60)}) truthy`, () => evalJS(s, tab.id, String(flags.fn)).then(Boolean))
  if (flags['network-idle']) {
    // "nothing new for this tab in the last N ms" — queries the tracked log.
    // ms comes from the flag value or, being boolean, the first positional arg
    const idle = parseInt(flags['network-idle'], 10) || parseInt(args[0], 10) || 500
    return poll(`network idle (${idle}ms quiet)`, () => {
      const last = Math.max(0, ...s.requests.filter((e) => e.tabId === tab.id).map((e) => e.ts))
      return Date.now() - last >= idle
    })
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
  return poll(`element "${a}" appeared`, page(`!!document.querySelector(${q(a)})`))
}
