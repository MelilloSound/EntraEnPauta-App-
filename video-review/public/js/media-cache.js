/*
 * Filmstrip thumbnails, waveforms and decoded audio, computed in the browser.
 * Waveforms are saved to the project's .review/cache so they're instant the
 * next time.
 */
(function () {
  'use strict';
  const { api } = window.UI;

  const PEAKS_PER_SEC = 100;
  const MAX_DECODE_BYTES = 1024 * 1024 * 1024; // 1 GB
  const thumbJobs = new Map();
  const peakJobs = new Map();
  const decoded = new Map();

  /** Filmstrip frames for one video, generated in the background. */
  function thumbs(url, duration, onUpdate) {
    if (thumbJobs.has(url)) {
      const job = thumbJobs.get(url);
      job.listeners.add(onUpdate);
      return job;
    }
    const step = Math.max(0.5, duration / 120);
    const job = { step, frames: [], listeners: new Set([onUpdate]), aspect: 16 / 9 };
    thumbJobs.set(url, job);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = url;
    const notify = () => job.listeners.forEach((fn) => fn && fn(job));
    v.addEventListener('loadeddata', async () => {
      job.aspect = (v.videoWidth / v.videoHeight) || job.aspect;
      const H = 60, W = Math.round(H * job.aspect);
      const count = Math.max(1, Math.ceil(duration / step));
      // Coarse pass first (every 4th frame), then fill in, so the strip appears quickly.
      const order = [];
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < count; i++) if ((i % 4 === 0) === (pass === 0)) order.push(i);
      let since = 0;
      for (const i of order) {
        const t = Math.min(duration - 0.05, i * step + 0.01);
        try {
          await seek(v, Math.max(0, t));
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          c.getContext('2d').drawImage(v, 0, 0, W, H);
          job.frames[i] = c;
        } catch { break; }
        if (++since >= 6) { since = 0; notify(); }
      }
      notify();
      v.removeAttribute('src'); v.load();
    }, { once: true });
    return job;
  }

  function seek(v, t) {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); };
      const timer = setTimeout(() => { v.removeEventListener('seeked', done); reject(new Error('seek timeout')); }, 5000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  /** Nearest filmstrip frame to a source time. */
  function frameAt(job, t) {
    if (!job || !job.frames.length) return null;
    let i = Math.round(t / job.step);
    for (let d = 0; d < 6; d++) {
      if (job.frames[i - d]) return job.frames[i - d];
      if (job.frames[i + d]) return job.frames[i + d];
    }
    return null;
  }

  /** Audio decoded at 48 kHz (needed for waveforms and browser-side AAF export). */
  function decode(url, size) {
    if (decoded.has(url)) return decoded.get(url);
    const p = (async () => {
      if (size && size > MAX_DECODE_BYTES) throw new Error('File too large to decode in the browser');
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not read the file');
      const buf = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      return await ctx.decodeAudioData(buf);
    })();
    decoded.set(url, p);
    p.catch(() => decoded.delete(url));
    return p;
  }

  /** Waveform peaks (0..1, PEAKS_PER_SEC per second). Cached on disk. */
  function peaks(projectId, file, url) {
    const key = `peaks-${file.name.replace(/[^\w .()+-]/g, '_')}-${file.size}-${Math.round(file.mtime)}.json`;
    if (peakJobs.has(key)) return peakJobs.get(key);
    const p = (async () => {
      try {
        const res = await fetch(`/data/${encodeURIComponent(projectId)}/cache/${encodeURIComponent(key)}`);
        if (res.ok) {
          const j = await res.json();
          return { rate: j.rate, data: Uint8Array.from(atob(j.data), (ch) => ch.charCodeAt(0)), channels: j.channels };
        }
      } catch { /* not cached yet */ }
      const audio = await decode(url, file.size);
      const n = Math.ceil(audio.duration * PEAKS_PER_SEC);
      const bucket = audio.sampleRate / PEAKS_PER_SEC;
      const data = new Uint8Array(n);
      const chans = [];
      for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
      for (let i = 0; i < n; i++) {
        let max = 0;
        const a = Math.floor(i * bucket), b = Math.min(chans[0].length, Math.floor((i + 1) * bucket));
        for (const ch of chans) for (let k = a; k < b; k += 2) { const v = Math.abs(ch[k]); if (v > max) max = v; }
        data[i] = Math.min(255, Math.round(Math.sqrt(max) * 255)); // sqrt: quiet parts stay visible
      }
      const b64 = btoa(chunkedB64(data));
      api('POST', `/api/projects/${encodeURIComponent(projectId)}/cache?name=${encodeURIComponent(key)}`,
        new Blob([JSON.stringify({ rate: PEAKS_PER_SEC, channels: audio.numberOfChannels, data: b64 })])).catch(() => {});
      return { rate: PEAKS_PER_SEC, data, channels: audio.numberOfChannels };
    })();
    peakJobs.set(key, p);
    p.catch(() => peakJobs.delete(key));
    return p;
  }

  function chunkedB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
  }

  /** Draws peaks for source range [t0, t1] across a canvas. */
  function drawWave(canvas, pk, t0, t1, color) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!pk) return;
    ctx.fillStyle = color;
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const a = Math.floor((t0 + (x / W) * (t1 - t0)) * pk.rate);
      const b = Math.max(a + 1, Math.floor((t0 + ((x + 1) / W) * (t1 - t0)) * pk.rate));
      let m = 0;
      for (let i = a; i < b && i < pk.data.length; i++) if (i >= 0 && pk.data[i] > m) m = pk.data[i];
      const hgt = Math.max(1, (m / 255) * (H - 4));
      ctx.fillRect(x, mid - hgt / 2, 1, hgt);
    }
  }

  /** Converts float samples to raw 24-bit little-endian PCM. */
  function toS24(samples) {
    const out = new Uint8Array(samples.length * 3);
    for (let i = 0, o = 0; i < samples.length; i++, o += 3) {
      let v = Math.max(-1, Math.min(1, samples[i]));
      v = v < 0 ? Math.round(v * 8388608) : Math.round(v * 8388607);
      out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = (v >> 16) & 0xff;
    }
    return out;
  }

  /** A time-changed copy by resampling (pitch changes with speed, like tape). */
  function resample(samples, speed) {
    const n = Math.floor(samples.length / speed);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * speed, k = Math.floor(x), f = x - k;
      out[i] = (samples[k] || 0) * (1 - f) + (samples[k + 1] || 0) * f;
    }
    return out;
  }

  window.MediaCache = { thumbs, frameAt, decode, peaks, drawWave, toS24, resample };
})();
