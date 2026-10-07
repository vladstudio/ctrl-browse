// trusted mouse and keyboard input: click, fill, type, press, select
import { sleep, selExpr } from './util.js'
import { cdp, evalJS } from './cdp.js'
import { resolveTab } from './sessions.js'

export const mousePos = new Map()
export function posOf(tabId) {
  if (!mousePos.has(tabId)) mousePos.set(tabId, { x: 0, y: 0 })
  return mousePos.get(tabId)
}
export function lcg(seed) {
  let s = (seed >>> 0) || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

export async function mouseMoveCmd(s, tabId, x, y, flags = {}) {
  const from = posOf(tabId)
  if (flags.human || flags.duration || flags.steps) {
    const steps = Math.max(2, parseInt(flags.steps || 24, 10))
    const duration = Math.max(16, parseInt(flags.duration || 250, 10))
    const rng = flags.seed !== undefined ? lcg(parseInt(flags.seed, 10) || 1) : Math.random
    const jitter = Math.min(6, Math.hypot(x - from.x, y - from.y) / 25)
    for (let i = 1; i <= steps; i++) {
      const p = 1 - Math.pow(1 - i / steps, 3) // easeOutCubic
      const j = i < steps ? jitter : 0
      await cdp(s, tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (x - from.x) * p + (rng() - 0.5) * j),
        y: Math.round(from.y + (y - from.y) * p + (rng() - 0.5) * j),
        buttons: 0,
      })
      if (i < steps) await sleep(duration / steps)
    }
  } else {
    await cdp(s, tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  }
  posOf(tabId).x = x
  posOf(tabId).y = y
}

export async function clickCmd(s, sel, flags = {}) {
  const tab = await resolveTab(s)
  const info = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const pt = (fx, fy) => [Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)]
    const [x, y] = pt(0.5, 0.5)
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    // a contains b, across shadow roots (elementFromPoint returns the shadow host)
    const within = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false }
    const hit = document.elementFromPoint(x, y)
    if (!hit || within(el, hit) || within(hit, el)) return { x, y, disabled }
    // describe what is on top, so the caller knows how to get it out of the way
    const t = (hit.getAttribute('aria-label') || hit.innerText || '').replace(/\\s+/g, ' ').trim()
    const cls = typeof hit.className === 'string' ? hit.className.trim().split(/\\s+/).slice(0, 3).join(' ') : ''
    const covered = '<' + hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') +
      (hit.getAttribute('role') ? ' role=' + hit.getAttribute('role') : '') + (!t && cls ? ' class="' + cls + '"' : '') + '>' +
      (t ? ' "' + (t.length > 50 ? t.slice(0, 50) + '…' : t) + '"' : '')
    if (${!!flags.force}) return { x, y, disabled, forced: covered }
    // only the center is covered (a toast or badge over its middle): click a visible part instead
    for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      const [px, py] = pt(fx, fy)
      const h = document.elementFromPoint(px, py)
      if (h && within(el, h)) return { x: px, y: py, disabled }
    }
    const dlg = Array.from(document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]'))
      .find((d) => d.getClientRects().length && !within(d, el))
    let dialog = null
    if (dlg) {
      const lb = (dlg.getAttribute('aria-labelledby') || '').split(' ')[0]
      const le = lb && document.getElementById(lb), h = dlg.querySelector('h1, h2, h3, [role=heading]')
      dialog = (dlg.getAttribute('aria-label') || (le && le.innerText) || (h && h.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 60) || 'untitled'
    }
    return { x, y, disabled, covered, dialog }
  })()`)
  if (!info) throw new Error(`element not found: ${sel} (run "snapshot -i" for refs)`)
  if (info.disabled) throw new Error('element is disabled')
  if (info.covered) {
    throw new Error(`${sel} is covered by ${info.covered}${info.dialog ? ` — an open dialog ("${info.dialog}") is in front; "press Escape" usually closes it` : ''}. ` +
      'The click would land on that element; "click --force" clicks there anyway')
  }
  await mouseMoveCmd(s, tab.id, info.x, info.y)
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 })
  return { text: `clicked ${sel} at ${info.x},${info.y}${info.forced ? ` (forced — ${info.forced} is on top there and got the click)` : ''}` }
}

export async function fillCmd(s, sel, text) {
  const tab = await resolveTab(s)
  const r = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return null
    el.focus()
    if (el.isContentEditable) {
      // select existing content for replacement — editors (Lexical, ProseMirror…)
      // ignore DOM writes and synthetic events, so the caller completes this
      // fill with a trusted Input.insertText
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      return { editable: true }
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype)
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    const v = ${JSON.stringify(text)}
    if (desc && desc.set) desc.set.call(el, v); else el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: el.value === v, value: el.type === 'password' ? '[REDACTED]' : el.value }
  })()`)
  if (!r) throw new Error(`element not found: ${sel}`)
  if (r.editable) { await cdp(s, tab.id, 'Input.insertText', { text }); return { text: `filled ${sel} (contenteditable)`, data: r } }
  if (!r.ok) throw new Error(`fill failed — the element now holds ${JSON.stringify(r.value)} (masked or reformatting input) ${sel}`)
  return { text: `filled ${sel}`, data: r }
}

