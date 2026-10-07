// trusted mouse and keyboard input: click, fill, type, press, select, mouse
import { sleep, int } from './util.js'
import { cdp, pageCall } from './cdp.js'
import { tabState } from './tabstate.js'
import { resolveTab } from './sessions.js'

/** @typedef {import('./state.js').Session} Session */

export function lcg(seed) {
  let s = (seed >>> 0) || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function mouseMoveTo(s, tabId, x, y, flags = {}) {
  const pos = tabState(tabId).mouse
  if (flags.human || flags.duration || flags.steps) {
    const steps = Math.max(2, int(flags.steps, 24))
    const duration = Math.max(16, int(flags.duration, 250))
    const rng = flags.seed !== undefined ? lcg(int(flags.seed, 1)) : Math.random
    const from = { ...pos }
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
  tabState(tabId).mouse = { x, y }
}

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function clickCmd(s, sel, flags = {}) {
  const tab = await resolveTab(s)
  const info = await pageCall(s, tab.id, 'click', { sel, force: !!flags.force })
  if (!info) throw new Error(`element not found: ${sel} (run "snapshot -i" for refs)`)
  if (info.disabled) throw new Error('element is disabled')
  if (info.covered) {
    throw new Error(`${sel} is covered by ${info.covered}${info.dialog ? ` — an open dialog ("${info.dialog}") is in front; "press Escape" usually closes it` : ''}. ` +
      'The click would land on that element; "click --force" clicks there anyway')
  }
  await mouseMoveTo(s, tab.id, info.x, info.y)
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 })
  return { text: `clicked ${sel} at ${info.x},${info.y}${info.forced ? ` (forced — ${info.forced} is on top there and got the click)` : ''}` }
}

/** @param {Session} s */
export async function fillCmd(s, sel, text) {
  const tab = await resolveTab(s)
  const r = await pageCall(s, tab.id, 'fill', { sel, value: text })
  if (!r) throw new Error(`element not found: ${sel}`)
  if (r.editable) { await cdp(s, tab.id, 'Input.insertText', { text }); return { text: `filled ${sel} (contenteditable)`, data: r } }
  if (!r.ok) throw new Error(`fill failed — the element now holds ${JSON.stringify(r.value)} (masked or reformatting input) ${sel}`)
  return { text: `filled ${sel}`, data: r }
}

// some handlers key off Windows virtual-key codes; Chrome only derives them for a-z
export const CHAR_VK = { ' ': 32, ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 }
export const vkOf = (ch) => /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : (CHAR_VK[ch] || 0)

/** @param {Session} s @param {import('../spec.js').Flags} flags */
export async function typeCmd(s, sel, text, flags) {
  const tab = await resolveTab(s)
  if (!(await pageCall(s, tab.id, 'focus', { sel }))) throw new Error(`element not found: ${sel}`)
  // a small default delay: editors detect trigger characters (#, @) on their
  // update cycle, and back-to-back synthetic keys land before it runs
  const delay = Math.max(0, int(flags.delay, 15))
  const key = (params) => cdp(s, tab.id, 'Input.dispatchKeyEvent', params)
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') {
      await key({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await key({ type: 'char', text: '\r', key: 'Enter', windowsVirtualKeyCode: 13 })
      await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    } else {
      const vk = vkOf(ch)
      await key({ type: 'keyDown', text: ch, key: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await key({ type: 'keyUp', key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
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
const MOD = { ctrl: 'Control', control: 'Control', meta: 'Meta', cmd: 'Meta', command: 'Meta', shift: 'Shift', alt: 'Alt' }
const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const MOD_VK = { Alt: 18, Control: 17, Meta: 91, Shift: 16 }

/** @param {Session} s */
export async function pressCmd(s, chunk) {
  // trusted key presses / shortcuts (press Escape, press Meta+a). `press`
  // never inserts text — use `fill`/`type` for that
  const parts = String(chunk).split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) throw new Error('usage: press <key[+mod]>, e.g. press Escape, press Meta+a')
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
  for (const m of mods) { mask |= MOD_BIT[m]; await press('rawKeyDown', m, m + 'Left', MOD_VK[m], mask) }
  // Enter needs its "\r" text: implicit form submission fires on the keypress
  // Chrome derives from it — a bare rawKeyDown never submits
  if (key === 'Enter') await cdp(s, tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mask })
  else await press('rawKeyDown', key, code, vk, mask)
  await press('keyUp', key, code, vk, mask)
  for (const m of mods.reverse()) { mask &= ~MOD_BIT[m]; await press('keyUp', m, m + 'Left', MOD_VK[m], mask) }
  return { text: `pressed ${chunk}` }
}

/** @param {Session} s */
export async function selectCmd(s, sel, val) {
  const tab = await resolveTab(s)
  const r = await pageCall(s, tab.id, 'select', { sel, value: String(val) })
  if (r.error) throw new Error(r.error + (r.options ? '\navailable options: ' + r.options.map((o) => `${o.value} ("${o.text}")`).join(', ') : ''))
  return { text: `selected "${r.text}" (value=${r.value})`, data: r }
}

const MOUSE_USAGE = 'usage: mouse move <x> <y> [--duration ms] [--steps n] [--human --seed n] | mouse down [button] | mouse up [button] | mouse wheel <dy> [dx]'

/** @param {Session} s @param {string[]} args @param {import('../spec.js').Flags} flags */
export async function mouseCmd(s, args, flags) {
  const sub = args[0]
  const tab = await resolveTab(s)
  const pos = tabState(tab.id).mouse
  if (sub === 'move') {
    const x = Number(args[1]), y = Number(args[2])
    if (args[2] === undefined || Number.isNaN(x) || Number.isNaN(y)) throw new Error(MOUSE_USAGE)
    await mouseMoveTo(s, tab.id, x, y, flags)
    return { text: `mouse at ${x},${y}` }
  }
  if (sub === 'down' || sub === 'up') {
    const btn = args[1] || 'left'
    if (!['left', 'right', 'middle'].includes(btn)) throw new Error('button: left|right|middle')
    const mask = btn === 'left' ? 1 : btn === 'right' ? 2 : 4
    await cdp(s, tab.id, 'Input.dispatchMouseEvent',
      sub === 'down'
        ? { type: 'mousePressed', x: pos.x, y: pos.y, button: btn, buttons: mask, clickCount: 1 }
        : { type: 'mouseReleased', x: pos.x, y: pos.y, button: btn, buttons: 0, clickCount: 1 })
    return { text: `${sub} ${btn} at ${pos.x},${pos.y}` }
  }
  if (sub === 'wheel') {
    const dy = Number(args[1] || 0), dx = Number(args[2] || 0)
    await cdp(s, tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: pos.x, y: pos.y, deltaX: dx, deltaY: dy })
    return { text: `wheel dy=${dy} dx=${dx} at ${pos.x},${pos.y}` }
  }
  throw new Error(MOUSE_USAGE)
}
