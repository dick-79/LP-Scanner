'use strict';

const MODEL = 'claude-sonnet-5-5';
const $ = (s) => document.querySelector(s);
const ls = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* opslag geblokkeerd */ } },
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v, cur) => {
  try { return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: cur || 'EUR' }).format(v); }
  catch (e) { return (cur || 'EUR') + ' ' + v; }
};

/* ---------- status ---------- */
function setStatus(msg, kind) {
  const el = $('#status');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = 'status' + (kind === 'error' ? ' error' : '');
  el.innerHTML = (kind === 'error' ? '' : '<span class="spinner" aria-hidden="true"></span>') + '<span></span>';
  el.lastChild.textContent = msg;
}

/* ---------- instellingen ---------- */
const dlg = $('#settings');
function openSettings() {
  $('#s-discogs').value = ls.get('discogs_token');
  $('#s-anthropic').value = ls.get('anthropic_key');
  dlg.showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'save') {
    ls.set('discogs_token', $('#s-discogs').value.trim());
    ls.set('anthropic_key', $('#s-anthropic').value.trim());
    setStatus('');
  }
});
function haveKeys() {
  if (ls.get('discogs_token') && ls.get('anthropic_key')) return true;
  openSettings();
  return false;
}

/* ---------- foto ---------- */
async function toJpeg(file, max) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { url, b64: url.split(',')[1] };
}

async function identify(b64) {
  const prompt = 'Dit is een foto van een LP-hoes (vinyl). Lees de artiest en de albumtitel af. ' +
    'Geef ook catalogusnummer, label en jaar als die zichtbaar zijn. ' +
    'Antwoord alleen met JSON in dit formaat: ' +
    '{"artist":"","title":"","catno":"","label":"","year":"","confidence":"hoog|middel|laag"}. ' +
    'Laat een veld leeg als je het niet zeker weet. Verzin niets.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ls.get('anthropic_key'),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: prompt },
      ] }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || ('Fout ' + res.status);
    throw new Error('Foto lezen mislukt: ' + msg);
  }
  const text = (data.content || []).map((p) => p.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Ik kon geen artiest en titel uit de foto halen.');
  return JSON.parse(m[0]);
}

async function onPhoto(file) {
  if (!file || !haveKeys()) return;
  $('#results').hidden = true;
  $('#detail').hidden = true;
  try {
    setStatus('Hoes lezen…');
    const img = await toJpeg(file, 1280);
    $('#preview').src = img.url;
    $('#found').hidden = false;
    const info = await identify(img.b64);
    $('#f-artist').value = info.artist || '';
    $('#f-title').value = info.title || '';
    $('#f-catno').value = info.catno || '';
    if (!info.artist && !info.title) {
      setStatus('De hoes was niet te lezen. Vul artiest en titel zelf in en zoek.', 'error');
      return;
    }
    await runSearch();
  } catch (e) {
    setStatus(e.message, 'error');
  }
}
$('#file-camera').addEventListener('change', (e) => { onPhoto(e.target.files[0]); e.target.value = ''; });
$('#file-gallery').addEventListener('change', (e) => { onPhoto(e.target.files[0]); e.target.value = ''; });
$('#alt-gallery').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-gallery').click(); } });

/* ---------- Discogs ---------- */
async function dg(path, params) {
  const q = new URLSearchParams(Object.assign({}, params, { token: ls.get('discogs_token') }));
  const res = await fetch('https://api.discogs.com' + path + '?' + q.toString());
  if (res.status === 401) throw new Error('Discogs weigert de token. Controleer hem in de instellingen.');
  if (res.status === 429) throw new Error('Te veel Discogs-aanvragen. Wacht een minuut en probeer opnieuw.');
  if (!res.ok) throw new Error('Discogs gaf fout ' + res.status + '.');
  return res.json();
}

