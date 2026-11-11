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
    if (board.title) document.title = board.title + ' · Rise in the Gap';
    var snap = document.getElementById('ritg-snap');
    if (snap && board.snapshot) snap.textContent = board.snapshot;

    var root = document.getElementById('dash-root');
    var tpl = document.createElement('template');
    tpl.innerHTML = board.html;
    var scripts = [];
    tpl.content.querySelectorAll('script').forEach(function (s) { scripts.push(s.textContent); s.remove(); });
    tpl.content.querySelectorAll('meta').forEach(function (s) { s.remove(); });
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

    function drawName(name) { targets(name).forEach(function (el) { drawOne(name, el); }); }

    function drawAll() {
      onDataFns.forEach(function (fn) { try { fn(); } catch (e) { console.error('onData failed', e); } });
      draws.forEach(function (_, name) { drawName(name); });
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
      _start: function () {
        started = true;
        drawAll();

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