// some handlers key off Windows virtual-key codes; Chrome only derives them for a-z
export const CHAR_VK = { ' ': 32, ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 }
export const vkOf = (ch) => /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : (CHAR_VK[ch] || 0)

export async function typeCmd(s, sel, text, flags) {
  const tab = await resolveTab(s)
  const found = await evalJS(s, tab.id, `(() => { const el = ${selExpr(sel)}; if (!el) return false; el.focus(); return true })()`)
  if (!found) throw new Error(`element not found: ${sel}`)
  // a small default delay: editors detect trigger characters (#, @) on their
  // update cycle, and back-to-back synthetic keys land before it runs
  const delay = parseInt(flags.delay ?? 15, 10) || 0
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') {
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', windowsVirtualKeyCode: 13 })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    } else {
      const vk = vkOf(ch)
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    }
    if (delay) await sleep(delay)
  }
  return { text: `typed ${String(text).length} chars into ${sel}` }
}

export const PRESS_KEYS = {
  escape: ['Escape', 27], tab: ['Tab', 9], enter: ['Enter', 13], backspace: ['Backspace', 8],
  delete: ['Delete', 46], home: ['Home', 36], end: ['End', 35], pageup: ['PageUp', 33], pagedown: ['PageDown', 34],
  arrowup: ['ArrowUp', 38], arrowdown: ['ArrowDown', 40], arrowleft: ['ArrowLeft', 37], arrowright: ['ArrowRight', 39],
}

export async function pressCmd(s, chunk) {
  // trusted key presses / shortcuts (press Escape, press Meta+a). `press`
  // never inserts text — use `fill`/`type` for that
  const parts = String(chunk).split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new Error('usage: press <key[+mod]>, e.g. press Escape, press Meta+a')
  const MOD = { ctrl: 'Control', control: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', shift: 'Shift', alt: 'Alt' }
  const BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
  const VK = { Alt: 18, Control: 17, Meta: 91, Shift: 16 }
  const mods = parts.slice(0, -1).map((p) => MOD[p.toLowerCase()])
  if (mods.includes(undefined)) throw new Error(`unknown modifier in "${chunk}" — use ctrl|meta|cmd|shift|alt`)
  const name = parts[parts.length - 1].toLowerCase()
  const fk = /^f([1-9]|1[0-2])$/.exec(name)
  const def = PRESS_KEYS[name] || (/^[a-z]$/.test(name) ? [name.toUpperCase(), name.toUpperCase().charCodeAt(0)] : null)
    || (/^[0-9]$/.test(name) ? [name, name.charCodeAt(0)] : null) || (fk ? ['F' + fk[1], 111 + Number(fk[1])] : null)
  if (!def) throw new Error(`unknown key "${parts[parts.length - 1]}" — letter, digit, F1-F12, escape, tab, enter, backspace, delete, arrows, home/end, pageup/pagedown`)
  const [key, vk] = def
  const code = /^[a-z]$/.test(name) ? 'Key' + key : /^[0-9]$/.test(name) ? 'Digit' + key : key
  const tab = await resolveTab(s)
  const press = (type, key, code, vk, modifiers) =>
    cdp(s, tab.id, 'Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  let mask = 0
  for (const m of mods) { mask |= BIT[m]; await press('rawKeyDown', m, m + 'Left', VK[m], mask) }
  // Enter needs its "\r" text: implicit form submission fires on the keypress
  // Chrome derives from it — a bare rawKeyDown never submits
  if (key === 'Enter') await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask })
  else await press('rawKeyDown', key, code, vk, mask)
  await press('keyUp', key, code, vk, mask)
  for (const m of mods.reverse()) { mask &= ~BIT[m]; await press('keyUp', m, m + 'Left', VK[m], mask) }
  return { text: `pressed ${chunk}` }
}

export async function selectCmd(s, sel, val) {
  const tab = await resolveTab(s)
  const r = await evalJS(s, tab.id, `(() => {
    const el = ${selExpr(sel)}
    if (!el) return { error: 'not found' }
    if (el.tagName !== 'SELECT') return { error: 'not a <select> (tag: ' + el.tagName.toLowerCase() + ')' }
    const want = ${JSON.stringify(String(val))}
    const opts = Array.from(el.options)
    const opt = opts.find((o) => o.value === want) || opts.find((o) => o.text.trim() === want)
    if (!opt) return { error: 'no option with value or label: ' + want, options: opts.slice(0, 50).map((o) => ({ value: o.value, text: o.text })) }
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    if (desc && desc.set) desc.set.call(el, opt.value); else el.value = opt.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].text : '' }
  })()`)
  if (r.error) throw new Error(r.error + (r.options ? '\navailable options: ' + r.options.map((o) => `${o.value} ("${o.text}")`).join(', ') : ''))
  return { text: `selected "${r.text}" (value=${r.value})`, data: r }
}
