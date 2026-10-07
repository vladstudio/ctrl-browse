// Runs inside the page: the daemon evaluates this function once per page
// context and then calls it as fn(op, arg) — the small DOM operations behind
// click, fill, select, get, wait… Arguments arrive as JSON values, so
// command-line text is never spliced into code.
function (op, arg) {
  // "@e3" → the element snapshot/find tagged; anything else is a CSS selector
  const find = (sel) => {
    sel = String(sel)
    return document.querySelector(sel.startsWith('@') ? `[data-cb-ref=${JSON.stringify(sel.slice(1))}]` : sel)
  }
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  // a contains b, across shadow roots (elementFromPoint returns the shadow host)
  const within = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false }
  // rendered text; textContent only where innerText doesn't exist (non-browser DOMs)
  const text = (el) => String(el.innerText ?? el.textContent ?? '')
  const fire = (el, ...types) => { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })) }
  // the prototype's setter, so React-style value tracking sees the change
  const setValue = (el, proto, v) => {
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (desc && desc.set) desc.set.call(el, v); else el.value = v
  }

  // where a trusted click should land, or what is in the way
  function click({ sel, force }) {
    const el = find(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const pt = (fx, fy) => ({ x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) })
    const center = pt(0.5, 0.5)
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    const hit = document.elementFromPoint(center.x, center.y)
    if (!hit || within(el, hit) || within(hit, el)) return { ...center, disabled }
    // describe what is on top, so the caller knows how to get it out of the way
    const t = squash(hit.getAttribute('aria-label') || text(hit))
    const cls = typeof hit.className === 'string' ? hit.className.trim().split(/\s+/).slice(0, 3).join(' ') : ''
    const role = hit.getAttribute('role')
    const covered = `<${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}${role ? ' role=' + role : ''}${!t && cls ? ` class="${cls}"` : ''}>` +
      (t ? ` "${t.length > 50 ? t.slice(0, 50) + '…' : t}"` : '')
    if (force) return { ...center, disabled, forced: covered }
    // only the center is covered (a toast or badge over its middle): click a visible part instead
    for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      const p = pt(fx, fy)
      const h = document.elementFromPoint(p.x, p.y)
      if (h && within(el, h)) return { ...p, disabled }
    }
    const dlg = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')]
      .find((d) => d.getClientRects().length && !within(d, el))
    let dialog = null
    if (dlg) {
      const lb = (dlg.getAttribute('aria-labelledby') || '').split(' ')[0]
      const le = lb && document.getElementById(lb)
      const hd = dlg.querySelector('h1, h2, h3, [role=heading]')
      dialog = squash(dlg.getAttribute('aria-label') || (le && text(le)) || (hd && text(hd))).slice(0, 60) || 'untitled'
    }
    return { ...center, disabled, covered, dialog }
  }

  function fill({ sel, value }) {
    const el = find(sel)
    if (!el) return null
    el.focus()
    if (el.isContentEditable) {
      // select existing content for replacement — editors (Lexical, ProseMirror…)
      // ignore DOM writes and synthetic events, so the caller completes this
      // fill with a trusted Input.insertText
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return { editable: true }
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    setValue(el, proto, value)
    fire(el, 'input', 'change')
    return { ok: el.value === value, value: el.type === 'password' ? '[REDACTED]' : el.value }
  }

  function select({ sel, value }) {
    const el = find(sel)
    if (!el) return { error: 'element not found: ' + sel }
    if (el.tagName !== 'SELECT') return { error: `not a <select> (tag: ${el.tagName.toLowerCase()})` }
    const opts = [...el.options]
    const opt = opts.find((o) => o.value === value) || opts.find((o) => o.text.trim() === value)
    if (!opt) return { error: 'no option with value or label: ' + value, options: opts.slice(0, 50).map((o) => ({ value: o.value, text: o.text })) }
    setValue(el, HTMLSelectElement.prototype, opt.value)
    fire(el, 'input', 'change')
    return { value: el.value, text: el.selectedOptions[0] ? el.selectedOptions[0].text : '' }
  }

  // screenshot clip in document coordinates
  function clip({ el: sel, full, pad = 0 }) {
    if (sel) {
      const el = find(sel)
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const b = el.getBoundingClientRect()
      const x = Math.max(0, b.left + scrollX - pad), y = Math.max(0, b.top + scrollY - pad)
      return { x, y, width: b.right + scrollX + pad - x, height: b.bottom + scrollY + pad - y, dpr: devicePixelRatio }
    }
    const d = document.documentElement
    if (full) return { x: 0, y: 0, width: d.scrollWidth, height: d.scrollHeight, dpr: devicePixelRatio }
    return { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }
  }

  function storage({ sub, kind, key, value }) {
    const sto = kind === 'local' ? localStorage : sessionStorage
    if (sub === 'get') return sto.getItem(key)
    if (sub === 'set') sto.setItem(key, value)
    else if (key) sto.removeItem(key)
    else sto.clear()
    return true
  }

  const ops = {
    click, fill, select, clip, storage,
    focus: ({ sel }) => { const el = find(sel); if (el) el.focus(); return !!el },
    scroll: ({ sel }) => { const el = find(sel); if (el) el.scrollIntoView({ block: 'center' }); return !!el },
    get: ({ sel, what }) => { const el = find(sel); return !el ? null : what === 'html' ? el.innerHTML : text(el) },
    exists: ({ sel }) => !!find(sel),
    'has-text': ({ text: needle }) => !!document.body && text(document.body).includes(needle),
    dom: () => document.documentElement.outerHTML,
  }
  if (!Object.hasOwn(ops, op)) throw new Error('unknown page op: ' + op)
  return ops[op](arg || {})
}
