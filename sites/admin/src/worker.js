// AP11: Internal Admin Site Worker
// Workspace-interne Admin-Oberflaeche fuer KI-tomat Team
//
const SITES_USER_EMAIL_HEADER = 'oai-authenticated-user-email';
const LEGACY_USER_HEADER = 'x-openai-workspace-user';
const INPUT_MAX_LEN = 2000;

// Default Release-Checkliste AP8-AP13
const DEFAULT_CHECKLIST = [
  { id: 'ap8',  label: 'AP8: Sites-Grundstruktur' },
  { id: 'ap9',  label: 'AP9: Public Content API + D1 Cache' },
  { id: 'ap10', label: 'AP10: WebUI Data Bridge' },
  { id: 'ap11', label: 'AP11: Internal Admin Site' },
  { id: 'ap12', label: 'AP12: Contribution Persistence + GitHub-Handoff' },
  { id: 'ap13', label: 'AP13: Integration, QA, Rollout' },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // Workspace-User-Header pruefen (Sites liefert diesen nach Auth)
    const workspaceUser =
      request.headers.get(SITES_USER_EMAIL_HEADER) ||
      request.headers.get(LEGACY_USER_HEADER);
    const isLocalDev = env.LOCAL_DEV === 'true';

    // POST-Endpunkte: ohne Header immer 401 (ausser expliziter lokaler Dev-Bypass)
    if (method === 'POST' && !workspaceUser && !isLocalDev) {
      return jsonResp({ error: 'Kein Workspace-User-Header – Zugriff verweigert.' }, 401);
    }

    // Origin-Check fuer POST (CSRF-Schutz)
    if (method === 'POST') {
      const origin = request.headers.get('Origin') || '';
      const allowed = env.ALLOWED_ORIGIN || '';
      if (allowed && origin !== allowed) {
        return jsonResp({ error: 'Origin nicht erlaubt.' }, 403);
      }
    }

    // Routing
    if (url.pathname === '/api/admin/state' && method === 'GET') {
      return handleState(env);
    }
    if (url.pathname === '/api/admin/notes' && method === 'POST') {
      return handleNotesPost(request, env, workspaceUser);
    }
    if (url.pathname === '/api/admin/checklist' && method === 'POST') {
      return handleChecklistPost(request, env);
    }

    // HTML-Seite
    return renderAdminPage(env, workspaceUser);
  },
};

// ---- GET /api/admin/state ----
async function handleState(env) {
  await ensureSchema(env);

  const contentApiUrl = env.CONTENT_API_URL;
  let apiStatus = 'nicht konfiguriert';
  let inventory = [];
  let apiError = null;

  if (contentApiUrl) {
    try {
      const resp = await fetch(`${contentApiUrl}/api/content`, {
        headers: { 'Accept': 'application/json' },
      });
      if (resp.ok) {
        const data = await resp.json();
        apiStatus = 'erreichbar';
        inventory = Array.isArray(data) ? data : (data.artifacts || data.items || []);
      } else {
        apiStatus = `HTTP ${resp.status}`;
        apiError = `Content API antwortete mit ${resp.status}`;
      }
    } catch (e) {
      apiStatus = 'nicht erreichbar';
      apiError = e.message;
    }
  }

  // D1: letzte 10 Notizen
  let notes = [];
  if (env.DB) {
    const result = await env.DB
      .prepare('SELECT id, created_at, author_key, body FROM team_notes ORDER BY id DESC LIMIT 10')
      .all();
    notes = result.results || [];
  }

  // D1: Checkliste (mit Default-Seeding)
  const checklist = await getOrSeedChecklist(env);

  return jsonResp({
    contentApiConfigured: Boolean(contentApiUrl),
    apiStatus,
    apiError,
    artifactCount: inventory.length,
    inventory,
    notes,
    checklist,
    generatedAt: new Date().toISOString(),
  });
}

