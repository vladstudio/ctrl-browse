function () {
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, FRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, SOURCE: 1, TRACK: 1, MAP: 1, DIALOG: 1, LINK: 1, META: 1, TITLE: 1, PATH: 1, DEFS: 1, USE: 1, SVG: 1 }
  var INLINE = { A: 1, SPAN: 1, STRONG: 1, B: 1, EM: 1, I: 1, CODE: 1, SMALL: 1, U: 1, S: 1, MARK: 1, ABBR: 1, SUB: 1, SUP: 1, KBD: 1, CITE: 1, Q: 1, TIME: 1, VAR: 1, SAMP: 1, DEL: 1, INS: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, IMG: 1, BR: 1, FONT: 1, BIG: 1, WBR: 1 }
  var lines = []

  // render one inline node (self, including leaf inputs/links); inlineOf renders
  // a container's children by mapping them over this
  function inlineOne(n) {
    if (n.nodeType === 3) return String(n.nodeValue)
    if (n.nodeType !== 1) return ''
    var t = n.tagName
    if (SKIP[t]) return ''
    if (t === 'BR') return '\n'
    if (t === 'A') {
      var inner = inlineOf(n).replace(/\s+/g, ' ').trim()
      var href = n.getAttribute('href') ? n.href : ''
      return href ? ('[' + (inner || href) + '](' + href + ')') : inner
    }
    if (t === 'IMG') return '![' + (n.getAttribute('alt') || '') + '](' + (n.currentSrc || n.src || '') + ')'
    if (t === 'STRONG' || t === 'B') return '**' + inlineOf(n).replace(/\s+/g, ' ').trim() + '**'
    if (t === 'EM' || t === 'I') return '*' + inlineOf(n).replace(/\s+/g, ' ').trim() + '*'
    if (t === 'CODE') return '`' + inlineOf(n).trim() + '`'
    if (t === 'BUTTON') return ' [button: ' + inlineOf(n).replace(/\s+/g, ' ').trim() + ']'
    if (t === 'INPUT') {
      var ty = n.getAttribute('type') || 'text'
      var ph = n.getAttribute('placeholder') || n.getAttribute('name') || ''
      var v = ty === 'password' ? '' : (n.value || '') // typed passwords never appear in output
      return ' [input ' + ty + (ph ? ' ' + ph : '') + (v ? ' = ' + v : '') + ']'
    }
    if (t === 'SELECT') return ' [select ' + (n.getAttribute('name') || '') + ': ' + (n.selectedOptions && n.selectedOptions[0] ? n.selectedOptions[0].text : '') + ']'
    if (t === 'TEXTAREA') return ' [textarea ' + (n.getAttribute('name') || '') + ']'
    return ' ' + inlineOf(n) + ' '
  }

  function inlineOf(el) {
    var out = ''
    for (var n = el.firstChild; n; n = n.nextSibling) out += inlineOne(n)
    return out
  }

  function list(el, ordered, depth) {
    var i = 1
    for (var n = el.firstElementChild; n; n = n.nextElementSibling) {
      if (n.tagName !== 'LI') { walk(n); continue }
      var marker = ordered ? (i++) + '.' : '-'
      var own = ''
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) own += c.nodeValue
        else if (c.nodeType === 1 && c.tagName !== 'UL' && c.tagName !== 'OL') own += ' ' + inlineOf(c) + ' '
      }
      lines.push('  '.repeat(depth) + marker + ' ' + own.replace(/\s+/g, ' ').trim())
      for (var c2 = n.firstElementChild; c2; c2 = c2.nextElementSibling) {
        if (c2.tagName === 'UL' || c2.tagName === 'OL') list(c2, c2.tagName === 'OL', depth + 1)
      }
    }
  }

  function table(el) {
    var rows = el.querySelectorAll('tr')
    var out = []
    var max = Math.min(rows.length, 40)
    for (var i = 0; i < max; i++) {
      var cells = []
      var cellEls = rows[i].children
      for (var j = 0; j < cellEls.length && j < 20; j++) {
        cells.push(inlineOf(cellEls[j]).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'))
      }
      if (!cells.length) continue
      out.push('| ' + cells.join(' | ') + ' |')
      if (out.length === 1) out.push('|' + cells.map(function () { return ' --- ' }).join('|') + '|')
    }
    if (out.length) lines.push(out.join('\n'))
  }

  function hidden(el) {
    if (el.hidden) return true
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true
    if (!el.offsetWidth && !el.offsetHeight && !el.clientWidth && !el.clientHeight) {
      try {
        var cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') return true
      } catch (e) {}
    }
    return false
  }

  function walk(el) {
    if (el.nodeType !== 1) return
    var t = el.tagName
    if (SKIP[t] || hidden(el)) return
    switch (t) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        lines.push('#'.repeat(+t[1]) + ' ' + inlineOf(el).replace(/\s+/g, ' ').trim()); return
      case 'P': { var p = inlineOf(el).replace(/\s+/g, ' ').trim(); if (p) lines.push(p); return }
      case 'UL': case 'OL': list(el, t === 'OL', 0); return
      case 'PRE': lines.push('```\n' + (el.textContent || '').replace(/\n+$/, '') + '\n```'); return
      case 'TABLE': table(el); return
      case 'HR': lines.push('---'); return
      case 'BLOCKQUOTE': { var q = inlineOf(el).replace(/\s+/g, ' ').trim(); if (q) lines.push('> ' + q); return }
      case 'DT': { var d = inlineOf(el).replace(/\s+/g, ' ').trim(); if (d) lines.push('**' + d + '**'); return }
      case 'DD': { var d2 = inlineOf(el).replace(/\s+/g, ' ').trim(); if (d2) lines.push(d2); return }
      case 'CAPTION': case 'FIGCAPTION': case 'LEGEND': { var c = inlineOf(el).replace(/\s+/g, ' ').trim(); if (c) lines.push('_' + c + '_'); return }
      case 'IMG': lines.push('![' + (el.getAttribute('alt') || '') + '](' + (el.currentSrc || el.src || '') + ')'); return
      case 'BR': return
    }
    var buf = ''
    function flush() { var b = buf.replace(/\s+/g, ' ').trim(); buf = ''; if (b) lines.push(b) }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { buf += ' ' + n.nodeValue; continue }
      if (n.nodeType !== 1) continue
      var nt = n.tagName
      if (SKIP[nt]) continue
      if (INLINE[nt]) { buf += ' ' + inlineOne(n) + ' '; continue }
      flush()
      walk(n)
    }
    flush()
  }

  walk(document.body || document.documentElement)
  var text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title: document.title, url: location.href, markdown: text }
}