async function runSearch() {
  const artist = $('#f-artist').value.trim();
  const title = $('#f-title').value.trim();
  const catno = $('#f-catno').value.trim();
  if (!artist && !title && !catno) { setStatus('Vul een artiest of titel in.', 'error'); return; }
  setStatus('Zoeken op Discogs…');
  $('#detail').hidden = true;
  try {
    const base = { type: 'release', format: 'Vinyl', per_page: '12' };
    let data = await dg('/database/search', Object.assign({}, base, artist && { artist }, title && { release_title: title }, catno && { catno }));
    if (!(data.results || []).length) {
      data = await dg('/database/search', Object.assign({}, base, { q: (artist + ' ' + title).trim() }));
    }
    renderResults(data.results || []);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}
$('#btn-search').addEventListener('click', runSearch);

function renderResults(list) {
  const box = $('#results');
  if (!list.length) {
    box.hidden = true;
    setStatus('Niets gevonden. Pas artiest of titel aan en zoek opnieuw.', 'error');
    return;
  }
  setStatus('');
  box.hidden = false;
  box.innerHTML = '<h2>Kies jouw persing</h2>' + list.map((r) => {
    const meta = [r.year, r.country, (r.label || [])[0], r.catno].filter(Boolean).join(' · ');
    const fmt = (r.format || []).join(', ');
    const thumb = r.thumb ? '<img src="' + esc(r.thumb) + '" alt="" loading="lazy">' : '<span class="noimg"></span>';
    return '<button class="res" type="button" data-id="' + esc(r.id) + '">' + thumb +
      '<span><b>' + esc(r.title) + '</b><span class="meta">' + esc(meta) + '<br>' + esc(fmt) + '</span></span></button>';
  }).join('');
  box.querySelectorAll('.res').forEach((b) => b.addEventListener('click', () => showDetail(b.dataset.id)));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function showDetail(id) {
  setStatus('Prijzen ophalen…');
  try {
    const [rel, stats, sugg] = await Promise.allSettled([
      dg('/releases/' + id, { curr_abbr: 'EUR' }),
      dg('/marketplace/stats/' + id, { curr_abbr: 'EUR' }),
      dg('/marketplace/price_suggestions/' + id, {}),
    ]);
    if (rel.status !== 'fulfilled') throw rel.reason;
    setStatus('');
    renderDetail(rel.value, stats.status === 'fulfilled' ? stats.value : null, sugg.status === 'fulfilled' ? sugg.value : null);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function renderDetail(r, stats, sugg) {
  const artists = (r.artists || []).map((a) => a.name.replace(/\s\(\d+\)$/, '')).join(', ');
  const label = (r.labels || []).map((l) => l.name + (l.catno ? ' ' + l.catno : '')).join(', ');
  const fmt = (r.formats || []).map((f) => [f.name].concat(f.descriptions || []).join(', ')).join(' · ');
  const img = (r.images && r.images[0]) ? (r.images[0].uri150 || r.images[0].uri) : '';
  const have = r.community && r.community.have, want = r.community && r.community.want;

  let low = null, cur = 'EUR', n = null;
  if (stats && stats.lowest_price) { low = stats.lowest_price.value; cur = stats.lowest_price.currency || 'EUR'; }
  else if (typeof r.lowest_price === 'number') { low = r.lowest_price; }
  n = stats && stats.num_for_sale != null ? stats.num_for_sale : r.num_for_sale;

  let priceHtml = '<div class="price"><span class="meta">Laagste vraagprijs op Discogs</span>' +
    (low != null
      ? '<span class="big">' + esc(money(low, cur)) + '</span><span class="meta">' + esc(n) + ' te koop</span>'
      : '<span class="big"><small>Nu niet te koop</small></span>') + '</div>';

  let suggHtml = '';
  if (sugg && Object.keys(sugg).length) {
    suggHtml = '<div><span class="meta">Richtprijs per conditie</span><table>' +
      Object.keys(sugg).map((k) => '<tr><td>' + esc(k) + '</td><td>' + esc(money(sugg[k].value, sugg[k].currency)) + '</td></tr>').join('') +
      '</table></div>';
  }

  const tracks = (r.tracklist || []).filter((t) => t.type_ !== 'heading');
  const trackHtml = tracks.length
    ? '<details><summary>Tracklist (' + tracks.length + ')</summary><ol class="tracks">' +
      tracks.map((t) => '<li>' + esc(t.title) + (t.duration ? ' <span class="meta">' + esc(t.duration) + '</span>' : '') + '</li>').join('') + '</ol></details>'
    : '';

  const d = $('#detail');
  d.hidden = false;
  d.innerHTML =
    '<button class="ghost" id="back" type="button">← Andere persingen</button>' +
    '<div class="hero">' + (img ? '<img src="' + esc(img) + '" alt="Hoes">' : '<span></span>') +
    '<div><h2>' + esc(artists) + ' – ' + esc(r.title) + '</h2>' +
    '<span class="meta">' + esc([r.year, r.country].filter(Boolean).join(' · ')) + '<br>' + esc(label) + '<br>' + esc(fmt) + '</span></div></div>' +
    priceHtml + suggHtml +
    (have != null ? '<p class="meta">In ' + esc(have) + ' collecties · ' + esc(want) + ' mensen willen hem</p>' : '') +
    '<p class="note">Dit zijn vraagprijzen van verkopers en richtprijzen, geen verkoopprijzen. De werkelijke verkopen staan op de Discogs-pagina.</p>' +
    trackHtml +
    '<a class="primary link" href="' + esc(r.uri) + '" target="_blank" rel="noopener">Open op Discogs</a>';
  $('#results').hidden = true;
  $('#back').addEventListener('click', () => { d.hidden = true; $('#results').hidden = false; });
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- start ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
if (!ls.get('discogs_token') || !ls.get('anthropic_key')) {
  window.addEventListener('load', () => setTimeout(openSettings, 400));
}