// ---- POST /api/admin/notes ----
async function handleNotesPost(request, env, workspaceUser) {
  await ensureSchema(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: 'Ungültiges JSON.' }, 400);
  }

  const text = String(body.text || '').trim();
  if (!text) return jsonResp({ error: 'text darf nicht leer sein.' }, 400);
  if (text.length > INPUT_MAX_LEN) {
    return jsonResp({ error: `text zu lang (max ${INPUT_MAX_LEN} Zeichen).` }, 400);
  }

  // Kein E-Mail-Feld – nur pseudonymer author_key (max 32 Zeichen, nur sichere Zeichen)
  const authorKey = workspaceUser
    ? String(workspaceUser).substring(0, 32).replace(/[^a-zA-Z0-9_\-]/g, '')
    : null;

  if (!env.DB) return jsonResp({ error: 'D1 nicht konfiguriert.' }, 500);

  await env.DB
    .prepare('INSERT INTO team_notes (created_at, author_key, body) VALUES (?, ?, ?)')
    .bind(new Date().toISOString(), authorKey, text)
    .run();

  return jsonResp({ ok: true });
}

// ---- POST /api/admin/checklist ----
async function handleChecklistPost(request, env) {
  await ensureSchema(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: 'Ungültiges JSON.' }, 400);
  }

  const id = String(body.id || '').trim().substring(0, 64);
  if (!id) return jsonResp({ error: 'id fehlt.' }, 400);
  const checked = body.checked === true ? 1 : 0;

  if (!env.DB) return jsonResp({ error: 'D1 nicht konfiguriert.' }, 500);

  await env.DB
    .prepare('UPDATE checklist_items SET done = ?, updated_at = ? WHERE id = ?')
    .bind(checked, new Date().toISOString(), id)
    .run();

  return jsonResp({ ok: true });
}

// ---- Checkliste seeden wenn leer ----
async function getOrSeedChecklist(env) {
  if (!env.DB) return [];

  await ensureSchema(env);

  const existing = await env.DB.prepare('SELECT * FROM checklist_items').all();
  if (existing.results && existing.results.length > 0) {
    return existing.results;
  }

  const now = new Date().toISOString();
  for (const item of DEFAULT_CHECKLIST) {
    await env.DB
      .prepare('INSERT OR IGNORE INTO checklist_items (id, label, done, updated_at) VALUES (?, ?, 0, ?)')
      .bind(item.id, item.label, now)
      .run();
  }

  const seeded = await env.DB.prepare('SELECT * FROM checklist_items').all();
  return seeded.results || [];
}

