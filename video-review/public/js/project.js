/* Project page: player, notes, timeline editor, Copy moments, exports. */
(function () {
  'use strict';
  const { $, $$, h, api, upload, toast, modal, confirmBox, bytes, copyText, icon } = window.UI;
  const T = window.Timeline;
  const MC = window.MediaCache;

  // ═════════════════════════ state ═════════════════════════
  const params = new URLSearchParams(location.search);
  const S = {
    id: params.get('id'),
    project: null, files: [], posters: {}, review: null, dataPath: '', exportsPath: '', system: {},
    clip: null, mode: 'edit', edit: null, meta: {}, metas: {},
    sel: null, activeNote: null, composer: null,
    pxPerSec: 60, zoomVal: 0,
    undo: [], redo: [], lastCoalesce: null,
    saveTimer: null, saving: false, savePending: false, conflict: false,
    proxy: {}, playError: {}, showDone: false,
  };
  const enc = encodeURIComponent;
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const clamp = T.clamp;
  const isMac = /Mac/i.test(navigator.platform || '');
  const mod = isMac ? '⌘' : 'Ctrl+';

  const stage = $('#stage');
  const stageWrap = $('#stageWrap');
  const tlScroll = $('#tlScroll');
  const tlInner = $('#tlInner');
  const tlLabels = $('#tlLabels');

  // Static button contents
  $('#backBtn').innerHTML = icon('back');
  $('#copyBtn').innerHTML = icon('copy') + '<span>Copy moments</span>';
  $('#exportBtn').innerHTML = icon('export') + '<span>Export</span>';
  $('#prevFrame').innerHTML = icon('prev');
  $('#nextFrame').innerHTML = icon('next');
  $('#playBtn').innerHTML = icon('play');
  $('#addNoteBtn').innerHTML = icon('note') + '<span>Add note</span><span class="kbd">C</span>';
  $('#splitBtn').innerHTML = icon('split') + '<span>Split</span><span class="kbd">S</span>';
  $('#deleteBtn').innerHTML = icon('trash') + '<span>Remove</span>';
  $('#textBtn').innerHTML = icon('text') + '<span>Text</span><span class="kbd">T</span>';
  $('#audioBtn').innerHTML = icon('music') + '<span>Audio</span><span class="kbd">A</span>';
  $('#clipBtn').innerHTML = icon('film') + '<span>Insert clip</span>';
  $('#undoBtn').innerHTML = icon('undo');
  $('#redoBtn').innerHTML = icon('redo');
  $('#resetBtn').innerHTML = icon('reset') + '<span>Reset edit</span>';
  $('#undoBtn').title = `Undo (${mod}Z)`;
  $('#redoBtn').title = `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`;

  // ═════════════════════════ data helpers ═════════════════════════
  const videos = () => S.files.filter((f) => f.kind === 'video');
  const fileInfo = (name) => S.files.find((f) => f.name === name);
  const mediaUrl = (file) => `/media/${enc(S.id)}/${enc(file)}` + (S.proxy[file] ? '?proxy=1' : '');
  const rawUrl = (file) => `/media/${enc(S.id)}/${enc(file)}`;
  const dataUrl = (rel) => `/data/${enc(S.id)}/${rel.split('/').map(enc).join('/')}`;

  function clipRec(file) {
    const clips = S.review.clips;
    if (!clips[file]) clips[file] = { meta: null, edit: null, edited: false, comments: [] };
    clips[file].comments = clips[file].comments || [];
    return clips[file];
  }
  const comments = () => (S.clip && S.review ? clipRec(S.clip).comments : []);
  const fps = () => S.meta.fps || 30;
  const frame = () => 1 / fps();

  function origEdit() {
    if (!S._orig || S._orig.file !== S.clip || S._orig.d !== S.meta.duration) {
      S._orig = { file: S.clip, d: S.meta.duration, edit: T.defaultEdit(S.clip, S.meta) };
    }
    return S._orig.edit;
  }
  const EMPTY_EDIT = { video: [], texts: [], audio: [] };
  const view = () => (!S.edit ? EMPTY_EDIT : S.mode === 'original' ? origEdit() : S.edit);
  let layoutCache = null;
  function L() {
    const v = view();
    if (!layoutCache || layoutCache.v !== v) layoutCache = Object.assign({ v }, T.layout(v));
    return layoutCache;
  }

  /** Media details for any project file (duration, size, fps, channels). */
  const metaJobs = new Map();
  function ensureMeta(file) {
    if (S.metas[file] && S.metas[file].duration) return Promise.resolve(S.metas[file]);
    if (metaJobs.has(file)) return metaJobs.get(file);
    const p = (async () => {
      const cached = S.review.clips[file] && S.review.clips[file].meta;
      let meta = Object.assign({}, cached || {});
      if (S.system.ffprobe && !meta.probed) {
        try {
          const probed = await api('GET', `/api/projects/${enc(S.id)}/probe?file=${enc(file)}`);
          if (probed && !probed.error) meta = Object.assign(meta, probed, { probed: true });
        } catch { /* fall back to the browser */ }
      }
      if (!meta.duration) {
        const info = fileInfo(file);
        const el = document.createElement(info && info.kind === 'audio' ? 'audio' : 'video');
        el.preload = 'metadata';
        el.src = rawUrl(file);
        await new Promise((resolve) => {
          el.onloadedmetadata = () => {
            meta.duration = isFinite(el.duration) ? el.duration : 0;
            if (el.videoWidth) { meta.width = el.videoWidth; meta.height = el.videoHeight; meta.hasVideo = true; }
            resolve();
          };
          el.onerror = () => resolve();
          setTimeout(resolve, 15000);
        });
        el.removeAttribute('src');
      }
      meta.duration = round3(meta.duration || 0);
      S.metas[file] = meta;
      if (fileInfo(file) && fileInfo(file).kind === 'video') clipRec(file).meta = meta;
      return meta;
    })();
    metaJobs.set(file, p);
    p.finally(() => metaJobs.delete(file));
    return p;
  }

  // ═════════════════════════ saving & undo ═════════════════════════
  function setSaveState(text, err) {
    const el = $('#saveState');
    el.textContent = text;
    el.classList.toggle('err', !!err);
  }

  function storeClip() {
    if (!S.clip || !S.edit) return;
    const rec = clipRec(S.clip);
    const untouched = T.isUntouched(S.edit, S.clip, S.meta);
    rec.edit = untouched ? null : S.edit;
    rec.edited = !untouched;
    rec.meta = S.meta;
    rec.updated = new Date().toISOString();
  }

  function scheduleSave() {
    storeClip();
    if (S.conflict) return;
    setSaveState('Saving…');
    S.savePending = true;
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, 400);
  }

  async function save() {
    if (S.saving) { S.saveTimer = setTimeout(save, 300); return; }
    S.saving = true;
    S.savePending = false;
    try {
      const r = await api('PUT', `/api/projects/${enc(S.id)}/review`, { baseRev: S.review.rev || 0, data: S.review }, { allow: [409] });
      if (r.status === 409) {
        S.conflict = true;
        setSaveState('Not saved', true);
        modal({
          title: 'This project changed in another window',
          body: h('p', {}, 'Your notes were saved from another tab or window since this page opened. Reload to see the latest version — the last saved copy is also kept in the project\'s .review/history folder.'),
          actions: [{ label: 'Reload', kind: 'primary', run: () => location.reload() }],
        });
      } else {
        S.review.rev = r.data.rev;
        setSaveState(S.savePending ? 'Saving…' : 'All changes saved');
      }
    } catch (err) {
      setSaveState('Not saved — retrying', true);
      S.savePending = true;
      S.saveTimer = setTimeout(save, 3000);
    } finally {
      S.saving = false;
    }
  }

  /** Saves right away (used when the tab is hidden or closed). */
  function flushSave() {
    if (!S.savePending || S.conflict || S.saving) return;
    clearTimeout(S.saveTimer);
    S.savePending = false;
    const body = JSON.stringify({ baseRev: S.review.rev || 0, data: S.review });
    fetch(`/api/projects/${enc(S.id)}/review`, {
      method: 'PUT', keepalive: body.length < 60000, body,
      headers: { 'Content-Type': 'application/json', 'X-Video-Review': '1' },
    }).then((r) => r.json()).then((d) => { if (d && d.rev) { S.review.rev = d.rev; setSaveState('All changes saved'); } }).catch(() => { S.savePending = true; });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', (e) => {
    flushSave();
    if (S.saving) { e.preventDefault(); e.returnValue = ''; }
  });

  const snapshot = () => JSON.stringify({ edit: S.edit, comments: comments() });

  /** Wraps every change so it can be undone and gets saved. */
  function mutate(fn, coalesce) {
    const now = Date.now();
    if (!(coalesce && S.lastCoalesce && S.lastCoalesce.key === coalesce && now - S.lastCoalesce.at < 1500)) {
      S.undo.push(snapshot());
      if (S.undo.length > 200) S.undo.shift();
      S.redo = [];
    }
    S.lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
    fn();
    changed();
  }

  function restore(snap) {
    const s = JSON.parse(snap);
    S.edit = s.edit;
    clipRec(S.clip).comments = s.comments;
    if (S.sel && !findSel()) S.sel = null;
    changed();
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); S.lastCoalesce = null; }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); S.lastCoalesce = null; }

  function changed() {
    layoutCache = null;
    P.refresh();
    renderTimeline();
    renderInspector();
    renderNotes();
    renderOverlays();
    renderClipbar();
    updateButtons();
    scheduleSave();
  }

  // ═════════════════════════ player engine ═════════════════════════
  const P = {
    els: new Map(), audios: new Map(), active: null, segIndex: 0, t: 0, playing: false,
    ctx: null, master: null, raf: 0, slots: [], monitor: 1,
  };

  function ensureAudio() {
    if (P.ctx) { if (P.ctx.state === 'suspended') P.ctx.resume(); return; }
    try {
      P.ctx = new (window.AudioContext || window.webkitAudioContext)();
      P.master = P.ctx.createGain();
      P.master.gain.value = P.monitor;
      P.master.connect(P.ctx.destination);
      for (const r of P.els.values()) connect(r);
      for (const r of P.audios.values()) connect(r);
    } catch { P.ctx = null; }
  }
  function connect(rec) {
    if (!P.ctx || rec.gain) return;
    try {
      const node = P.ctx.createMediaElementSource(rec.el);
      rec.gain = P.ctx.createGain();
      node.connect(rec.gain).connect(P.master);
    } catch { /* already connected */ }
  }
  function setLevel(rec, v) {
    if (rec.gain) { rec.gain.gain.value = v; rec.el.volume = 1; } else rec.el.volume = clamp(v * P.monitor, 0, 1);
  }

  function videoRec(src, slot) {
    const key = src + '|' + slot;
    let rec = P.els.get(key);
    if (!rec || rec.url !== mediaUrl(src)) {
      if (rec) { rec.el.pause(); rec.el.remove(); }
      const el = h('video', { preload: 'auto', playsinline: true });
      el.src = mediaUrl(src);
      el.style.visibility = 'hidden';
      el.addEventListener('error', () => onVideoError(src));
      el.addEventListener('loadedmetadata', () => { if (src === S.clip) sizeStage(); });
      stage.insertBefore(el, stage.firstChild);
      rec = { el, src, url: mediaUrl(src), gain: null };
      connect(rec);
      P.els.set(key, rec);
    }
    return rec;
  }

  function computeSlots() {
    const segs = L().segments;
    P.slots = segs.map(() => 0);
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i];
      if (a.src !== b.src) continue;
      const contiguous = Math.abs(a.out - b.in) < 0.002 && a.speed === b.speed;
      P.slots[i] = contiguous ? P.slots[i - 1] : 1 - P.slots[i - 1];
    }
  }

  function segIndexAt(t) {
    const segs = L().segments;
    for (let i = 0; i < segs.length; i++) if (t < segs[i].end - 1e-6) return i;
    return Math.max(0, segs.length - 1);
  }

  function enterSegment(i, srcTime, play) {
    const seg = L().segments[i];
    if (!seg) return;
    const rec = videoRec(seg.src, P.slots[i] || 0);
    if (P.active !== rec) {
      if (P.active) { P.active.el.pause(); P.active.el.style.visibility = 'hidden'; setLevel(P.active, 0); }
      rec.el.style.visibility = 'visible';
      P.active = rec;
    }
    if (Math.abs(rec.el.currentTime - srcTime) > 0.03) rec.el.currentTime = srcTime;
    rec.el.playbackRate = seg.speed;
    if ('preservesPitch' in rec.el) rec.el.preservesPitch = true;
    P.segIndex = i;
    if (play) rec.el.play().catch(() => {});
  }

  function preroll(i) {
    const seg = L().segments[i];
    if (!seg) return;
    const rec = videoRec(seg.src, P.slots[i] || 0);
    if (rec !== P.active && Math.abs(rec.el.currentTime - seg.in) > 0.03) rec.el.currentTime = seg.in;
  }

  function fadeGain(x, len, fi, fo) {
    let g = 1;
    if (fi > 0 && x < fi) g = Math.max(0, x / fi);
    if (fo > 0 && x > len - fo) g = Math.min(g, Math.max(0, (len - x) / fo));
    return g;
  }

  function applyLevels() {
    const seg = L().segments[P.segIndex];
    if (P.active && seg) {
      const x = P.t - seg.start;
      const g = fadeGain(x, seg.duration, seg.fadeIn, seg.fadeOut);
      P.active.el.style.opacity = String(g);
      setLevel(P.active, seg.muted ? 0 : seg.volume * g);
    }
    if (P.master) P.master.gain.value = P.monitor;
  }

  function audioRec(item) {
    let rec = P.audios.get(item.id);
    if (!rec || rec.src !== item.src) {
      if (rec) rec.el.pause();
      const el = new Audio();
      el.preload = 'auto';
      el.src = rawUrl(item.src);
      rec = { el, src: item.src, gain: null };
      connect(rec);
      P.audios.set(item.id, rec);
    }
    return rec;
  }

  function syncAudioItems() {
    const items = view().audio || [];
    const ids = new Set(items.map((a) => a.id));
    for (const [id, rec] of P.audios) if (!ids.has(id) && !rec.el.paused) rec.el.pause();
    const total = L().duration;
    for (const a of items) {
      const rec = audioRec(a);
      const len = a.out - a.in;
      const x = P.t - a.start;
      const inside = x >= 0 && x < len && P.t < total;
      if (inside && P.playing) {
        const want = a.in + x;
        if (rec.el.paused) { rec.el.currentTime = want; rec.el.play().catch(() => {}); } else if (Math.abs(rec.el.currentTime - want) > 0.15) rec.el.currentTime = want;
        setLevel(rec, a.muted ? 0 : a.volume * fadeGain(x, len, a.fadeIn, a.fadeOut));
      } else if (!rec.el.paused) rec.el.pause();
    }
  }

  function tick() {
    if (!P.playing) return;
    const segs = L().segments;
    const seg = segs[P.segIndex];
    if (seg && P.active) {
      const srcT = P.active.el.currentTime;
      let t = seg.start + (srcT - seg.in) / seg.speed;
      if (srcT >= seg.out - 0.008 || P.active.el.ended) {
        const next = segs[P.segIndex + 1];
        if (!next) { P.t = L().duration; pause(); return; }
        enterSegment(P.segIndex + 1, next.in, true);
        t = next.start;
      } else if (seg.end - t < 0.4) preroll(P.segIndex + 1);
      P.t = clamp(t, seg.start, seg.end);
    }
    syncAudioItems();
    applyLevels();
    renderOverlays();
    updatePlayhead(true);
    P.raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!L().segments.length) return;
    ensureAudio();
    if (P.t >= L().duration - 0.02) seekTo(0);
    P.playing = true;
    const seg = L().segments[P.segIndex];
    enterSegment(P.segIndex, seg.in + (P.t - seg.start) * seg.speed, true);
    $('#playBtn').innerHTML = icon('pause');
    $('#playBtn').setAttribute('aria-label', 'Pause');
    cancelAnimationFrame(P.raf);
    P.raf = requestAnimationFrame(tick);
  }

  function pause() {
    P.playing = false;
    cancelAnimationFrame(P.raf);
    for (const r of P.els.values()) r.el.pause();
    for (const r of P.audios.values()) r.el.pause();
    $('#playBtn').innerHTML = icon('play');
    $('#playBtn').setAttribute('aria-label', 'Play');
    updatePlayhead();
    renderOverlays();
  }
  const togglePlay = () => (P.playing ? pause() : play());

  function seekTo(t) {
    const total = L().duration;
    P.t = clamp(t, 0, total);
    const i = segIndexAt(Math.min(P.t, total - 1e-4));
    const seg = L().segments[i];
    if (seg) enterSegment(i, clamp(seg.in + (P.t - seg.start) * seg.speed, seg.in, Math.max(seg.in, seg.out - 0.001)), P.playing);
    syncAudioItems();
    applyLevels();
    renderOverlays();
    updatePlayhead();
  }

  P.refresh = () => {
    layoutCache = null;
    computeSlots();
    seekTo(P.t);
  };

  function onVideoError(src) {
    if (S.proxy[src] === undefined) {
      // Maybe a playable copy already exists.
      fetch(`/media/${enc(S.id)}/${enc(src)}?proxy=1`, { method: 'HEAD' }).then((r) => {
        S.proxy[src] = r.ok;
        if (r.ok) { P.refresh(); } else { S.playError[src] = true; showStageMessage(); }
      });
      return;
    }
    S.playError[src] = true;
    showStageMessage();
  }

  function showStageMessage() {
    let msg = $('.stage-msg', stage);
    const bad = Object.keys(S.playError).filter((k) => S.playError[k] && !S.proxy[k]);
    if (!bad.length) { if (msg) msg.remove(); return; }
    if (!msg) { msg = h('div', { class: 'stage-msg' }); stage.append(msg); }
    msg.innerHTML = '';
    const box = h('div', {}, h('p', {}, h('strong', {}, `Your browser can't play ${bad.join(', ')}.`)));
    if (S.system.ffmpeg) {
      box.append(h('p', { class: 'muted' }, 'The app can make a playable copy (H.264, saved in the project\'s .review folder). Your original stays as it is, and exports still use it.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => makeProxy(bad[0]) }, 'Make a playable copy'));
    } else {
      box.append(h('p', { class: 'muted' }, 'This is usually a codec like ProRes or HEVC. Try opening this page in Safari, or install ffmpeg so the app can make a playable copy (see README).'));
    }
    msg.append(box);
  }

  async function makeProxy(file) {
    const r = await api('POST', `/api/projects/${enc(S.id)}/proxy`, { file });
    await runJob(r.job, 'Making a playable copy');
    S.proxy[file] = true;
    S.playError[file] = false;
    showStageMessage();
    P.refresh();
  }

  // ═════════════════════════ stage & overlays ═════════════════════════
  function sizeStage() {
    const rect = stageWrap.getBoundingClientRect();
    const v = P.active && P.active.el;
    const w0 = S.meta.width || (v && v.videoWidth) || 16;
    const h0 = S.meta.height || (v && v.videoHeight) || 9;
    const aw = Math.max(50, rect.width - 24), ah = Math.max(50, rect.height - 24);
    const scale = Math.min(aw / w0, ah / h0);
    stage.style.width = Math.floor(w0 * scale) + 'px';
    stage.style.height = Math.floor(h0 * scale) + 'px';
    renderOverlays();
  }
  new ResizeObserver(() => { sizeStage(); paintCanvases(); drawRuler(); }).observe(stageWrap);

  const notePos = (n) => {
    const t = S.mode === 'edit' ? T.noteTime(n, view()) : T.fromSource(view(), n.src, n.at);
    if (t == null) return null;
    if (n.target && n.target.offset != null && S.mode === 'edit' && (S.edit[n.target.kind] || []).some((x) => x.id === n.target.id)) return { t, end: t + (n.len || 0) };
    let end = n.end != null ? T.fromSource(view(), n.src, n.end) : null;
    if (end == null || end < t) end = t + (n.len || 0);
    return { t, end };
  };

  function sortedNotes() {
    const list = comments().map((n) => ({ n, pos: notePos(n) }));
    list.sort((a, b) => (a.pos ? a.pos.t : 1e9 + a.n.at) - (b.pos ? b.pos.t : 1e9 + b.n.at));
    return list;
  }

  function renderOverlays() {
    if (!S.edit) return;
    stage.classList.toggle('original', S.mode === 'original');
    const H = stage.clientHeight;
    const textLayer = $('#textLayer');
    textLayer.innerHTML = '';
    if (S.mode === 'edit' && S.edit) {
      for (const t of S.edit.texts) {
        const visible = P.t >= t.start && P.t < t.end;
        if (!visible) continue;
        const el = h('div', {
          class: 'overlay-text' + (t.box ? ' box' : '') + (S.sel && S.sel.kind === 'texts' && S.sel.id === t.id ? ' selected' : ''),
          'data-id': t.id,
          style: { left: t.x * 100 + '%', top: t.y * 100 + '%', fontSize: Math.max(6, t.size * H) + 'px', color: t.color, fontWeight: t.bold ? '700' : '400' },
        }, t.text);
        textLayer.append(el);
      }
    }
    const pinLayer = $('#pinLayer');
    pinLayer.innerHTML = '';
    const list = sortedNotes();
    list.forEach(({ n, pos }, i) => {
      if (!n.spot || !pos) return;
      if (n.done && !S.showDone) return;
      const near = n.id === S.activeNote || (P.t >= pos.t - 0.25 && P.t <= Math.max(pos.end, pos.t) + 0.25);
      if (!near || S.composer) return;
      pinLayer.append(pinEl(n.spot, i + 1));
    });
    if (S.composer && S.composer.spot) pinLayer.append(pinEl(S.composer.spot, '+', true));
    if (S.drawing) pinLayer.append(pinEl(S.drawing, '+', true));
  }

  function pinEl(spot, label, draft) {
    if (spot.w && spot.h) {
      return h('div', { class: 'pin box' + (draft ? ' draft' : ''), style: { left: spot.x * 100 + '%', top: spot.y * 100 + '%', width: spot.w * 100 + '%', height: spot.h * 100 + '%' } }, h('b', {}, String(label)));
    }
    return h('div', { class: 'pin' + (draft ? ' draft' : ''), style: { left: spot.x * 100 + '%', top: spot.y * 100 + '%' } }, String(label));
  }

  // Click the picture to pin a note; drag to mark an area; drag text to move it.
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.stage-msg')) return;
    const r = stage.getBoundingClientRect();
    const pt = (ev) => ({ x: clamp((ev.clientX - r.left) / r.width, 0, 1), y: clamp((ev.clientY - r.top) / r.height, 0, 1) });
    const textEl = e.target.closest('.overlay-text');
    if (textEl && S.mode === 'edit') {
      const id = textEl.dataset.id;
      select({ kind: 'texts', id });
      const item = S.edit.texts.find((t) => t.id === id);
      const start = pt(e), base = { x: item.x, y: item.y };
      let moved = false;
      stage.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const p = pt(ev);
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 0.004) return;
        if (!moved) { S.undo.push(snapshot()); S.redo = []; moved = true; }
        item.x = round3(clamp(base.x + p.x - start.x, 0, 1));
        item.y = round3(clamp(base.y + p.y - start.y, 0, 1));
        renderOverlays();
      };
      const up = () => {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        if (moved) changed();
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
      return;
    }
    if (P.playing) pause();
    const a = pt(e);
    stage.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const b = pt(ev);
      if (Math.abs(b.x - a.x) < 0.01 && Math.abs(b.y - a.y) < 0.01) { S.drawing = null; } else {
        S.drawing = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      }
      renderOverlays();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      const spot = S.drawing ? roundSpot(S.drawing) : { x: round3(a.x), y: round3(a.y) };
      S.drawing = null;
      openComposer({ t: P.t, spot });
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });
  const roundSpot = (s) => ({ x: round3(s.x), y: round3(s.y), w: round3(s.w), h: round3(s.h) });

  /** A video element showing exactly `time` of `src`, for stills (independent of playback). */
  const stillEls = {};
  const stillQueue = {};
  function frameAt(src, time) {
    const run = async () => {
      const a = P.active && P.active.el;
      if (a && P.active.src === src && !a.seeking && a.readyState >= 2 && Math.abs(a.currentTime - time) < 0.02) return a;
      let v = stillEls[src];
      if (!v || v._url !== mediaUrl(src)) {
        v = h('video', { muted: true, preload: 'auto', playsinline: true });
        v.muted = true;
        v._url = mediaUrl(src);
        v.src = v._url;
        stillEls[src] = v;
        if (v.readyState < 1) await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); });
      }
      await new Promise((r) => {
        const done = () => { clearTimeout(timer); r(); };
        const timer = setTimeout(done, 8000);
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = Math.max(0, time);
      });
      return v;
    };
    const p = (stillQueue[src] || Promise.resolve()).then(run, run);
    stillQueue[src] = p.catch(() => {});
    return p;
  }

  /** A still of timeline time t as you saw it, with the clicked spot marked (no numbers: they can change). */
  async function captureStill(spot, t, mode) {
    const edit = mode === 'original' ? origEdit() : S.edit;
    const at = T.toSource(edit, t);
    if (!at) return null;
    const v = await frameAt(at.src, at.time);
    if (!v || !v.videoWidth) return null;
    const scale = Math.min(1, 1280 / v.videoWidth);
    const W = Math.round(v.videoWidth * scale), H = Math.round(v.videoHeight * scale);
    const c = h('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    try { ctx.drawImage(v, 0, 0, W, H); } catch { return null; }
    if (mode !== 'original') {
      for (const tx of edit.texts) {
        if (!(t >= tx.start && t < tx.end)) continue;
        const size = tx.size * H;
        ctx.font = `${tx.bold ? 'bold ' : ''}${size}px Arial, Helvetica, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lines = tx.text.split('\n');
        const lh = size * 1.2;
        const top = tx.y * H - (lines.length * lh) / 2 + lh / 2;
        if (tx.box) {
          const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(tx.x * W - wMax / 2 - size * 0.3, top - lh / 2 - size * 0.3, wMax + size * 0.6, lines.length * lh + size * 0.6);
        }
        ctx.fillStyle = tx.color;
        lines.forEach((l, i) => ctx.fillText(l, tx.x * W, top + i * lh));
      }
    }
    if (spot) {
      ctx.lineWidth = Math.max(3, W / 300);
      ctx.strokeStyle = '#000';
      const stroke = (fn) => { ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth += 3; fn(); ctx.lineWidth -= 3; ctx.strokeStyle = '#ffb224'; fn(); };
      if (spot.w && spot.h) {
        stroke(() => ctx.strokeRect(spot.x * W, spot.y * H, spot.w * W, spot.h * H));
      } else {
        const R = Math.max(14, W / 40);
        stroke(() => { ctx.beginPath(); ctx.arc(spot.x * W, spot.y * H, R, 0, Math.PI * 2); ctx.stroke(); });
        ctx.fillStyle = '#ffb224';
        ctx.beginPath(); ctx.arc(spot.x * W, spot.y * H, Math.max(3, R / 5), 0, Math.PI * 2); ctx.fill();
      }
    }
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.86));
  }

  // ═════════════════════════ timeline ═════════════════════════
  const PAD = 14;
  const ROW_H = { ruler: 26, notes: 28, texts: 30, video: 58, clipaudio: 36, lane: 40 };
  const xOf = (t) => PAD + t * S.pxPerSec;
  const tOf = (clientX) => {
    const r = tlInner.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - PAD) / S.pxPerSec);
  };

  function rows() {
    const list = [
      { key: 'ruler', h: ROW_H.ruler, label: '' },
      { key: 'notes', h: ROW_H.notes, label: 'Notes', icon: '💬' },
      { key: 'texts', h: ROW_H.texts, label: 'Text', tag: 'T' },
      { key: 'video', h: ROW_H.video, label: 'Video', tag: 'V1' },
      { key: 'clipaudio', h: ROW_H.clipaudio, label: 'Clip audio', tag: 'A1' },
    ];
    const lanes = Math.max(0, ...(view().audio || []).map((a) => (a.lane || 0) + 1));
    const count = S.mode === 'edit' ? lanes + 1 : lanes;
    for (let i = 0; i < count; i++) list.push({ key: 'lane' + i, lane: i, h: ROW_H.lane, label: i === lanes ? 'Drop audio' : 'Audio', tag: 'A' + (i + 2) });
    return list;
  }

  function minPps() {
    const w = tlScroll.clientWidth - PAD * 2 - 20;
    return Math.max(2, w / Math.max(1, L().duration));
  }
  function setZoom(val, keepT) {
    S.zoomVal = clamp(val, 0, 100);
    const lo = minPps(), hi = 400;
    const anchor = keepT == null ? P.t : keepT;
    const screenX = xOf(anchor) - tlScroll.scrollLeft;
    S.pxPerSec = lo * Math.pow(hi / lo, S.zoomVal / 100);
    $('#zoom').value = S.zoomVal;
    renderTimeline();
    tlScroll.scrollLeft = Math.max(0, xOf(anchor) - screenX);
  }

  function renderTimeline() {
    if (!S.edit) return;
    const v = view();
    const lay = L();
    const width = Math.max(tlScroll.clientWidth, xOf(lay.duration) + 140);
    const rs = rows();
    tlLabels.innerHTML = '';
    tlInner.innerHTML = '';
    tlInner.style.width = width + 'px';
    const items = [];
    for (const r of rs) {
      tlLabels.append(h('div', { class: 'lab', style: { height: r.h + 'px' } }, r.tag ? h('b', {}, r.tag) : r.icon || '', h('span', {}, r.label)));
      const row = h('div', { class: 'tl-row ' + (r.key === 'ruler' ? 'ruler' : r.key === 'notes' ? 'notes-lane' : 'lane'), 'data-key': r.key, style: { height: r.h + 'px' } });
      if (r.lane != null) row.dataset.lane = r.lane;
      if (r.key !== 'ruler') row.append(h('div', { class: 'beyond', style: { left: xOf(lay.duration) + 'px', right: 0 } }));
      tlInner.append(row);
      r.el = row;
    }
    const rowEl = (key) => rs.find((r) => r.key === key).el;

    // Ruler canvas (painted for the visible window only)
    rowEl('ruler').append(h('canvas', { id: 'rulerCanvas' }));

    // Notes
    const notesRow = rowEl('notes');
    sortedNotes().forEach(({ n, pos }, i) => {
      if (!pos || (n.done && !S.showDone)) return;
      const w = Math.max(4, (pos.end - pos.t) * S.pxPerSec);
      notesRow.append(h('div', {
        class: 'marker' + (n.id === S.activeNote ? ' active' : '') + (n.done ? ' done' : ''),
        'data-note': n.id, title: (n.text || '').slice(0, 140),
        style: { left: xOf(pos.t) + 'px', width: w + 'px' },
      }, h('b', {}, String(i + 1))));
    });
    if (S.composer) {
      notesRow.append(h('div', { class: 'marker draft active', style: { left: xOf(S.composer.t) + 'px', width: Math.max(4, (S.composer.len || 0) * S.pxPerSec) + 'px' } }, h('b', {}, '+')));
    }
    if (S.draftRange) {
      notesRow.append(h('div', { class: 'marker draft', style: { left: xOf(S.draftRange.a) + 'px', width: Math.max(4, (S.draftRange.b - S.draftRange.a) * S.pxPerSec) + 'px' } }));
    }

    // Texts
    if (S.mode === 'edit') {
      for (const t of v.texts) {
        const el = itemEl('text', 'texts', t.id, xOf(t.start), (t.end - t.start) * S.pxPerSec, t.text.replace(/\n/g, ' '));
        rowEl('texts').append(el);
      }
    }

    // Video + clip audio
    lay.segments.forEach((s, i) => {
      const own = s.src === S.clip;
      const label = (own ? '' : s.src + ' · ') + T.fmtRange(s.in, s.out);
      const el = itemEl('seg' + (i % 2 ? ' alt' : ''), 'video', s.id, xOf(s.start), s.duration * S.pxPerSec, label);
      if (Math.abs(s.speed - 1) > 1e-3) el.append(h('span', { class: 'badge' }, `${+s.speed.toFixed(2)}×`));
      const cv = h('canvas', { 'data-paint': 'film', 'data-src': s.src, 'data-in': s.in, 'data-out': s.out });
      el.append(cv);
      addFades(el, s.fadeIn, s.fadeOut, s.duration);
      rowEl('video').append(el);
      if (S.dragSeg && S.dragSeg.id === s.id) el.classList.add('dragging');
      items.push(cv);

      const a = h('div', {
        class: 'item aseg' + (s.muted ? ' muted' : '') + (isSel('video', s.id) ? ' selected' : ''),
        'data-kind': 'video', 'data-id': s.id,
        style: { left: xOf(s.start) + 'px', width: Math.max(2, s.duration * S.pxPerSec) + 'px' },
      }, h('span', { class: 'lbl' }, s.muted ? 'muted' : (Math.abs(s.volume - 1) > 1e-3 ? T.pct(s.volume) : '')));
      a.append(h('canvas', { 'data-paint': 'wave', 'data-src': s.src, 'data-in': s.in, 'data-out': s.out, 'data-color': 'rgba(140,180,255,0.85)' }));
      rowEl('clipaudio').append(a);
    });

    // Extra audio
    for (const a of v.audio || []) {
      const row = rs.find((r) => r.lane === (a.lane || 0));
      if (!row) continue;
      const len = a.out - a.in;
      const el = itemEl('audio' + (a.muted ? ' muted' : ''), 'audio', a.id, xOf(a.start), len * S.pxPerSec, a.src + (Math.abs(a.volume - 1) > 1e-3 ? ` · ${T.pct(a.volume)}` : ''));
      el.append(h('canvas', { 'data-paint': 'wave', 'data-src': a.src, 'data-in': a.in, 'data-out': a.out, 'data-color': 'rgba(210,255,230,0.75)' }));
      addFades(el, a.fadeIn, a.fadeOut, len);
      row.el.append(el);
    }

    if (S.insertAt != null) {
      const segs = lay.segments;
      const x = S.insertAt >= segs.length ? xOf(lay.duration) : xOf(segs[S.insertAt].start);
      rowEl('video').append(h('div', { class: 'insert-mark', style: { left: x - 1 + 'px' } }));
    }

    tlInner.append(h('div', { class: 'playhead', id: 'playhead' }));
    updatePlayhead();
    paintCanvases();
    drawRuler();
    $('#toolbar').classList.toggle('locked', S.mode !== 'edit');
  }

  function itemEl(cls, kind, id, x, w, label) {
    const el = h('div', {
      class: `item ${cls}` + (isSel(kind, id) ? ' selected' : ''), 'data-kind': kind, 'data-id': id,
      style: { left: x + 'px', width: Math.max(3, w) + 'px' }, title: label,
    }, h('span', { class: 'lbl' }, label));
    if (S.mode === 'edit') el.append(h('span', { class: 'h l', 'data-h': 'l' }), h('span', { class: 'h r', 'data-h': 'r' }));
    return el;
  }

  function addFades(el, fi, fo, len) {
    if (fi > 0) el.append(h('div', { class: 'fade in', style: { width: Math.min(100, (fi / len) * 100) + '%' } }));
    if (fo > 0) el.append(h('div', { class: 'fade out', style: { width: Math.min(100, (fo / len) * 100) + '%' } }));
  }

  const isSel = (kind, id) => S.sel && S.sel.kind === kind && S.sel.id === id;

  /** Paints filmstrips and waveforms for just the visible part of each item. */
  let paintQueued = false;
  function paintCanvases() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const viewL = tlScroll.scrollLeft, viewR = viewL + tlScroll.clientWidth;
      for (const cv of $$('canvas[data-paint]', tlInner)) {
        const item = cv.parentElement;
        const left = item.offsetLeft, w = item.offsetWidth, hgt = item.clientHeight;
        const a = Math.max(left, viewL - 50), b = Math.min(left + w, viewR + 50);
        if (b <= a) { cv.width = 0; continue; }
        cv.style.left = (a - left) + 'px';
        cv.width = Math.ceil(b - a);
        cv.height = hgt;
        cv.style.width = cv.width + 'px';
        cv.style.height = hgt + 'px';
        const src = cv.dataset.src, sIn = +cv.dataset.in, sOut = +cv.dataset.out;
        const s0 = sIn + ((a - left) / w) * (sOut - sIn), s1 = sIn + ((b - left) / w) * (sOut - sIn);
        if (cv.dataset.paint === 'film') paintFilm(cv, src, s0, s1);
        else paintWave(cv, src, s0, s1, cv.dataset.color);
      }
    });
  }
  tlScroll.addEventListener('scroll', () => { paintCanvases(); drawRuler(); tlLabels.scrollTop = tlScroll.scrollTop; });

  const filmJobs = {};
  function paintFilm(cv, src, s0, s1) {
    const meta = S.metas[src];
    if (!meta || !meta.duration) return;
    if (!filmJobs[src]) filmJobs[src] = MC.thumbs(mediaUrl(src), meta.duration, () => paintCanvases());
    const job = filmJobs[src];
    const ctx = cv.getContext('2d');
    const tileW = Math.max(20, Math.round(cv.height * (job.aspect || 16 / 9)));
    ctx.globalAlpha = 0.85;
    for (let x = 0; x < cv.width; x += tileW) {
      const st = s0 + ((x + tileW / 2) / cv.width) * (s1 - s0);
      const img = MC.frameAt(job, st);
      if (img) ctx.drawImage(img, x, 0, tileW, cv.height);
    }
  }

  const peaks = {};
  function paintWave(cv, src, s0, s1, color) {
    const info = fileInfo(src);
    if (!info) return;
    if (!peaks[src]) {
      peaks[src] = { state: 'loading' };
      MC.peaks(S.id, info, rawUrl(src)).then((pk) => {
        peaks[src] = { state: 'ok', pk };
        if (pk.channels && S.metas[src]) S.metas[src].channels = S.metas[src].channels || pk.channels;
        paintCanvases();
      }).catch(() => { peaks[src] = { state: 'none' }; });
    }
    if (peaks[src].state === 'ok') MC.drawWave(cv, peaks[src].pk, s0, s1, color);
  }

  function drawRuler() {
    const cv = $('#rulerCanvas');
    if (!cv) return;
    const w = tlScroll.clientWidth, hgt = ROW_H.ruler;
    const left = tlScroll.scrollLeft;
    cv.style.left = left + 'px';
    cv.width = w * devicePixelRatio; cv.height = hgt * devicePixelRatio;
    cv.style.width = w + 'px'; cv.style.height = hgt + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * S.pxPerSec >= 80) || 600;
    const minor = major / (major >= 1 && major % 5 === 0 ? 5 : 2);
    const t0 = Math.max(0, (left - PAD) / S.pxPerSec), t1 = (left + w) / S.pxPerSec;
    ctx.fillStyle = '#9aa4b5';
    ctx.strokeStyle = '#3a4252';
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(xOf(t) - left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, hgt); ctx.lineTo(x, isMajor ? hgt - 11 : hgt - 5);
      if (isMajor) ctx.fillText(major < 1 ? (t < 60 ? t.toFixed(1) + 's' : T.fmt(t)) : T.fmt(t).replace(/\.00$/, ''), x + 3, 12);
    }
    ctx.stroke();
  }

  function updatePlayhead(follow) {
    const ph = $('#playhead');
    if (ph) ph.style.left = xOf(P.t) + 'px';
    $('#time').innerHTML = `<b>${T.fmt(P.t)}</b> / ${T.fmt(L().duration)}`;
    if (follow) {
      const x = xOf(P.t);
      if (x > tlScroll.scrollLeft + tlScroll.clientWidth - 40 || x < tlScroll.scrollLeft) tlScroll.scrollLeft = x - 60;
    }
  }

  // ── timeline interactions ──
  function snapTime(t, exclude) {
    const cands = [0, P.t, L().duration];
    for (const s of L().segments) cands.push(s.start, s.end);
    for (const x of S.edit.texts) if (x.id !== exclude) cands.push(x.start, x.end);
    for (const x of S.edit.audio) if (x.id !== exclude) cands.push(x.start, x.start + x.out - x.in);
    let best = t, bestD = 8 / S.pxPerSec;
    for (const c of cands) { const d = Math.abs(c - t); if (d < bestD) { best = c; bestD = d; } }
    return best;
  }

  tlInner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const row = e.target.closest('.tl-row');
    if (!row) return;
    const key = row.dataset.key;
    const itemDom = e.target.closest('.item');
    const marker = e.target.closest('.marker[data-note]');
    const x0 = e.clientX, y0 = e.clientY;
    const t0 = tOf(e.clientX);
    tlInner.setPointerCapture(e.pointerId);
    let handler = null;

    if (key === 'ruler') {
      if (P.playing) pause();
      seekTo(t0);
      handler = { move: (ev) => seekTo(tOf(ev.clientX)) };
    } else if (marker) {
      const id = marker.dataset.note;
      selectNote(id, true);
    } else if (key === 'notes') {
      handler = {
        move: (ev) => {
          const t1 = tOf(ev.clientX);
          if (Math.abs(ev.clientX - x0) < 4) return;
          S.draftRange = { a: Math.min(t0, t1), b: Math.max(t0, t1) };
          renderTimeline();
        },
        up: () => {
          const r = S.draftRange;
          S.draftRange = null;
          if (P.playing) pause();
          if (r && r.b - r.a > 0.05) { seekTo(r.a); openComposer({ t: r.a, len: round3(r.b - r.a) }); } else { seekTo(t0); openComposer({ t: t0 }); }
        },
      };
    } else if (itemDom && S.mode === 'edit') {
      handler = startItemDrag(e, itemDom, x0, y0);
    } else if (itemDom) {
      select({ kind: itemDom.dataset.kind, id: itemDom.dataset.id });
    } else {
      select(null);
      if (P.playing) pause();
      seekTo(t0);
    }

    if (!handler) return;
    const move = (ev) => handler.move && handler.move(ev);
    const up = (ev) => {
      tlInner.removeEventListener('pointermove', move);
      tlInner.removeEventListener('pointerup', up);
      tlInner.removeEventListener('pointercancel', up);
      if (handler.up) handler.up(ev);
    };
    tlInner.addEventListener('pointermove', move);
    tlInner.addEventListener('pointerup', up);
    tlInner.addEventListener('pointercancel', up);
  });

  function startItemDrag(e, itemDom, x0, y0) {
    const kind = itemDom.dataset.kind, id = itemDom.dataset.id;
    const side = e.target.dataset.h || null;
    const isAseg = itemDom.classList.contains('aseg');
    select({ kind, id });
    if (isAseg) return null;
    const base = JSON.stringify(S.edit);
    const baseEdit = JSON.parse(base);
    let moved = false;
    const begin = () => { if (!moved) { moved = true; S.undo.push(JSON.stringify({ edit: baseEdit, comments: comments() })); S.redo = []; S.lastCoalesce = null; } };
    const dt = (ev) => (ev.clientX - x0) / S.pxPerSec;
    let raf = 0;
    const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; layoutCache = null; computeSlots(); renderTimeline(); renderOverlays(); }); };

    if (kind === 'video') {
      const seg = baseEdit.video.find((s) => s.id === id);
      const srcDur = (S.metas[seg.src] && S.metas[seg.src].duration) || seg.out;
      if (side) {
        return {
          move: (ev) => {
            if (Math.abs(ev.clientX - x0) < 2 && !moved) return;
            begin();
            const d = dt(ev) * seg.speed;
            S.edit = T.trimSegment(baseEdit, id, side === 'l' ? 'in' : 'out', side === 'l' ? seg.in + d : seg.out + d, srcDur, fps());
            const s = T.layout(S.edit).segments.find((x) => x.id === id);
            if (P.playing) pause();
            layoutCache = null; computeSlots();
            seekTo(side === 'l' ? s.start : Math.max(s.start, s.end - frame()));
            redraw();
          },
          up: () => { if (moved) changed(); },
        };
      }
      // Drag to reorder
      return {
        move: (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) < 5) return;
          begin();
          S.dragSeg = { id };
          const t = tOf(ev.clientX);
          const segs = T.layout(baseEdit).segments;
          let idx = segs.length;
          for (let i = 0; i < segs.length; i++) { if (t < (segs[i].start + segs[i].end) / 2) { idx = i; break; } }
          S.insertAt = idx;
          redraw();
        },
        up: () => {
          const idx = S.insertAt;
          S.insertAt = null; S.dragSeg = null;
          if (!moved || idx == null) { renderTimeline(); return; }
          const from = baseEdit.video.findIndex((s) => s.id === id);
          S.edit = T.moveSegment(baseEdit, id, idx > from ? idx - 1 : idx);
          changed();
        },
      };
    }

    if (kind === 'texts') {
      const it = baseEdit.texts.find((x) => x.id === id);
      const len = it.end - it.start;
      return {
        move: (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) < 3) return;
          begin();
          const d = dt(ev);
          S.edit = JSON.parse(base);
          const cur = S.edit.texts.find((x) => x.id === id);
          if (side === 'l') cur.start = round3(clamp(snapTime(it.start + d, id), 0, it.end - 0.2));
          else if (side === 'r') cur.end = round3(clamp(snapTime(it.end + d, id), it.start + 0.2, L().duration));
          else {
            let s = snapTime(it.start + d, id);
            const sEnd = snapTime(it.end + d, id);
            if (sEnd !== it.end + d) s = sEnd - len;
            cur.start = round3(clamp(s, 0, Math.max(0, L().duration - len)));
            cur.end = round3(cur.start + len);
          }
          redraw();
        },
        up: () => { if (moved) changed(); },
      };
    }

    if (kind === 'audio') {
      const it = baseEdit.audio.find((x) => x.id === id);
      const srcDur = (S.metas[it.src] && S.metas[it.src].duration) || it.out;
      return {
        move: (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 6) return;
          begin();
          const d = dt(ev);
          S.edit = JSON.parse(base);
          const cur = S.edit.audio.find((x) => x.id === id);
          if (side === 'l') {
            const nd = clamp(d, -it.in, it.out - it.in - 0.1);
            const ns = snapTime(it.start + nd, id);
            const adj = clamp(ns - it.start, -it.in, it.out - it.in - 0.1);
            cur.start = round3(Math.max(0, it.start + adj)); cur.in = round3(it.in + (cur.start - it.start));
          } else if (side === 'r') {
            const endT = snapTime(it.start + (it.out - it.in) + d, id);
            cur.out = round3(clamp(it.in + (endT - it.start), it.in + 0.1, srcDur));
          } else {
            const len = it.out - it.in;
            let s = snapTime(it.start + d, id);
            const sEnd = snapTime(it.start + len + d, id);
            if (sEnd !== it.start + len + d) s = sEnd - len;
            cur.start = round3(Math.max(0, s));
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            const lane = under && under.closest('.tl-row[data-lane]');
            if (lane) cur.lane = +lane.dataset.lane;
          }
          redraw();
        },
        up: () => { if (moved) changed(); },
      };
    }
    return null;
  }

  // ═════════════════════════ selection & inspector ═════════════════════════
  function findSel() {
    if (!S.sel) return null;
    if (S.sel.kind === 'video') return S.edit.video.find((s) => s.id === S.sel.id) || null;
    if (S.sel.kind === 'texts') return S.edit.texts.find((s) => s.id === S.sel.id) || null;
    if (S.sel.kind === 'audio') return S.edit.audio.find((s) => s.id === S.sel.id) || null;
    return null;
  }

  function select(sel) {
    S.sel = sel;
    if (sel && sel.kind === 'texts') {
      const t = findSel();
      if (t && !(P.t >= t.start && P.t < t.end)) seekTo(t.start + 0.01);
    }
    renderTimeline();
    renderInspector();
    renderOverlays();
    updateButtons();
  }

  function selLabel(sel) {
    const item = sel && findSel();
    if (!item) return null;
    if (sel.kind === 'video') return item.src === S.clip ? `the video piece (original ${T.fmtRange(item.in, item.out)})` : `the inserted clip ${item.src} (${T.fmtRange(item.in, item.out)})`;
    if (sel.kind === 'texts') return `my added text "${item.text}"`;
    if (sel.kind === 'audio') return `the audio "${item.src}" on track A${(item.lane || 0) + 2}`;
    return null;
  }

  function field(label, control, readout) {
    return h('div', { class: 'row' }, h('span', {}, label), h('div', { class: 'inline' }, control, readout || ''));
  }
  function num(value, onCommit, opts = {}) {
    const el = h('input', { type: 'number', step: opts.step || 0.01, min: opts.min, max: opts.max, value: round3(value) });
    el.addEventListener('change', () => { const v = parseFloat(el.value); if (isFinite(v)) onCommit(v); });
    return el;
  }
  function slider(value, min, max, step, onInput, fmtFn) {
    const out = h('span', { class: 'readout' }, fmtFn(value));
    const el = h('input', { type: 'range', min, max, step, value });
    el.addEventListener('input', () => { out.textContent = fmtFn(+el.value); onInput(+el.value); });
    return [el, out];
  }
  const volFmt = (v) => `${Math.round(v * 100)}% · ${T.db(v)}`;

  function updateItem(kind, id, props, coalesce) {
    mutate(() => { S.edit = T.update(S.edit, kind, id, props); }, coalesce);
  }

  function renderInspector() {
    const box = $('#inspector');
    box.innerHTML = '';
    const item = S.mode === 'edit' ? findSel() : null;
    const noteBtn = () => h('button', { class: 'btn small', type: 'button', onclick: () => openComposer({ t: P.t }) }, 'Note about this');

    if (!item) {
      $('#inspTitle').textContent = 'Clip';
      const m = S.meta;
      const info = fileInfo(S.clip);
      box.append(
        h('h3', {}, S.clip || ''),
        h('p', {}, [T.fmt(m.duration || 0), m.width ? `${m.width}×${m.height}` : '', m.fps ? `${+m.fps.toFixed(3)} fps` : '', info ? bytes(info.size) : ''].filter(Boolean).join(' · ')),
        S.mode === 'original'
          ? h('p', {}, 'You are playing the original file. Notes you add here are pinned to the original timing. Switch to "My edit" to edit.')
          : h('p', {}, 'Click a piece on the timeline to adjust it. Click the picture to pin a note on an exact spot.'),
        h('div', { class: 'shortcuts' },
          h('span', { class: 'kbd' }, 'Space'), 'Play / pause',
          h('span', { class: 'kbd' }, '← →'), 'One frame (hold ⇧ for 1 s)',
          h('span', { class: 'kbd' }, 'C'), 'Add a note at the playhead',
          h('span', { class: 'kbd' }, 'S'), 'Split at the playhead',
          h('span', { class: 'kbd' }, 'Del'), 'Remove the selected piece',
          h('span', { class: 'kbd' }, `${mod}Z`), 'Undo'));
      return;
    }

    const btns = h('div', { class: 'btns' });
    if (S.sel.kind === 'video') {
      const s = item;
      $('#inspTitle').textContent = 'Video piece';
      const srcDur = (S.metas[s.src] && S.metas[s.src].duration) || s.out;
      const [vol, volOut] = slider(s.volume, 0, 2, 0.01, (v) => updateItem('video', s.id, { volume: round3(v) }, 'vol' + s.id), volFmt);
      const speed = h('select', {}, ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => h('option', { value: v, selected: Math.abs(v - s.speed) < 1e-3 }, v + '×')));
      if (![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].some((v) => Math.abs(v - s.speed) < 1e-3)) speed.prepend(h('option', { value: s.speed, selected: true }, s.speed + '×'));
      speed.addEventListener('change', () => updateItem('video', s.id, { speed: +speed.value }));
      const mute = h('input', { type: 'checkbox', checked: s.muted });
      mute.addEventListener('change', () => updateItem('video', s.id, { muted: mute.checked }));
      box.append(
        h('h3', {}, h('span', { class: 'sw', style: { background: 'var(--video-2)' } }), s.src),
        h('p', {}, `Plays ${T.fmtRange(s.in, s.out)} of the file · ${(T.segDuration(s)).toFixed(2)} s in your edit`),
        field('Starts at', num(s.in, (v) => mutate(() => { S.edit = T.trimSegment(S.edit, s.id, 'in', v, srcDur, fps()); }))),
        field('Ends at', num(s.out, (v) => mutate(() => { S.edit = T.trimSegment(S.edit, s.id, 'out', v, srcDur, fps()); }))),
        field('Speed', speed),
        field('Volume', vol, volOut),
        field('', h('label', { class: 'check' }, mute, 'Mute this piece')),
        field('Fade in', num(s.fadeIn, (v) => updateItem('video', s.id, { fadeIn: clamp(v, 0, T.segDuration(s)) }), { min: 0 }), h('span', { class: 'muted' }, 's')),
        field('Fade out', num(s.fadeOut, (v) => updateItem('video', s.id, { fadeOut: clamp(v, 0, T.segDuration(s)) }), { min: 0 }), h('span', { class: 'muted' }, 's')));
      btns.append(
        h('button', { class: 'btn small', type: 'button', onclick: splitAction }, 'Split at playhead'),
        h('button', { class: 'btn small danger', type: 'button', onclick: deleteAction, disabled: S.edit.video.length <= 1 }, 'Remove'),
        noteBtn());
    } else if (S.sel.kind === 'texts') {
      const t = item;
      $('#inspTitle').textContent = 'Text';
      const ta = h('textarea', { rows: 2 });
      ta.value = t.text;
      ta.addEventListener('input', () => updateItem('texts', t.id, { text: ta.value }, 'txt' + t.id));
      const [size, sizeOut] = slider(t.size, 0.02, 0.25, 0.005, (v) => updateItem('texts', t.id, { size: round3(v) }, 'size' + t.id), (v) => Math.round(v * 100) + '%');
      const color = h('input', { type: 'color', value: t.color || '#ffffff' });
      color.addEventListener('input', () => updateItem('texts', t.id, { color: color.value }, 'color' + t.id));
      const sw = h('div', { class: 'swatches' }, ...['#ffffff', '#000000', '#ffcc00', '#ff4d4d', '#5b8cff', '#3dd68c'].map((c) =>
        h('button', { type: 'button', style: { background: c }, 'aria-label': c, 'aria-pressed': String((t.color || '').toLowerCase() === c), onclick: () => updateItem('texts', t.id, { color: c }) })));
      const bold = h('input', { type: 'checkbox', checked: t.bold });
      bold.addEventListener('change', () => updateItem('texts', t.id, { bold: bold.checked }));
      const boxCb = h('input', { type: 'checkbox', checked: t.box });
      boxCb.addEventListener('change', () => updateItem('texts', t.id, { box: boxCb.checked }));
      const place = h('div', { class: 'seg' }, ...[['Top', 0.15], ['Middle', 0.5], ['Bottom', 0.85]].map(([lbl, y]) =>
        h('button', { type: 'button', 'aria-pressed': String(Math.abs(t.y - y) < 0.02 && Math.abs(t.x - 0.5) < 0.02), onclick: () => updateItem('texts', t.id, { x: 0.5, y }) }, lbl)));
      box.append(
        h('h3', {}, h('span', { class: 'sw', style: { background: 'var(--text-track)' } }), 'Text overlay'),
        h('p', {}, 'Drag the text on the picture to move it.'),
        ta,
        field('Size', size, sizeOut),
        field('Colour', h('div', { class: 'inline' }, color, sw)),
        field('Style', h('div', { class: 'inline' }, h('label', { class: 'check' }, bold, 'Bold'), h('label', { class: 'check' }, boxCb, 'Dark box'))),
        field('Position', place),
        field('From', num(t.start, (v) => updateItem('texts', t.id, { start: clamp(v, 0, t.end - 0.1) }), { min: 0 }), h('span', { class: 'muted' }, 's')),
        field('To', num(t.end, (v) => updateItem('texts', t.id, { end: clamp(v, t.start + 0.1, L().duration) }), { min: 0 }), h('span', { class: 'muted' }, 's')));
      btns.append(h('button', { class: 'btn small danger', type: 'button', onclick: deleteAction }, 'Remove text'), noteBtn());
    } else if (S.sel.kind === 'audio') {
      const a = item;
      $('#inspTitle').textContent = 'Audio';
      const srcDur = (S.metas[a.src] && S.metas[a.src].duration) || a.out;
      const [vol, volOut] = slider(a.volume, 0, 2, 0.01, (v) => updateItem('audio', a.id, { volume: round3(v) }, 'avol' + a.id), volFmt);
      const mute = h('input', { type: 'checkbox', checked: a.muted });
      mute.addEventListener('change', () => updateItem('audio', a.id, { muted: mute.checked }));
      box.append(
        h('h3', {}, h('span', { class: 'sw', style: { background: 'var(--audio-2)' } }), a.src),
        h('p', {}, `Track A${(a.lane || 0) + 2} · uses ${T.fmtRange(a.in, a.out)} of the file`),
        field('Starts at', num(a.start, (v) => updateItem('audio', a.id, { start: Math.max(0, v) }), { min: 0 }), h('span', { class: 'muted' }, 's in edit')),
        field('File from', num(a.in, (v) => updateItem('audio', a.id, { in: clamp(v, 0, a.out - 0.1) }), { min: 0 })),
        field('File to', num(a.out, (v) => updateItem('audio', a.id, { out: clamp(v, a.in + 0.1, srcDur) }), { min: 0 })),
        field('Volume', vol, volOut),
        field('', h('label', { class: 'check' }, mute, 'Mute')),
        field('Fade in', num(a.fadeIn, (v) => updateItem('audio', a.id, { fadeIn: Math.max(0, v) }), { min: 0 }), h('span', { class: 'muted' }, 's')),
        field('Fade out', num(a.fadeOut, (v) => updateItem('audio', a.id, { fadeOut: Math.max(0, v) }), { min: 0 }), h('span', { class: 'muted' }, 's')));
      btns.append(
        h('button', { class: 'btn small', type: 'button', onclick: splitAction }, 'Split at playhead'),
        h('button', { class: 'btn small danger', type: 'button', onclick: deleteAction }, 'Remove audio'),
        noteBtn());
    }
    box.append(btns);
  }

  // ═════════════════════════ notes ═════════════════════════
  async function openComposer({ t, len = 0, spot = null }) {
    if (P.playing) pause();
    const sel = S.mode === 'edit' ? S.sel : null;
    const label = selLabel(sel);
    S.composer = { t: round3(t), len, spot, target: label ? { kind: sel.kind, id: sel.id, label } : null };
    S.activeNote = null;
    renderNotes();
    renderTimeline();
    renderOverlays();
    const ta = $('#composerText');
    if (ta) ta.focus();
    if (Math.abs(P.t - t) > 0.01) seekTo(t);
    // Grab the still of this exact moment (saving waits for it).
    const c = S.composer;
    c.mode = S.mode;
    c.stillPromise = captureStill(spot, c.t, c.mode).catch(() => null);
  }

  function closeComposer() {
    S.composer = null;
    renderNotes(); renderTimeline(); renderOverlays();
  }

  async function saveComposer(text) {
    const c = S.composer;
    if (!c || c.saving) return;
    c.saving = true;
    const v = c.mode === 'original' ? origEdit() : S.edit;
    const at = T.toSource(v, c.t);
    if (!at) return;
    const note = {
      id: T.newId('n'), src: at.src, at: round3(at.time), end: null, len: c.len || 0,
      spot: c.spot, target: c.target, text: text.trim(), still: null, done: false, created: new Date().toISOString(),
      view: c.mode,
    };
    if (c.len > 0) {
      const e = T.toSource(v, c.t + c.len);
      if (e && e.src === at.src && e.time > at.time) note.end = round3(e.time);
    }
    if (note.target && (note.target.kind === 'texts' || note.target.kind === 'audio')) {
      const it = (S.edit[note.target.kind] || []).find((x) => x.id === note.target.id);
      if (it) note.target = Object.assign({}, note.target, { offset: round3(Math.max(0, c.t - it.start)) });
    }
    const blob = await c.stillPromise;
    S.composer = null;
    mutate(() => { comments().push(note); });
    S.activeNote = note.id;
    renderNotes(); renderTimeline();
    if (blob) {
      try {
        const name = `${S.clip.replace(/\.[^.]+$/, '')} ${T.fmt(note.at).replace(/:/g, 'm')}s ${note.id.slice(-5)}`;
        const r = await api('POST', `/api/projects/${enc(S.id)}/still?name=${enc(name)}`, blob);
        const target = comments().find((n) => n.id === note.id);
        if (target) { target.still = r.rel; renderNotes(); scheduleSave(); }
      } catch { /* the note is saved without a still */ }
    }
  }

  function selectNote(id, seek) {
    S.activeNote = id;
    const n = comments().find((x) => x.id === id);
    if (n && seek) {
      const pos = notePos(n);
      if (pos) { if (P.playing) pause(); seekTo(pos.t); }
    }
    renderNotes(); renderTimeline(); renderOverlays();
    const card = $(`.note-card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderNotes() {
    const box = $('#notes');
    const list = sortedNotes();
    const open = list.filter((x) => !x.n.done).length;
    $('#notesTitle').textContent = `Notes (${open}${list.length !== open ? ` + ${list.length - open} done` : ''})`;
    box.innerHTML = '';

    if (S.composer) {
      const c = S.composer;
      const ta = h('textarea', { id: 'composerText', placeholder: 'What should change here? Be as specific as you like.', 'aria-label': 'Note' });
      const chips = h('div', { class: 'top' },
        h('span', { class: 'note-time' }, T.fmt(c.t) + (c.len ? ' → ' + T.fmt(c.t + c.len) : '')),
        c.spot ? h('span', { class: 'chip' }, c.spot.w ? 'Area on frame' : 'Spot on frame', h('button', { type: 'button', 'aria-label': 'Remove spot', onclick: () => { c.spot = null; c.stillPromise = captureStill(null, c.t, c.mode).catch(() => null); renderNotes(); renderOverlays(); } }, '×')) : '',
        c.target ? h('span', { class: 'chip', title: c.target.label }, 'About ' + c.target.label, h('button', { type: 'button', 'aria-label': 'Remove', onclick: () => { c.target = null; renderNotes(); } }, '×')) : '');
      if (!c.len) {
        chips.append(h('button', { class: 'btn small ghost', type: 'button', title: 'Make this note cover a stretch of time: move the playhead to where it ends, then click', onclick: () => {
          if (P.t > c.t + 0.05) { c.len = round3(P.t - c.t); renderNotes(); renderTimeline(); } else toast('Move the playhead past the note\'s start first, then click "Until playhead".');
        } }, 'Until playhead'));
      }
      const saveBtn = h('button', { class: 'btn small note', type: 'button', onclick: () => saveComposer(ta.value) }, 'Save note');
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveComposer(ta.value); }
        if (e.key === 'Escape') { e.preventDefault(); closeComposer(); }
      });
      box.append(h('div', { class: 'composer' }, chips, ta,
        h('div', { class: 'bottom' }, h('span', { class: 'muted' }, 'Enter to save · Shift+Enter for a new line'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: closeComposer }, 'Cancel'), saveBtn)));
    }

    if (!list.length && !S.composer) {
      box.append(h('div', { class: 'notes-empty' },
        h('p', {}, 'No notes on this clip yet.'),
        h('p', {}, 'Pause where something needs fixing and click the picture on the exact spot, click the Notes lane on the timeline, or press C.')));
      return;
    }

    list.forEach(({ n, pos }, i) => {
      if (n.done && !S.showDone) return;
      const timeLabel = pos ? T.fmt(pos.t) + (pos.end - pos.t > 0.05 ? ' → ' + T.fmt(pos.end) : '') : T.fmt(n.at);
      const card = h('div', { class: 'note-card' + (n.id === S.activeNote ? ' active' : '') + (n.done ? ' done' : ''), 'data-id': n.id });
      const top = h('div', { class: 'top' },
        h('span', { class: 'note-num' }, String(i + 1)),
        h('button', { class: 'note-time', type: 'button', title: 'Go to this moment', onclick: () => selectNote(n.id, true) }, timeLabel));
      if (!pos) top.append(h('span', { class: 'chip cut', title: 'This moment is in a part you removed from your edit' }, 'cut from edit'));
      if (n.src !== S.clip) top.append(h('span', { class: 'chip' }, n.src));
      if (n.spot) top.append(h('span', { class: 'chip' }, n.spot.w ? 'area' : 'spot'));
      if (n.target) top.append(h('span', { class: 'chip', title: n.target.label }, n.target.label));
      card.append(top);
      const text = h('div', { class: 'note-text' }, n.text || h('span', { class: 'muted' }, '(no text)'));
      card.append(text);
      if (n.still && n.id === S.activeNote) card.append(h('img', { class: 'still', src: dataUrl(n.still), alt: 'Still of this moment', title: 'Saved still (Claude gets its path)' }));
      const acts = h('div', { class: 'acts' },
        h('button', { class: 'icon-btn', type: 'button', title: n.done ? 'Mark as not done' : 'Mark as done', 'aria-label': 'Toggle done', html: icon('check'), onclick: () => mutate(() => { n.done = !n.done; }) }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Edit text', 'aria-label': 'Edit note', html: icon('edit'), onclick: () => editNote(n, card) }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete note', 'aria-label': 'Delete note', html: icon('trash'), onclick: () => {
          mutate(() => { clipRec(S.clip).comments = comments().filter((x) => x.id !== n.id); });
          toast('Note deleted', { action: { label: 'Undo', run: undo } });
        } }));
      card.append(acts);
      card.addEventListener('click', (e) => { if (!e.target.closest('button, textarea')) selectNote(n.id, true); });
      box.append(card);
    });
  }

  function editNote(n, card) {
    const text = card.querySelector('.note-text');
    const ta = h('textarea', {});
    ta.value = n.text;
    const done = () => { if (ta.value !== n.text) mutate(() => { n.text = ta.value.trim(); }); else renderNotes(); };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
      if (e.key === 'Escape') { ta.value = n.text; ta.blur(); }
    });
    ta.addEventListener('blur', done, { once: true });
    text.replaceWith(ta);
    ta.focus();
  }

  // ═════════════════════════ tools ═════════════════════════
  function splitAction() {
    if (S.mode !== 'edit') return;
    const item = findSel();
    if (item && (S.sel.kind === 'texts' || S.sel.kind === 'audio')) {
      const r = T.splitItem(S.edit, S.sel.kind, item.id, P.t, fps());
      if (r.changed) { mutate(() => { S.edit = r.edit; }); return; }
    }
    const r = T.splitAt(S.edit, P.t, fps());
    if (!r.changed) { toast('Move the playhead inside a piece (not on its edge) to split it.'); return; }
    mutate(() => { S.edit = r.edit; S.sel = { kind: 'video', id: r.newId }; });
  }

  function deleteAction() {
    if (S.mode !== 'edit' || !S.sel) return;
    const kind = S.sel.kind, id = S.sel.id;
    if (kind === 'video') {
      if (S.edit.video.length <= 1) { toast('This is the last piece — split first, then remove the part you don\'t want.'); return; }
      mutate(() => { S.edit = T.removeSegment(S.edit, id).edit; S.sel = null; });
      toast('Removed from the timeline (your file is untouched)', { action: { label: 'Undo', run: undo } });
    } else {
      mutate(() => { S.edit = T.removeItem(S.edit, kind, id); S.sel = null; });
    }
  }

  function addTextAction() {
    if (S.mode !== 'edit') return;
    const start = round3(Math.min(P.t, Math.max(0, L().duration - 0.5)));
    const r = T.addText(S.edit, { start, end: round3(Math.min(L().duration, start + 3)) });
    mutate(() => { S.edit = r.edit; S.sel = { kind: 'texts', id: r.id }; });
    setTimeout(() => { const ta = $('#inspector textarea'); if (ta) { ta.focus(); ta.select(); } }, 0);
  }

  function popover(anchor, build) {
    closePopover();
    const pop = h('div', { class: 'popover', role: 'menu' });
    build(pop, closePopover);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.top = top + 'px';
    pop.style.left = clamp(r.left, 8, innerWidth - pw - 8) + 'px';
    const first = pop.querySelector('button');
    if (first) first.focus();
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    function outside(e) { if (!pop.contains(e.target)) closePopover(); }
    pop._outside = outside;
  }
  function closePopover() {
    const p = $('.popover');
    if (p) { document.removeEventListener('pointerdown', p._outside, true); p.remove(); }
  }

  function addAudioAction() {
    if (S.mode !== 'edit') return;
    popover($('#audioBtn'), (pop, close) => {
      pop.append(h('div', { class: 'ptitle' }, 'Add to the timeline at the playhead'));
      const auds = S.files.filter((f) => f.kind === 'audio');
      for (const f of auds) pop.append(h('button', { class: 'opt', type: 'button', onclick: () => { close(); placeAudio(f.name); } }, icon('music'), f.name, h('small', {}, bytes(f.size))));
      const vids = videos().filter((f) => f.name !== S.clip);
      if (vids.length) {
        pop.append(h('hr'), h('div', { class: 'ptitle' }, 'Sound from another clip'));
        for (const f of vids) pop.append(h('button', { class: 'opt', type: 'button', onclick: () => { close(); placeAudio(f.name); } }, icon('film'), f.name));
      }
      if (auds.length || vids.length) pop.append(h('hr'));
      pop.append(h('button', { class: 'opt', type: 'button', onclick: () => { close(); $('#audioPick').click(); } }, icon('plus'), 'Add a file from your computer…', h('small', {}, 'copied in')));
    });
  }

  async function placeAudio(file) {
    const meta = await ensureMeta(file);
    const lanes = S.edit.audio;
    const start = round3(P.t);
    const len = Math.max(0.1, Math.min(meta.duration || 10, Math.max(0.1, L().duration - start)));
    let lane = 0;
    for (;; lane++) {
      const busy = lanes.some((a) => (a.lane || 0) === lane && a.start < start + len && start < a.start + (a.out - a.in));
      if (!busy) break;
    }
    const r = T.addAudio(S.edit, { src: file, lane, start, in: 0, out: round3(len) });
    mutate(() => { S.edit = r.edit; S.sel = { kind: 'audio', id: r.id }; });
  }

  function insertClipAction() {
    if (S.mode !== 'edit') return;
    popover($('#clipBtn'), (pop, close) => {
      pop.append(h('div', { class: 'ptitle' }, 'Insert at the playhead'));
      for (const f of videos()) pop.append(h('button', { class: 'opt', type: 'button', onclick: () => { close(); insertClip(f.name); } }, icon('film'), f.name, h('small', {}, f.name === S.clip ? 'this clip' : '')));
      pop.append(h('hr'), h('button', { class: 'opt', type: 'button', onclick: () => { close(); $('#clipPick').click(); } }, icon('plus'), 'Add a clip from your computer…', h('small', {}, 'copied in')));
    });
  }

  async function insertClip(file) {
    const meta = await ensureMeta(file);
    if (!meta.duration) { toast('Could not read that clip.', { error: true }); return; }
    let edit = S.edit;
    const sp = T.splitAt(edit, P.t, fps());
    if (sp.changed) edit = sp.edit;
    const segs = T.layout(edit).segments;
    let idx = segs.findIndex((s) => s.start >= P.t - 1e-3);
    if (idx < 0) idx = segs.length;
    const r = T.insertSegment(edit, idx, { src: file, in: 0, out: meta.duration });
    mutate(() => { S.edit = r.edit; S.sel = { kind: 'video', id: r.id }; });
  }

  async function addFiles(list, then) {
    for (const f of list) {
      const t = toast(`Copying ${f.name} into the project…`, { ms: 60000 });
      try {
        const r = await upload('PUT', `/api/projects/${enc(S.id)}/upload?name=${enc(f.name)}`, f);
        t.remove();
        await refreshFiles();
        if (then) await then(r.name);
      } catch (err) { t.remove(); toast(err.message, { error: true }); }
    }
  }
  $('#audioPick').addEventListener('change', (e) => { addFiles([...e.target.files], placeAudio); e.target.value = ''; });
  $('#clipPick').addEventListener('change', (e) => { addFiles([...e.target.files], insertClip); e.target.value = ''; });

  async function resetAction() {
    if (S.mode !== 'edit') return;
    if (T.isUntouched(S.edit, S.clip, S.meta)) { toast('Nothing to reset — this is the original clip.'); return; }
    const ok = await confirmBox('Reset this edit?', 'Your cuts, text and added audio on this clip go back to the original. Notes stay. You can undo this.', 'Reset edit', 'danger');
    if (ok) mutate(() => { S.edit = T.defaultEdit(S.clip, S.meta); S.sel = null; });
  }

  function setMode(mode) {
    if (S.mode === mode) return;
    const src = T.toSource(view(), P.t);
    S.mode = mode;
    S.sel = null;
    layoutCache = null;
    $('#modeEdit').setAttribute('aria-pressed', String(mode === 'edit'));
    $('#modeOrig').setAttribute('aria-pressed', String(mode === 'original'));
    for (const r of P.audios.values()) r.el.pause();
    computeSlots();
    const t = src ? T.fromSource(view(), src.src, src.time) : 0;
    P.t = t == null ? 0 : t;
    setZoom(S.zoomVal);
    seekTo(P.t);
    renderInspector(); renderNotes(); updateButtons();
  }

  function updateButtons() {
    const edit = S.mode === 'edit';
    $('#undoBtn').disabled = !edit || !S.undo.length;
    $('#redoBtn').disabled = !edit || !S.redo.length;
    $('#deleteBtn').disabled = !edit || !S.sel;
    $('#resetBtn').disabled = !edit || !S.edit || T.isUntouched(S.edit, S.clip, S.meta);
  }

  // ═════════════════════════ clips ═════════════════════════
  function renderClipbar() {
    const bar = $('#clipbar');
    bar.innerHTML = '';
    for (const f of videos()) {
      const rec = S.review.clips[f.name] || {};
      const open = (rec.comments || []).filter((n) => !n.done).length;
      const poster = S.posters[f.name];
      const chip = h('button', { class: 'clip-chip', type: 'button', 'aria-current': String(f.name === S.clip), title: f.name, onclick: () => selectClip(f.name) },
        posterImg(poster), h('span', { class: 'name' }, f.name));
      if (rec.edited || (f.name === S.clip && S.edit && !T.isUntouched(S.edit, S.clip, S.meta))) chip.append(h('span', { class: 'dot', title: 'Edited' }));
      if (open) chip.append(h('span', { class: 'count', title: 'Open notes' }, String(open)));
      bar.append(chip);
    }
    bar.append(h('button', { class: 'clip-chip add', type: 'button', onclick: () => $('#clipPick').click(), title: 'Copy more clips into this project' }, '+ Add clips'));
  }
  const posterOk = {};
  function posterImg(name) {
    if (!name || posterOk[name] === false) return h('span', { class: 'ph' });
    const img = h('img', { src: dataUrl('cache/' + name), alt: '' });
    img.onerror = () => { posterOk[name] = false; img.replaceWith(h('span', { class: 'ph' })); };
    return img;
  }

  async function selectClip(file) {
    if (S.clip === file) return;
    if (S.clip) { storeClip(); if (S.savePending) await save(); }
    pause();
    for (const r of P.els.values()) { r.el.pause(); r.el.remove(); }
    P.els.clear(); P.active = null;
    for (const r of P.audios.values()) r.el.pause();
    P.audios.clear();
    S.clip = file;
    S.sel = null; S.activeNote = null; S.composer = null; S.undo = []; S.redo = [];
    history.replaceState(null, '', `/project?id=${enc(S.id)}&clip=${enc(file)}`);
    document.title = `${file} · ${S.project.name}`;
    setSaveState('');
    S.meta = await ensureMeta(file);
    if (!S.meta.fps) S.meta.fps = 30;
    S.edit = T.normalize(clipRec(file).edit, file, S.meta);
    for (const s of S.edit.video) ensureMeta(s.src);
    for (const a of S.edit.audio) ensureMeta(a.src);
    S.mode = 'edit';
    $('#modeEdit').setAttribute('aria-pressed', 'true');
    $('#modeOrig').setAttribute('aria-pressed', 'false');
    P.t = 0;
    layoutCache = null;
    computeSlots();
    sizeStage();
    seekTo(0);
    setZoom(S.zoomVal, 0);
    renderClipbar(); renderInspector(); renderNotes(); updateButtons();
    capturePoster(file);
  }

  /** Saves a poster frame for the homepage the first time a clip is opened. */
  const postered = new Set();
  function capturePoster(file) {
    const name = S.posters[file];
    if (!name || postered.has(file) || posterOk[name] === true) return;
    postered.add(file);
    const probe = new Image();
    probe.onload = () => { posterOk[name] = true; };
    probe.onerror = () => {
      const v = h('video', { muted: true, preload: 'auto', playsinline: true });
      v.muted = true;
      v.src = mediaUrl(file);
      v.addEventListener('loadeddata', () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); }, { once: true });
      v.addEventListener('seeked', () => {
        const c = h('canvas');
        const w = Math.min(640, v.videoWidth);
        c.width = w; c.height = Math.round(w * v.videoHeight / v.videoWidth);
        try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); } catch { return; }
        c.toBlob((b) => {
          if (!b) return;
          api('POST', `/api/projects/${enc(S.id)}/cache?name=${enc(name)}`, b).then(() => { posterOk[name] = true; renderClipbar(); }).catch(() => {});
        }, 'image/jpeg', 0.82);
        v.removeAttribute('src');
      }, { once: true });
    };
    probe.src = dataUrl('cache/' + name);
  }

  async function refreshFiles() {
    const r = await api('GET', `/api/projects/${enc(S.id)}`);
    const before = new Set(S.files.map((f) => f.name));
    S.files = r.files;
    S.posters = r.posters;
    const added = r.files.filter((f) => !before.has(f.name));
    renderClipbar();
    return added;
  }

  // ═════════════════════════ Copy moments ═════════════════════════
  function buildPrompt(opts) {
    storeClip();
    const clips = [];
    for (const f of videos()) {
      if (opts.scope === 'clip' && f.name !== S.clip) continue;
      const rec = S.review.clips[f.name];
      if (!rec) continue;
      const meta = rec.meta || S.metas[f.name] || {};
      const edit = f.name === S.clip ? S.edit : (rec.edit ? T.normalize(rec.edit, f.name, meta) : null);
      clips.push({ file: f.name, meta, edit, comments: rec.comments || [] });
    }
    return window.Prompt.build({
      project: { name: S.project.name, path: S.project.path },
      dataPath: S.dataPath, clips, includeDone: opts.includeDone, includeJson: opts.includeJson,
    });
  }

  async function copyMoments() {
    const opts = { scope: 'all', includeDone: false, includeJson: true };
    let res = buildPrompt(opts);
    if (!res.text) {
      toast('Nothing to copy yet — add a note (click the picture or press C) or make an edit first.');
      return;
    }
    const ok = await copyText(res.text);
    const pre = h('pre', { class: 'prompt' }, res.text);
    const summary = h('p', { class: 'muted' });
    const setSummary = () => {
      summary.textContent = `${ok ? 'Copied to your clipboard: ' : ''}${res.notes} note${res.notes === 1 ? '' : 's'}${res.edited ? ` and edits on ${res.edited} clip${res.edited === 1 ? '' : 's'}` : ''}. Paste it into your Claude conversation.`;
    };
    setSummary();
    const scope = h('select', {}, h('option', { value: 'all' }, 'All clips in this project'), h('option', { value: 'clip' }, 'Only this clip'));
    const done = h('input', { type: 'checkbox' });
    const json = h('input', { type: 'checkbox', checked: true });
    const rebuild = () => {
      Object.assign(opts, { scope: scope.value, includeDone: done.checked, includeJson: json.checked });
      res = buildPrompt(opts);
      pre.textContent = res.text || '(nothing to copy with these options)';
      setSummary();
    };
    scope.addEventListener('change', rebuild);
    done.addEventListener('change', rebuild);
    json.addEventListener('change', rebuild);
    modal({
      title: ok ? 'Copied — ready to paste into Claude' : 'Your prompt',
      wide: true,
      body: h('div', {}, summary,
        h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' } },
          scope, h('label', { class: 'check' }, done, 'Include notes marked done'), h('label', { class: 'check' }, json, 'Include exact timeline data')),
        pre),
      actions: [
        { label: 'Close', run: (close) => close() },
        { label: 'Copy', kind: 'primary', run: async () => { if (await copyText(res.text)) toast('Copied'); } },
      ],
    });
  }

  // ═════════════════════════ exports ═════════════════════════
  function exportMenu() {
    popover($('#exportBtn'), (pop, close) => {
      pop.append(
        h('button', { class: 'opt', type: 'button', onclick: () => { close(); aafDialog(); } }, icon('music'), 'AAF for Pro Tools…', h('small', {}, 'audio mix')),
        h('button', { class: 'opt', type: 'button', disabled: !S.system.ffmpeg, title: S.system.ffmpeg ? '' : 'Needs ffmpeg (see README)', onclick: () => { close(); renderEdit(); } }, icon('film'), 'MP4 of my edit', h('small', {}, S.system.ffmpeg ? 'render' : 'needs ffmpeg')),
        h('hr'),
        h('button', { class: 'opt', type: 'button', onclick: () => { close(); api('POST', `/api/projects/${enc(S.id)}/reveal`, { what: 'exports' }); } }, icon('folder'), 'Open the Exports folder'));
    });
  }

  function runJob(jobId, title, initial) {
    return new Promise((resolve, reject) => {
      const bar = h('div');
      const step = h('p', { class: 'muted' }, 'Starting…');
      const m = initial || modal({ title, body: h('div', {}, step, h('div', { class: 'progress' }, bar)), actions: [{ label: 'Hide', run: (close) => close() }] });
      const stepEl = initial ? initial.step : step, barEl = initial ? initial.bar : bar;
      const poll = async () => {
        let j;
        try { j = await api('GET', '/api/jobs/' + jobId); } catch (err) { setTimeout(poll, 1500); return; }
        stepEl.textContent = j.step;
        barEl.style.width = Math.round((j.progress || 0) * 100) + '%';
        if (j.status === 'running') { setTimeout(poll, 600); return; }
        m.close();
        if (j.status === 'error') { toast(j.error, { error: true, ms: 10000 }); reject(new Error(j.error)); return; }
        resolve(j);
      };
      poll();
    });
  }

  function showResult(title, j) {
    modal({
      title,
      body: h('div', {},
        h('p', {}, 'Saved in a new folder (nothing was overwritten):'),
        h('ul', { class: 'file-list' }, ...j.files.map((f) => h('li', { class: 'mono' }, f))),
        ...(j.warnings || []).map((w) => h('p', { class: 'muted' }, '⚠ ' + w))),
      actions: [
        { label: 'Close', run: (close) => close() },
        { label: isMac ? 'Show in Finder' : 'Open folder', kind: 'primary', run: (close) => { api('POST', `/api/projects/${enc(S.id)}/reveal`, { what: 'folder', path: j.folder }); close(); } },
      ],
    });
  }

  function editMetas() {
    const m = {};
    const names = new Set([S.clip, ...S.edit.video.map((s) => s.src), ...S.edit.audio.map((a) => a.src)]);
    for (const n of names) m[n] = S.metas[n] || {};
    return m;
  }

  async function renderEdit() {
    storeClip();
    try {
      const r = await api('POST', `/api/projects/${enc(S.id)}/render`, { clip: S.clip, edit: S.edit, metas: editMetas() });
      const j = await runJob(r.job, 'Rendering your edit');
      showResult('Your edit is rendered', j);
    } catch (err) { if (err.status) toast(err.message, { error: true }); }
  }

  function aafDialog() {
    const name = h('input', { type: 'text', value: S.clip.replace(/\.[^.]+$/, '') });
    const tc = h('input', { type: 'text', value: '01:00:00:00', class: 'mono', pattern: '\\d\\d:\\d\\d:\\d\\d[:;]\\d\\d' });
    const ref = h('input', { type: 'checkbox', checked: !!S.system.ffmpeg, disabled: !S.system.ffmpeg });
    const editing = S.mode === 'edit' && !T.isUntouched(S.edit, S.clip, S.meta);
    modal({
      title: 'Export AAF for Pro Tools',
      body: h('div', {},
        h('p', { class: 'muted' }, `Exports ${editing ? 'your edit' : 'the clip'}'s audio as an AAF with the audio embedded: every audio track becomes mono tracks (L / R) with the full source media, so your engineer can extend clips. Volume changes travel as clip gain; fades and mutes are listed in a cue sheet.`),
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Sequence starts at (timecode)'), tc),
        h('label', { class: 'check field' }, ref, S.system.ffmpeg ? 'Also render a reference video with burned-in timecode' : 'Reference video needs ffmpeg (see README)'),
        S.system.ffmpeg ? '' : h('p', { class: 'muted' }, 'Without ffmpeg the audio is decoded by your browser — fine for normal-length videos.')),
      actions: [
        { label: 'Cancel', run: (close) => close() },
        { label: 'Export AAF', kind: 'primary', run: (close) => { close(); exportAAF({ name: name.value.trim() || 'Export', timecode: tc.value.trim(), reference: ref.checked }); } },
      ],
    });
  }

  async function exportAAF(options) {
    storeClip();
    const edit = S.mode === 'edit' ? S.edit : origEdit();
    if (!S.system.ffmpeg) return exportAAFInBrowser(edit, options);
    try {
      const r = await api('POST', `/api/projects/${enc(S.id)}/aaf`, { clip: S.clip, edit, metas: editMetas(), options }, { allow: [409] });
      if (r.status === 409 && r.data && r.data.error === 'NEEDS_BROWSER_AUDIO') return exportAAFInBrowser(edit, options);
      const j = await runJob(r.data.job, 'Exporting AAF');
      showResult('AAF ready for Pro Tools', j);
    } catch (err) { if (err.status) toast(err.message, { error: true }); }
  }

  /** No ffmpeg: decode the audio here and send it to the server as raw PCM. */
  async function exportAAFInBrowser(edit, options) {
    const bar = h('div');
    const step = h('p', { class: 'muted' }, 'Decoding audio…');
    const m = modal({ title: 'Exporting AAF', body: h('div', {}, step, h('div', { class: 'progress' }, bar)), actions: [] });
    try {
      const names = [...new Set([...edit.video.map((s) => s.src), ...edit.audio.map((a) => a.src)])];
      const buffers = {}, metas = {};
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        step.textContent = `Decoding audio from ${n}…`;
        bar.style.width = Math.round((i / names.length) * 40) + '%';
        const meta = await ensureMeta(n);
        try {
          buffers[n] = await MC.decode(rawUrl(n), (fileInfo(n) || {}).size);
          metas[n] = Object.assign({}, meta, { channels: buffers[n].numberOfChannels, hasAudio: true });
        } catch { metas[n] = Object.assign({}, meta, { channels: 0, hasAudio: false }); }
      }
      const plan = T.audioPlan(edit, metas, options.name);
      if (!plan.tracks.length) throw new Error('There is no audio on this timeline to export.');
      const list = T.essenceList(plan);
      const parts = [], essences = [];
      for (const e of list) {
        const buf = buffers[e.source.file];
        let data = buf.getChannelData(Math.min(e.channel, buf.numberOfChannels - 1));
        if (e.source.piece) {
          const pc = e.source.piece;
          data = MC.resample(data.subarray(Math.round(pc.in * 48000), Math.round((pc.out + 0.5 * pc.speed) * 48000)), pc.speed);
        }
        const pcm = MC.toS24(data);
        parts.push(pcm);
        essences.push({ id: e.id, bytes: pcm.length });
      }
      const manifest = new TextEncoder().encode(JSON.stringify({ clip: S.clip, edit, options: Object.assign({}, options, { reference: false }), metas, essences }));
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, manifest.length, true);
      step.textContent = 'Writing the AAF…';
      const j = await upload('POST', `/api/projects/${enc(S.id)}/aaf-upload`, new Blob([head, manifest, ...parts]), (p) => { bar.style.width = Math.round(40 + p * 58) + '%'; });
      m.close();
      if (j.status === 'error') throw new Error(j.error);
      if (plan.sources.some((s) => s.piece)) j.warnings = (j.warnings || []).concat('Speed changes were exported by resampling (pitch follows speed). Install ffmpeg for pitch-preserving stretches.');
      showResult('AAF ready for Pro Tools', j);
    } catch (err) {
      m.close();
      toast(err.message, { error: true, ms: 10000 });
    }
  }

  // ═════════════════════════ wiring ═════════════════════════
  $('#playBtn').addEventListener('click', togglePlay);
  $('#prevFrame').addEventListener('click', () => { pause(); seekTo(P.t - frame()); });
  $('#nextFrame').addEventListener('click', () => { pause(); seekTo(P.t + frame()); });
  $('#addNoteBtn').addEventListener('click', () => openComposer({ t: P.t }));
  $('#modeEdit').addEventListener('click', () => setMode('edit'));
  $('#modeOrig').addEventListener('click', () => setMode('original'));
  $('#monitor').addEventListener('input', (e) => { P.monitor = +e.target.value; applyLevels(); });
  $('#splitBtn').addEventListener('click', splitAction);
  $('#deleteBtn').addEventListener('click', deleteAction);
  $('#textBtn').addEventListener('click', addTextAction);
  $('#audioBtn').addEventListener('click', addAudioAction);
  $('#clipBtn').addEventListener('click', insertClipAction);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#resetBtn').addEventListener('click', resetAction);
  $('#zoom').addEventListener('input', (e) => setZoom(+e.target.value));
  $('#fitBtn').addEventListener('click', () => { setZoom(0); tlScroll.scrollLeft = 0; });
  $('#copyBtn').addEventListener('click', copyMoments);
  $('#exportBtn').addEventListener('click', exportMenu);
  $('#showDone').addEventListener('change', (e) => { S.showDone = e.target.checked; renderNotes(); renderTimeline(); renderOverlays(); });
  tlScroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(S.zoomVal - Math.sign(e.deltaY) * 6, tOf(e.clientX)); }
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if (typing || $('.modal-back')) return;
    const k = e.key;
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && k.toLowerCase() === 'z') { e.preventDefault(); if (S.mode === 'edit') (e.shiftKey ? redo : undo)(); return; }
    if (cmd && k.toLowerCase() === 'y') { e.preventDefault(); if (S.mode === 'edit') redo(); return; }
    if (cmd) return;
    if (k === ' ') { e.preventDefault(); togglePlay(); } else if (k === 'ArrowLeft') { e.preventDefault(); pause(); seekTo(P.t - (e.shiftKey ? 1 : frame())); } else if (k === 'ArrowRight') { e.preventDefault(); pause(); seekTo(P.t + (e.shiftKey ? 1 : frame())); } else if (k === 'Home') { seekTo(0); } else if (k === 'End') { seekTo(L().duration); } else if (k === 'c' || k === 'C' || k === 'n' || k === 'N') { e.preventDefault(); openComposer({ t: P.t }); } else if (k === 's' || k === 'S') { e.preventDefault(); splitAction(); } else if (k === 't' || k === 'T') { e.preventDefault(); addTextAction(); } else if (k === 'a' || k === 'A') { e.preventDefault(); addAudioAction(); } else if (k === 'Delete' || k === 'Backspace') { if (S.sel) { e.preventDefault(); deleteAction(); } } else if (k === 'Escape') { if (S.composer) closeComposer(); else select(null); closePopover(); } else if (k === '+' || k === '=') { setZoom(S.zoomVal + 8); } else if (k === '-') { setZoom(S.zoomVal - 8); }
  });

  // Drop files onto the page to add them (video → new clip, audio → timeline).
  document.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const auds = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aif|aiff|mp3|m4a|flac)$/i.test(f.name));
    const vids = files.filter((f) => !auds.includes(f));
    if (vids.length) addFiles(vids, null).then(() => toast('Added — pick the new clip in the bar at the top.'));
    if (auds.length) addFiles(auds, S.mode === 'edit' ? placeAudio : null);
  });

  // Watch for new clips (for example a new version Claude just rendered).
  setInterval(async () => {
    if (document.hidden || !S.project) return;
    try {
      const added = await refreshFiles();
      for (const f of added.filter((x) => x.kind === 'video')) {
        toast(`New clip: ${f.name}`, { action: { label: 'Open', run: () => selectClip(f.name) }, ms: 10000 });
      }
    } catch { /* server stopped */ }
  }, 4000);

  // ═════════════════════════ start ═════════════════════════
  async function init() {
    if (!S.id) { location.href = '/'; return; }
    try {
      const [sys, detail] = await Promise.all([api('GET', '/api/system'), api('GET', `/api/projects/${enc(S.id)}`)]);
      S.system = sys;
      Object.assign(S, { project: detail.project, files: detail.files, posters: detail.posters, review: detail.review, dataPath: detail.dataPath, exportsPath: detail.exportsPath });
    } catch (err) {
      document.body.innerHTML = '';
      document.body.append(h('div', { class: 'home' }, h('div', { class: 'empty-state' }, h('h2', {}, 'Project not found'), h('p', {}, err.message), h('a', { href: '/', class: 'btn' }, 'Back to projects'))));
      return;
    }
    $('#projName').textContent = S.project.name;
    $('#projPath').textContent = S.project.path;
    $('#projPath').title = S.project.path;
    document.title = `${S.project.name} · Video Review`;
    const vids = videos();
    if (!vids.length) {
      renderClipbar();
      $('#stage').append(h('div', { class: 'stage-msg' }, h('div', {},
        h('p', {}, h('strong', {}, 'No clips in this project yet.')),
        h('p', { class: 'muted' }, 'Drop video files on this page, or put them in this folder:'),
        h('p', { class: 'mono' }, S.project.path),
        h('button', { class: 'btn primary', type: 'button', onclick: () => $('#clipPick').click() }, 'Add clips…'))));
      $('#stage').style.width = '640px'; $('#stage').style.height = '360px';
      setInterval(async () => { const added = await refreshFiles().catch(() => []); if (added.some((f) => f.kind === 'video')) location.reload(); }, 3000);
      return;
    }
    const wanted = params.get('clip');
    const first = vids.find((f) => f.name === wanted) || vids.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    await selectClip(first.name);
  }
  init();
})();
