/* Rise in the Gap board runtime.
   Opens an encrypted board snapshot with the key in the link's #fragment (never sent to the server),
   then runs the board's own scripts against its saved datasets. No client data lives in this file. */
(function () {
  'use strict';

  var SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map(function (i) { return 'var(--series-' + i + ')'; });
  var MSG = {
    opening: 'Opening your board…',
    noKey: 'This board opens only from the private link Rise in the Gap sent you. Please open that link, or reply to our email and we will resend it.',
    badKey: 'This link is incomplete or out of date. Please open the latest link Rise in the Gap sent you, or reply to our email and we will resend it.',
    oldBrowser: 'This browser cannot open the board. Please try a current version of Chrome, Safari or Edge.',
    noCharts: 'The chart library did not load. Please check your connection and reload the page.'
  };

  function b64ToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function message(text) {
    var root = document.getElementById('dash-root');
    var p = document.createElement('p');
    p.className = 'ritg-msg';
    p.textContent = text;
    root.replaceChildren(p);
  }

  async function open(packedId) {
    // A pasted or corrected link that differs only after the # must open afresh.
    window.addEventListener('hashchange', function () { location.reload(); });
    message(MSG.opening);
    var m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{43})(?:&|$)/);
    if (!m) { message(MSG.noKey); return; }
    if (!window.crypto || !crypto.subtle || !window.TextDecoder) { message(MSG.oldBrowser); return; }
    if (!window.d3) { message(MSG.noCharts); return; }
    var packed = JSON.parse(document.getElementById(packedId).textContent);
    var plain;
    try {
      var key = await crypto.subtle.importKey('raw', b64ToBytes(m[1]), { name: 'AES-GCM' }, false, ['decrypt']);
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(packed.iv) }, key, b64ToBytes(packed.ct));
    } catch (e) {
      message(MSG.badKey);
      return;
    }
    mount(JSON.parse(new TextDecoder().decode(plain)));
  }

  function mount(board) {
    var title = (board.template && board.template.title) || board.title;
    if (title) document.title = title + ' · Rise in the Gap';
    var snap = document.getElementById('ritg-snap');
    if (snap && board.snapshot) snap.textContent = board.snapshot;

    var root = document.getElementById('dash-root');
    var tpl = document.createElement('template');
    tpl.innerHTML = board.html;
    var scripts = [];
    tpl.content.querySelectorAll('script').forEach(function (s) { scripts.push(s.textContent); s.remove(); });
    tpl.content.querySelectorAll('meta').forEach(function (s) { s.remove(); });
    if (board.template) {
      try { applyTemplate(tpl.content, board.template); } catch (e) { console.error('Board template failed', e); }
    }
    root.replaceChildren(tpl.content);

    var dash = makeDash(board.data || {}, root);
    window.dash = dash;
    scripts.forEach(function (code, i) {
      try {
        // Each board script runs in its own scope, as it did on the original board.
        new Function('dash', code).call(window, dash);
      } catch (e) {
        console.error('Board script ' + (i + 1) + ' failed', e);
      }
    });
    dash._start();
    tools(board, root, dash);
  }

  /* ---------- Shared client template ----------
     The scorecard uses the board's own drawn values. The template adds short priorities and keeps
     the original action list, results, channels and methodology available lower down. */

  var GROUPS = [
    { key: 'results', label: 'Results' },
    { key: 'work', label: 'What we did' },
    { key: 'calls', label: 'Calls' },
    { key: 'online', label: 'Google and social' }
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function stripIds(node) {
    if (node.removeAttribute) node.removeAttribute('id');
    if (node.querySelectorAll) node.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    return node;
  }

  function applyTemplate(frag, t) {
    var gp = frag.querySelector('.gp');
    if (!gp) return;
    function orig(name) { return frag.querySelector('[data-draw="' + name + '"]'); }
    function value(name) {
      var o = orig(name);
      var c = o ? stripIds(o.cloneNode(true)) : el('b');
      if (!o) c.setAttribute('data-draw', name);
      c.classList.remove('gp-big');
      return c;
    }
    function fill(target, text) {
      String(text).split(/(\{[^}]+\})/).forEach(function (part) {
        if (!part) return;
        var m = part.match(/^\{(.+)\}$/);
        target.appendChild(m ? value(m[1]) : document.createTextNode(part));
      });
      return target;
    }

    // A section, or a wrapper (such as a two-column row) holding several sections, moves as one unit.
    var sections = {};
    var units = [];
    Array.prototype.forEach.call(gp.children, function (c) {
      if (c.classList.contains('gp-head') || c.classList.contains('gp-foot')) return;
      var ids = c.tagName === 'SECTION' && c.id ? [c.id]
        : Array.prototype.map.call(c.querySelectorAll('section[id]'), function (s) { return s.id; });
      if (!ids.length) return;
      units.push(c);
      ids.forEach(function (id) { sections[id] = c; });
    });
    var usedUnits = [];
    function take(id) {
      var u = sections[id];
      if (!u || usedUnits.indexOf(u) >= 0) return null;
      usedUnits.push(u);
      return u;
    }

    // Hero: the board's own eyebrow and title, then one line on the period. The long opening paragraph moves
    // to the top of Results, and the read times move to About this data.
    var head = gp.querySelector('.gp-head');
    var intro = head && head.querySelector('.gp-take');
    var asof = head && head.querySelector('.gp-asof');
    var title = head && head.querySelector('h1');
    if (title && t.title) title.textContent = t.title;
    if (intro) intro.remove();
    if (asof) asof.remove();
    if (head && t.period) head.appendChild(el('p', 'rt-period', t.period));

    // Scorecard
    var score = el('div', 'rt-score');
    score.setAttribute('role', 'list');
    score.setAttribute('aria-label', 'Performance at a glance');
    (t.tiles || []).forEach(function (tile) {
      var d = el('div', 'rt-tile');
      d.setAttribute('role', 'listitem');
      d.appendChild(el('p', 'rt-k', tile.label));
      var v = el('p', 'rt-v');
      v.appendChild(value(tile.value));
      d.appendChild(v);
      var bar = tile.bar && orig(tile.bar);
      var pace = false;
      if (bar && bar.parentElement) {
        var meter = stripIds(bar.parentElement.cloneNode(true));
        meter.setAttribute('aria-hidden', 'true');
        pace = Boolean(meter.querySelector('.gp-bar-tick'));
        if (pace) meter.classList.add('rt-pace-bar');
        d.appendChild(meter);
      }
      if (tile.sub) {
        var s = el('p', 'rt-s');
        if (tile.cmp) {
          var a = el('span', 'rt-arrow');
          a.setAttribute('data-v', tile.value);
          a.setAttribute('data-r', tile.cmp);
          a.setAttribute('aria-hidden', 'true');
          s.appendChild(a);
        }
        d.appendChild(fill(s, tile.sub));
      }
      if (tile.note) d.appendChild(fill(el('p', 'rt-n'), tile.note));
      if (pace) d.appendChild(el('p', 'rt-pace'));
      score.appendChild(d);
    });

    // Keep the short priorities above navigation and retain the original levers in the details.
    var next = null;
    if (t.priorities && t.priorities.length) {
      next = el('section', 'gp-sec rt-next');
      var heading = el('h2', 'gp-h2', 'What to do next');
      heading.id = 'rt-next-title';
      next.setAttribute('aria-labelledby', heading.id);
      next.appendChild(heading);
      var priorities = el('ul', 'rt-priorities');
      t.priorities.forEach(function (priority) {
        var item = el('li');
        item.appendChild(el('span', 'rt-owner', priority.owner));
        item.appendChild(el('span', 'rt-action', priority.action));
        priorities.appendChild(item);
      });
      next.appendChild(priorities);

      var full = sections.levers && sections.levers.querySelector('.gp-h2, h2');
      if (full) full.textContent = 'Full action list';
    } else {
      // Older snapshots already in a reader's cache still use their original action list.
      next = take('levers');
    }
    if (next && !next.classList.contains('rt-next')) {
      next.classList.add('rt-next');
      var h = next.querySelector('.gp-h2, h2');
      if (h) h.textContent = 'What to do next';
    }

    // Groups
    var groups = t.groups || {};
    var built = [];
    GROUPS.forEach(function (g) {
      var ids = g.key === 'work' ? (groups.work || ['work']) : (groups[g.key] || []);
      var secs = ids.map(take).filter(Boolean);
      if (g.key === 'results' && intro) {
        intro.classList.add('rt-intro');
        secs.unshift(intro);
      }
      if (!secs.length) return;
      var box = el('div', 'rt-group');
      box.id = 'rt-' + g.key;
      var count = secs.reduce(function (n, s) { return n + (s.tagName === 'SECTION' ? 1 : s.querySelectorAll('section').length); }, 0);
      if (count > 1) box.appendChild(el('h2', 'rt-glabel', g.label));
      secs.forEach(function (s) { box.appendChild(s); });
      built.push({ key: g.key, label: g.label, node: box });
    });

    // Everything else, closed until asked for.
    var rest = units.filter(function (u) { return usedUnits.indexOf(u) < 0; });
    if (rest.length) {
      var more = el('details', 'rt-more');
      more.id = 'rt-more';
      var sum = el('summary');
      sum.appendChild(el('span', 'rt-mt', 'All the numbers'));
      sum.appendChild(el('span', 'rt-mh', rest.map(function (s) {
        return Array.prototype.map.call(s.querySelectorAll('h2'), function (hh) { return hh.textContent.trim(); }).join(' · ');
      }).filter(Boolean).join(' · ')));
      more.appendChild(sum);
      var inner = el('div', 'rt-more-in');
      rest.forEach(function (s) { inner.appendChild(s); });
      more.appendChild(inner);
      built.push({ key: 'more', label: 'All the numbers', node: more });
    }

    // About this data: read times, how the numbers are counted.
    var foot = gp.querySelector('details.gp-foot');
    var about = el('section', 'gp-sec rt-about');
    about.id = 'rt-about';
    about.appendChild(el('h2', 'gp-h2', 'About this data'));
    if (asof) {
      var ul = el('ul', 'rt-asof');
      Array.prototype.forEach.call(asof.children.length ? asof.children : [asof], function (sp) {
        var li = el('li');
        while (sp.firstChild) li.appendChild(sp.firstChild);
        ul.appendChild(li);
      });
      about.appendChild(ul);
    }
    if (foot) about.appendChild(foot);

    // Jump buttons. They scroll in place: a #link would drop the board's key from the address.
    var jump = el('nav', 'rt-jump');
    jump.setAttribute('aria-label', 'Sections');
    built.concat([{ key: 'about', label: 'About this data', node: about }]).forEach(function (g) {
      var btn = el('button', null, g.label);
      btn.type = 'button';
      btn.setAttribute('aria-controls', g.node.id);
      btn.addEventListener('click', function () {
        if (g.node.tagName === 'DETAILS') g.node.open = true;
        var target = g.node.querySelector('summary, h2, h3');
        if (target) {
          if (target.tagName !== 'SUMMARY') target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
        var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        g.node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      });
      jump.appendChild(btn);
    });

    // New order inside the board.
    var order = [score];
    if (t.note) order.push(el('p', 'rt-board-note', t.note));
    if (next) order.push(next);
    order.push(jump);
    built.forEach(function (g) { order.push(g.node); });
    order.push(about);
    var anchor = head && head.parentElement === gp ? head.nextSibling : gp.firstChild;
    order.forEach(function (n) { gp.insertBefore(n, anchor); });
  }

  function num(text) {
    var m = String(text || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    var n = parseFloat(m[0]);
    if (/\d\s*K\b/i.test(text)) n *= 1000;
    return n;
  }

  // Up or down arrows on tiles that compare the same days of two months.
  function arrows(root) {
    root.querySelectorAll('.rt-arrow').forEach(function (a) {
      var tile = a.closest('.rt-tile');
      var v = tile && tile.querySelector('[data-draw="' + a.getAttribute('data-v') + '"]');
      var r = tile && tile.querySelector('.rt-s [data-draw="' + a.getAttribute('data-r') + '"]');
      var nv = v && num(v.textContent), nr = r && num(r.textContent);
      a.className = 'rt-arrow';
      a.textContent = '';
      if (nv == null || nr == null || nv === nr) return;
      a.classList.add(nv > nr ? 'rt-up' : 'rt-down');
      a.textContent = nv > nr ? '▲ ' : '▼ ';
    });
  }

  // Pair the source board's visual pace marker with a text comparison on the scorecard.
  function paceLabels(root) {
    root.querySelectorAll('.rt-pace-bar').forEach(function (meter) {
      var status = meter.parentElement.querySelector('.rt-pace');
      var fill = meter.querySelector('.gp-bar-fill');
      var tick = meter.querySelector('.gp-bar-tick');
      var progress = fill && parseFloat(fill.style.width);
      var marker = tick && parseFloat(tick.style.left);
      if (!status || !Number.isFinite(progress) || !Number.isFinite(marker)) return;
      var label = 'At pace';
      if (progress < marker) label = 'Behind pace';
      if (progress > marker) label = 'Ahead of pace';
      status.textContent = label;
    });
  }

  // Wide tables read as stacked cards on a phone: each cell carries its column name.
  function labelTables(root) {
    root.querySelectorAll('table').forEach(function (tb) {
      var head = tb.tHead && tb.tHead.rows.length ? tb.tHead.rows[tb.tHead.rows.length - 1] : null;
      if (!head) return;
      var names = Array.prototype.map.call(head.cells, function (c) { return c.textContent.trim(); });
      if (names.length >= 4) tb.classList.add('rt-stack');
      Array.prototype.forEach.call(tb.tBodies, function (body) {
        Array.prototype.forEach.call(body.rows, function (row) {
          Array.prototype.forEach.call(row.cells, function (cell, i) {
            if (names[i] && cell.getAttribute('data-label') !== names[i]) cell.setAttribute('data-label', names[i]);
          });
        });
      });
    });
  }

  function tools(board, root, dash) {
    var upd = document.getElementById('ritg-upd');
    if (upd && board.updated) { upd.textContent = board.updated; upd.hidden = false; }
    var pdf = document.getElementById('ritg-pdf');
    if (pdf) {
      pdf.hidden = false;
      pdf.addEventListener('click', function () { window.print(); });
    }
    // Print and Save as PDF: light colours, every section open.
    var printState = null;
    window.addEventListener('beforeprint', function () {
      if (printState) return;
      printState = {
        theme: document.documentElement.getAttribute('data-theme'),
        opened: Array.from(root.querySelectorAll('details:not([open])'))
      };
      document.documentElement.setAttribute('data-theme', 'light');
      printState.opened.forEach(function (d) { d.open = true; });
      dash._redraw();
    });
    window.addEventListener('afterprint', function () {
      if (!printState) return;
      if (printState.theme !== null) document.documentElement.setAttribute('data-theme', printState.theme);
      else document.documentElement.removeAttribute('data-theme');
      printState.opened.forEach(function (d) { d.open = false; });
      printState = null;
      dash._redraw();
    });
  }

  function makeDash(data, root) {
    var calcs = new Map();
    var memo = new Map();
    var draws = new Map();
    var mounted = new WeakMap();
    var onDataFns = [];
    var started = false;

    function asRows(v) {
      if (v && !Array.isArray(v) && typeof v === 'object') {
        if (Array.isArray(v.rows)) v = v.rows;
        else if (Array.isArray(v.data)) v = v.data;
        else if (Array.isArray(v.results)) v = v.results;
      }
      if (Array.isArray(v) && !v.columns) {
        Object.defineProperty(v, 'columns', { value: v.length && v[0] && typeof v[0] === 'object' ? Object.keys(v[0]) : [], enumerable: false });
      }
      return v;
    }
    Object.keys(data).forEach(function (k) { data[k] = asRows(data[k]); });

    function result(status, value, msg) {
      return { status: status, data: value, message: msg || null, refreshing: false, meta: {} };
    }

    function read(id) {
      if (Object.prototype.hasOwnProperty.call(data, id)) return result('ok', data[id]);
      var c = calcs.get(id);
      if (c) {
        if (!memo.has(id)) {
          try {
            var args = (c.inputs || []).map(function (inp) {
              var d = read(inp);
              if (d.status === 'ok') return d.data;
              return calcs.has(inp) ? null : [];
            });
            memo.set(id, { ok: true, value: asRows(c.fn.apply(null, args)) });
          } catch (e) {
            console.error('Calculation ' + id + ' failed', e);
            memo.set(id, { ok: false, error: e });
          }
        }
        var r = memo.get(id);
        return r.ok ? result('ok', r.value) : result('error', null, String((r.error && r.error.message) || r.error));
      }
      return result('missing', [], 'This source is not on the board.');
    }

    function targets(name) {
      var sel = '[data-draw="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]';
      return Array.prototype.filter.call(root.querySelectorAll(sel), function (el) {
        if (el.closest('[hidden]')) return false;
        // Closed sections draw when opened, at their real width.
        var shut = el.closest('details:not([open])');
        if (shut && !el.closest('summary')) return false;
        var parent = el.parentElement;
        return !(parent && parent.closest('[data-draw]'));
      });
    }

    function drawOne(name, el) {
      var spec = draws.get(name);
      if (!spec) return;
      try {
        if (typeof spec === 'function') { spec(el); return; }
        var st = mounted.get(el);
        if (!st) {
          el.replaceChildren();
          st = { made: spec.mount ? spec.mount(el) : undefined };
          mounted.set(el, st);
        }
        if (spec.update) spec.update(el, st.made);
      } catch (e) {
        console.error('Drawing ' + name + ' failed', e);
        if (spec && typeof spec === 'object' && spec.unmount) { try { spec.unmount(el, (mounted.get(el) || {}).made); } catch (x) { /* ignore */ } }
        mounted.delete(el);
      }
    }

    function after() {
      try { labelTables(root); arrows(root); paceLabels(root); } catch (e) { console.error('Template pass failed', e); }
    }

    function drawName(name, quiet) {
      targets(name).forEach(function (el) { drawOne(name, el); });
      if (!quiet) after();
    }

    function drawAll() {
      onDataFns.forEach(function (fn) { try { fn(); } catch (e) { console.error('onData failed', e); } });
      draws.forEach(function (_, name) { drawName(name, true); });
      after();
    }

    var pending = 0;
    function drawAllSoon() {
      if (pending) return;
      pending = requestAnimationFrame(function () { pending = 0; drawAll(); });
    }

    var dash = {
      colors: SERIES,
      data: read,
      calc: function (id, spec) { calcs.set(id, spec || {}); memo.delete(id); },
      loader: function () { /* snapshot data is already rows */ },
      onData: function (fn) {
        onDataFns.push(fn);
        try { fn(); } catch (e) { console.error('onData failed', e); }
      },
      draw: function (name, spec) {
        if (spec === undefined) { if (started) drawName(name); return; }
        draws.set(name, spec);
        if (started) drawName(name);
      },
      refresh: function () { /* a snapshot does not refresh */ },
      params: function () { return {}; },
      setParams: function () {},
      resetParams: function () {},
      setLink: function () {},
      _redraw: function () { drawAll(); },
      _start: function () {
        started = true;
        drawAll();

        // A section opened from "All the numbers" or "How these numbers are counted" draws then.
        root.addEventListener('toggle', function (e) { if (e.target.open) drawAll(); }, true);

        // Redraw when the page width changes (charts size themselves from it).
        var lastWidth = root.clientWidth;
        if (window.ResizeObserver) {
          new ResizeObserver(function () {
            var w = root.clientWidth;
            if (Math.abs(w - lastWidth) >= 1) { lastWidth = w; drawAllSoon(); }
          }).observe(root);
        }

        // Draw a section once a control un-hides it. Changes inside a drawing (tooltips) are ignored.
        new MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) {
            var mu = list[i];
            var t = mu.target;
            if (mu.oldValue === null || t.hasAttribute('hidden')) continue;
            var parent = t.parentElement;
            if (parent && parent.closest('[data-draw]')) continue;
            drawAllSoon();
            return;
          }
        }).observe(root, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true, subtree: true });
      }
    };
    return dash;
  }

  window.RitgBoard = { open: open };
})();