async function ensureSchema(env) {
  if (!env.DB) return;

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      author_key TEXT,
      body TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`),
  ]);
}

// ---- HTML-Escape (XSS-Schutz) ----
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---- Admin-HTML serverseitig rendern ----
async function renderAdminPage(env, workspaceUser) {
  const isLocalDev = !workspaceUser;

  let state = {
    contentApiConfigured: Boolean(env.CONTENT_API_URL),
    apiStatus: 'unbekannt',
    apiError: null,
    artifactCount: 0,
    inventory: [],
    notes: [],
    checklist: [],
    generatedAt: new Date().toISOString(),
  };
  try {
    const stateResp = await handleState(env);
    state = await stateResp.json();
  } catch (e) {
    state.apiError = e.message;
  }

  const authHint = isLocalDev
    ? `<div class="hint warn">⚠️ Kein Workspace-User-Header erkannt. Lokale Ansicht – Schreibfunktionen deaktiviert.</div>`
    : '';
  const configHint = !env.CONTENT_API_URL
    ? `<div class="hint warn">⚙️ <code>CONTENT_API_URL</code> ist nicht konfiguriert. Content Inventory nicht verfügbar.</div>`
    : '';
  const apiErrorHint = state.apiError
    ? `<div class="hint warn">⚠️ Content API: ${esc(state.apiError)}</div>`
    : '';

  const inventoryRows = state.inventory.length > 0
    ? state.inventory.map(item => `
        <tr>
          <td>${esc(item.title || item.id || '–')}</td>
          <td>${esc(item.type || '–')}</td>
          <td>${esc(item.risk || '–')}</td>
          <td>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">Link</a>` : '–'}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="empty">Kein Inventory verfügbar.</td></tr>`;

  const notesHtml = state.notes.length > 0
    ? state.notes.map(n => `
        <div class="note">
          <span class="note-meta">${esc((n.created_at || '').substring(0, 16).replace('T', ' '))}${n.author_key ? ' · ' + esc(n.author_key) : ''}</span>
          <p>${esc(n.body)}</p>
        </div>`).join('')
    : '<p class="empty">Noch keine Notizen.</p>';

  const noteForm = !isLocalDev ? `
    <div class="note-form">
      <textarea id="note-text" rows="2" maxlength="2000" placeholder="Neue Notiz …"></textarea>
      <button onclick="submitNote()">Speichern</button>
    </div>` : '';

  const checklistHtml = state.checklist.map(item => `
    <label class="check-item">
      <input type="checkbox" data-id="${esc(String(item.id))}"${item.done ? ' checked' : ''}${isLocalDev ? ' disabled' : ''}>
      ${esc(item.label)}
    </label>`).join('');

  return new Response(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KI-tomat Admin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    main { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 16px; }
    h2 { font-size: 17px; margin: 28px 0 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); padding-bottom: 6px; }
    .cards { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
    .card { flex: 1; min-width: 130px; padding: 14px 16px; border-radius: 8px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
    .card-label { font-size: 11px; opacity: .55; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }
    .card-value { font-size: 20px; font-weight: 600; }
    .hint { padding: 10px 14px; border-radius: 6px; margin-bottom: 10px; font-size: 14px; }
    .hint.warn { background: color-mix(in srgb, orange 12%, Canvas); border-left: 3px solid orange; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); }
    th { font-size: 12px; opacity: .55; font-weight: 600; text-transform: uppercase; }
    .empty { opacity: .45; font-style: italic; }
    .note { margin-bottom: 10px; padding: 10px 14px; border-radius: 6px; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .note-meta { font-size: 12px; opacity: .45; }
    .note p { margin: 4px 0 0; font-size: 14px; line-height: 1.5; }
    .note-form { display: flex; gap: 8px; margin-top: 12px; }
    .note-form textarea { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); background: Canvas; color: CanvasText; resize: vertical; font-family: inherit; font-size: 14px; }
    button { padding: 8px 18px; border-radius: 6px; border: none; background: #e63329; color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
    .check-item { display: block; margin-bottom: 9px; font-size: 14px; cursor: pointer; }
    .check-item input { margin-right: 8px; }
    code { padding: 2px 5px; border-radius: 4px; background: color-mix(in srgb, CanvasText 10%, Canvas); font-size: 12px; }
    a { color: inherit; }
    .meta { font-size: 11px; opacity: .35; margin-top: 36px; }
  </style>
</head>
<body>
<main>
  <h1>KI-tomat Admin</h1>
  ${authHint}${configHint}${apiErrorHint}

  <h2>Status</h2>
  <div class="cards">
    <div class="card">
      <div class="card-label">Content API</div>
      <div class="card-value" style="font-size:14px;padding-top:3px">${esc(state.apiStatus)}</div>
    </div>
    <div class="card">
      <div class="card-label">Artefakte</div>
      <div class="card-value">${state.artifactCount}</div>
    </div>
    <div class="card">
      <div class="card-label">Stand</div>
      <div class="card-value" style="font-size:12px;padding-top:5px">${esc((state.generatedAt || '').substring(0, 16).replace('T', ' '))}</div>
    </div>
  </div>

  <h2>Content Inventory</h2>
  <table>
    <thead><tr><th>Titel</th><th>Typ</th><th>Risiko</th><th>Link</th></tr></thead>
    <tbody>${inventoryRows}</tbody>
  </table>

  <h2>Team-Notizen</h2>
  ${notesHtml}
  ${noteForm}

  <h2>Release-Checkliste</h2>
  <div id="checklist">${checklistHtml}</div>

  <p class="meta">AP11 Internal Admin Site · ${esc(state.generatedAt || '')}</p>
</main>
<script>
  async function submitNote() {
    const ta = document.getElementById('note-text');
    const text = ta.value.trim();
    if (!text) return;
    const r = await fetch('/api/admin/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (r.ok) { ta.value = ''; location.reload(); }
    else { alert('Fehler beim Speichern der Notiz.'); }
  }

  document.querySelectorAll('#checklist input[type=checkbox]').forEach(function(cb) {
    cb.addEventListener('change', function() {
      fetch('/api/admin/checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cb.dataset.id, checked: cb.checked }),
      });
    });
  });
</script>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---- JSON-Response Hilfsfunktion ----
function jsonResp(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
