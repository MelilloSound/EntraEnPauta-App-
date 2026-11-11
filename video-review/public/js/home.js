/* Homepage: your video projects, newest first. */
(function () {
  'use strict';
  const { $, h, api, upload, toast, modal, ago, icon } = window.UI;

  let system = {};
  let lastJson = '';

  $('#logo').innerHTML = icon('logo');
  if (navigator.platform && !/Mac/i.test(navigator.platform)) {
    $('#revealRoot').textContent = /Win/i.test(navigator.platform) ? 'Show in Explorer' : 'Open folder';
  }

  async function loadSystem() {
    system = await api('GET', '/api/system');
    $('#rootPath').textContent = system.root;
    const pill = $('#ffmpeg');
    pill.className = 'pill ' + (system.ffmpeg ? 'ok' : 'off');
    pill.textContent = system.ffmpeg ? 'ffmpeg ready' : 'ffmpeg not installed';
    pill.title = system.ffmpeg
      ? 'Rendering MP4s, playable copies and fast AAF export are available.'
      : 'Everything works, but MP4 rendering is off. AAF export still works (audio is decoded in the browser). See README to install ffmpeg.';
  }

  function projectUrl(p) { return '/project?id=' + encodeURIComponent(p.id); }

  function card(p) {
    const thumb = h('div', { class: 'thumb' });
    if (p.missing) {
      thumb.append(h('div', { class: 'empty' }, 'Folder not found', h('br'), p.path));
    } else if (p.poster) {
      thumb.append(h('img', { src: `/data/${encodeURIComponent(p.id)}/${p.poster}`, alt: '', loading: 'lazy' }));
    } else if (p.latestClip) {
      const v = h('video', { src: `/media/${encodeURIComponent(p.id)}/${encodeURIComponent(p.latestClip)}#t=1`, preload: 'metadata', muted: true, playsinline: true });
      v.muted = true;
      thumb.append(v);
    } else {
      thumb.append(h('div', { class: 'empty' }, 'No clips yet', h('br'), 'Drop video files here'));
    }
    if (p.linked) thumb.append(h('span', { class: 'pill badge', title: p.path }, 'Added folder'));
    if (p.comments && p.comments.open) thumb.append(h('span', { class: 'notes-badge', title: 'Open notes' }, `${p.comments.open} note${p.comments.open === 1 ? '' : 's'}`));

    const bits = [];
    bits.push(`${p.clips} clip${p.clips === 1 ? '' : 's'}`);
    if (p.audio) bits.push(`${p.audio} audio`);
    if (p.edited) bits.push(`${p.edited} edited`);

    const el = h('a', { class: 'card', href: p.missing ? '#' : projectUrl(p), 'data-id': p.id },
      thumb,
      h('div', { class: 'meta' },
        h('h3', { title: p.name }, p.name),
        h('div', { class: 'line' }, bits.join(' · ')),
        h('div', { class: 'line' }, p.missing ? p.path : 'Updated ' + ago(p.updated))));

    if (p.missing) {
      el.addEventListener('click', (e) => e.preventDefault());
      el.querySelector('.meta').append(h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: async (e) => {
          e.preventDefault(); e.stopPropagation();
          await api('POST', `/api/projects/${encodeURIComponent(p.id)}/forget`);
          refresh(true);
        } }, 'Remove from list')));
    } else {
      // Drop files on a card to add them to that project.
      el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        el.classList.remove('drop');
        document.body.classList.remove('dragging');
        uploadFiles(p, [...e.dataTransfer.files]);
      });
    }
    return el;
  }

  function render(data) {
    const box = $('#projects');
    box.innerHTML = '';
    if (!data.projects.length) {
      box.append(h('div', { class: 'empty-state' },
        h('h2', {}, 'No projects yet'),
        h('p', {}, 'A project is just a folder of clips. Drop video files on this page, click New project, or put a folder of videos inside your projects folder:'),
        h('p', {}, h('code', { class: 'mono' }, data.root)),
        h('p', { class: 'muted' }, 'Already have the videos somewhere else, like an external drive? Use "Add a folder…" — nothing gets copied or moved.'),
        h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn primary', type: 'button', onclick: newProject }, 'New project'))));
      return;
    }
    const grid = h('div', { class: 'grid' });
    for (const p of data.projects) grid.append(card(p));
    box.append(grid);
  }

  async function refresh(force) {
    try {
      const data = await api('GET', '/api/projects');
      const json = JSON.stringify(data);
      if (force || json !== lastJson) { lastJson = json; render(data); }
    } catch (err) {
      if (force) toast('Could not load projects: ' + err.message, { error: true });
    }
  }

  async function newProject(files) {
    const suggested = files && files.length ? files[0].name.replace(/\.[^.]+$/, '') : 'New project';
    const input = h('input', { type: 'text', value: suggested, 'aria-label': 'Project name' });
    const m = modal({
      title: 'New project',
      body: h('div', {},
        h('p', { class: 'muted' }, 'This creates a folder with this name in your projects folder.'),
        h('label', { class: 'field' }, h('span', {}, 'Name'), input)),
      actions: [
        { label: 'Cancel', run: (close) => close() },
        { label: files && files.length ? `Create and add ${files.length} file${files.length === 1 ? '' : 's'}` : 'Create', kind: 'primary', run: async (close) => {
          try {
            const p = await api('POST', '/api/projects', { name: input.value.trim() || 'New project' });
            close();
            if (files && files.length) { await uploadFiles(p, files); refresh(true); } else location.href = projectUrl(p);
          } catch (err) { toast(err.message, { error: true }); }
        } },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.footer.querySelector('.primary').click(); });
    setTimeout(() => input.select(), 0);
  }

  function linkFolder() {
    const input = h('input', { type: 'text', placeholder: '/Users/you/Movies/My campaign', 'aria-label': 'Folder path' });
    const isMac = /Mac/i.test(navigator.platform || '');
    const m = modal({
      title: 'Add an existing folder',
      body: h('div', {},
        h('p', { class: 'muted' }, 'Use a folder that already has your clips — for example on an external drive. Nothing is copied or moved; the app only adds its notes in a hidden ".review" folder and exports into "Exports".'),
        h('label', { class: 'field' }, h('span', {}, 'Folder path'), input),
        h('p', { class: 'muted', style: { fontSize: '12.5px' } }, isMac
          ? 'Tip: in Finder, select the folder and press ⌥⌘C to copy its path, then paste it here.'
          : 'Tip: in Explorer, Shift + right-click the folder and choose "Copy as path".')),
      actions: [
        { label: 'Cancel', run: (close) => close() },
        { label: 'Add folder', kind: 'primary', run: async (close) => {
          try {
            const p = await api('POST', '/api/projects/link', { path: input.value.trim().replace(/^["']|["']$/g, '') });
            close();
            location.href = projectUrl(p);
          } catch (err) { toast(err.message, { error: true }); }
        } },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.footer.querySelector('.primary').click(); });
  }

  async function uploadFiles(project, files) {
    const media = files.filter((f) => /^(video|audio)\//.test(f.type) || /\.(mov|mkv|mts|m2ts|avi|wav|aif|aiff|flac|m4a|mp3)$/i.test(f.name));
    if (!media.length) { toast('Only video and audio files can be added.', { error: true }); return; }
    const total = media.reduce((s, f) => s + f.size, 0);
    let done = 0;
    const bar = h('div');
    const label = h('p', { class: 'muted' }, 'Copying into ' + project.name + '…');
    const m = modal({ title: 'Adding files', body: h('div', {}, label, h('div', { class: 'progress' }, bar)), actions: [] });
    try {
      for (const f of media) {
        label.textContent = `Copying ${f.name}…`;
        await upload('PUT', `/api/projects/${encodeURIComponent(project.id)}/upload?name=${encodeURIComponent(f.name)}`, f,
          (p) => { bar.style.width = (((done + p * f.size) / total) * 100).toFixed(1) + '%'; });
        done += f.size;
      }
      m.close();
      toast(`Added ${media.length} file${media.length === 1 ? '' : 's'} to ${project.name}. Your originals were not touched.`);
      refresh(true);
    } catch (err) {
      m.close();
      toast(err.message, { error: true });
    }
  }

  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    newProject([...e.dataTransfer.files]);
  });

  $('#newBtn').addEventListener('click', () => newProject());
  $('#linkBtn').addEventListener('click', linkFolder);
  $('#revealRoot').addEventListener('click', () => api('POST', '/api/reveal-root'));

  loadSystem().catch(() => {});
  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, 5000);
})();
