/* Small helpers shared by both pages. */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(method, url, body, opts = {}) {
    const init = { method, headers: { 'X-Video-Review': '1' } };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
      else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok && !opts.allow?.includes(res.status)) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status; err.data = data;
      throw err;
    }
    return opts.allow ? { status: res.status, data } : data;
  }

  /** Upload with progress (fetch can't report upload progress). */
  function upload(method, url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('X-Video-Review', '1');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { data = { error: xhr.responseText }; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Upload failed — is the app still running?'));
      xhr.send(blob);
    });
  }

  function toast(message, opts = {}) {
    let box = $('#toasts');
    if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
    const el = h('div', { class: 'toast' + (opts.error ? ' error' : '') }, h('span', {}, message));
    if (opts.action) el.append(h('button', { onclick: () => { opts.action.run(); el.remove(); } }, opts.action.label));
    box.append(el);
    setTimeout(() => el.remove(), opts.ms || (opts.error ? 7000 : 3200));
    return el;
  }

  /** A simple modal. Returns { el, close, body, footer }. */
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const back = h('div', { class: 'modal-back' });
    const footer = h('footer');
    const bodyEl = h('div', { class: 'body' }, body);
    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', {}, h('h2', {}, title)), bodyEl, footer);
    back.append(box);
    const prevFocus = document.activeElement;
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    for (const a of actions) {
      footer.append(h('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: () => a.run(close) }, a.label));
    }
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    const first = box.querySelector('input, textarea, select, button.primary, button');
    if (first) setTimeout(() => first.focus(), 0);
    return { el: box, close, body: bodyEl, footer };
  }

  function confirmBox(title, text, okLabel = 'OK', kind = 'primary') {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title, body: h('p', {}, text),
        actions: [
          { label: 'Cancel', run: (close) => { done = true; resolve(false); close(); } },
          { label: okLabel, kind, run: (close) => { done = true; resolve(true); close(); } },
        ],
        onClose: () => { if (!done) resolve(false); },
      });
      return m;
    });
  }

  function ago(ms) {
    if (!ms) return '';
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
    return new Date(ms).toLocaleDateString();
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 ** 2) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
    return (n / 1024 ** 3).toFixed(2) + ' GB';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { style: { position: 'fixed', left: '-9999px' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  const ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
    prev: '<path d="M18 6l-8 6 8 6zM7 6v12"/>',
    next: '<path d="M6 6l8 6-8 6zM17 6v12"/>',
    split: '<path d="M6 3l12 18M18 3L6 21"/><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    speed: '<path d="M12 14l4-4"/><path d="M3.5 18a9 9 0 1 1 17 0"/>',
    volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    note: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    logo: '<path d="M8 5.5v13l10-6.5z" fill="#fff" stroke="none"/>',
    pin: '<path d="M12 21s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  function icon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  window.UI = { $, $$, h, api, upload, toast, modal, confirmBox, ago, bytes, copyText, icon };
})();
