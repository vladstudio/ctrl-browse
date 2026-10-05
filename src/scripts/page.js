// Runs inside the page (via Runtime.evaluate): snapshot mode and find mode.
function (opts) {
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, PATH: 1 }
  var INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [contenteditable=""], [onclick], [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="switch"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="searchbox"], [role="treeitem"]'

  function roleOf(el) {
    var role = (el.getAttribute('role') || '').toLowerCase()
    if (role) return role
    var t = el.tagName
    if (t === 'A') return 'link'
    if (t === 'BUTTON') return 'button'
    if (t === 'SELECT') return 'combobox'
    if (t === 'TEXTAREA') return 'textbox'
    if (t === 'SUMMARY') return 'button'
    if (t === 'OPTION') return 'option'
    if (t[0] === 'H' && t[1] >= '1' && t[1] <= '6') return 'heading'
    if (t === 'INPUT') {
      if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') return 'button'
      if (el.type === 'checkbox') return 'checkbox'
      if (el.type === 'radio') return 'radio'
      return 'textbox'
    }
    return ''
  }

  function refOf(el) {
    window.__cbRefSeq = window.__cbRefSeq || 0
    var ref = 'e' + (++window.__cbRefSeq)
    el.setAttribute('data-cb-ref', ref)
    return ref
  }

  function visible(el) {
    var r = el.getBoundingClientRect()
    return (r.width >= 1 || r.height >= 1) && !(r.bottom < 0 && r.top < 0)
  }

  function labelFor(el) {
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (l) return l.innerText || l.textContent
      }
      var p = el.closest('label')
      if (p) return p.innerText || p.textContent
    } catch (e) {}
    return ''
  }

  function snapshot(opts) {
    var sel = opts.interactive ? INTERACTIVE : INTERACTIVE + ', h1, h2, h3, h4, h5, h6'
    var res = { title: document.title, url: location.href, elements: [] }
    if (!document.body) return res
    var els = Array.prototype.slice.call(document.querySelectorAll(sel))
    var seen = new Set()
    for (var i = 0; i < els.length && res.elements.length < (opts.limit || 150); i++) {
      var el = els[i]
      var t = el.tagName
      if (seen.has(el) || SKIP[t] || !visible(el) || el.getAttribute('aria-hidden') === 'true') continue
      seen.add(el)
      var item = {
        ref: refOf(el),
        tag: t.toLowerCase(),
        role: roleOf(el) || t.toLowerCase(),
        text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      }
      var label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || labelFor(el) || ''
      if (label && label !== item.text) item.name = String(label).replace(/\s+/g, ' ').trim().slice(0, 60)
      if (el.type) item.type = String(el.type)
      if (el.value !== undefined && el.value !== '' && el.value !== null) item.value = String(el.value).slice(0, 60)
      if (t === 'A' && el.href) item.href = el.href
      if (el.checked === true) item.checked = true
      if (el.disabled === true) item.disabled = true
      if (item.role === 'heading') item.level = t[1]
      res.elements.push(item)
    }
    return res
  }

  function findRole(want) {
    var els = document.querySelectorAll('a, button, select, textarea, summary, input, [role], [onclick], [tabindex], [contenteditable]')
    var out = []
    for (var i = 0; i < els.length && out.length < 20; i++) {
      var el = els[i]
      var role = roleOf(el)
      if (role.toLowerCase() !== want || !visible(el)) continue
      out.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), role: role, text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80) })
    }
    return out
  }

  function findText(needle) {
    var out = []
    var seen = new Set()
    var w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
    while (w.nextNode() && out.length < 20) {
      var v = w.currentNode.nodeValue || ''
      if (!v.toLowerCase().includes(needle)) continue
      var el = w.currentNode.parentElement
      if (!el || SKIP[el.tagName] || seen.has(el) || !visible(el)) continue
      seen.add(el)
      out.push({ ref: refOf(el), tag: el.tagName.toLowerCase(), role: roleOf(el) || el.tagName.toLowerCase(), text: String(el.innerText || v).replace(/\s+/g, ' ').trim().slice(0, 100) })
    }
    return out
  }

  if (opts.find) {
    var needle = String(opts.find.needle).toLowerCase()
    return opts.find.kind === 'role' ? findRole(needle) : findText(needle)
  }
  return snapshot(opts)
}