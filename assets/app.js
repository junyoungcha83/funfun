// Fun fun — 카테고리별 링크 모음. 서버(KV) 동기화 + localStorage 캐시. 등록/삭제는 편집 토큰.
const API_BASE   = 'https://funfun-api.junyoung-cha83.workers.dev';
const STORAGE_KEY = 'funfun-state-v1';
const TOKEN_KEY   = 'funfun-edit-token';
const SAVE_DEBOUNCE_MS = 800;

const CATS = [
  { id: 'make',   label: '만들기' },
  { id: 'cook',   label: '요리' },
  { id: 'trivia', label: '정보' },
  { id: 'money',  label: '재테크' },
  { id: 'etc',    label: '기타' },
];
const CAT_LABEL = Object.fromEntries(CATS.map(c => [c.id, c.label]));

let state = { version: 1, items: [] };
let activeCat = 'make';
let lastPreview = null;     // { url, meta }
let _saveTimer = null, _saveCtrl = null, _previewTimer = null;

// ── 유틸 ─────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s){ return escapeHtml(s); }
function nowIso(){ return new Date().toISOString(); }
function genId(){ return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function getEditToken(){ try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }

function normalizeUrl(raw){
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return ''; }
}
function domainOf(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } }

function ytId(u){
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./,'');
    if (h === 'youtu.be') return url.pathname.slice(1).split('/')[0] || '';
    if (h.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}

// ── 영속화 / 동기화 ──────────────────────────────
function setSyncStatus(s){
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = { saving:'저장중…', saved:'저장됨 ✓', error:'오프라인', readonly:'읽기전용', '': '' };
  el.textContent = map[s] ?? '';
  el.className = 'sync-status ' + (s || '');
}

function migrate(loaded){
  const items = (loaded && Array.isArray(loaded.items) ? loaded.items : []).map(it => ({
    id: it.id || genId(),
    category: CAT_LABEL[it.category] ? it.category : 'etc',
    url: String(it.url || ''),
    title: String(it.title || ''),
    image: String(it.image || ''),
    domain: String(it.domain || domainOf(it.url || '')),
    note: String(it.note || ''),
    added_at: it.added_at || nowIso(),
  })).filter(it => it.url);
  return { version: 1, items };
}

function cacheLocal(){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }

async function fetchFromServer(){
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    if (j && Array.isArray(j.items)) return j;
  } catch {}
  return null;
}

async function loadInitial(){
  const remote = await fetchFromServer();
  if (remote) return migrate(remote);
  try { const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (local) return migrate(local); } catch {}
  return { version: 1, items: [] };
}

function saveLocalAndSync(){
  cacheLocal();
  const token = getEditToken();
  if (!token) { setSyncStatus('readonly'); return; }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
}

async function pushToServer(){
  const token = getEditToken();
  if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state),
      signal: _saveCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) {
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      updateEditUI();
      setSyncStatus('error');
      alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.');
    } else setSyncStatus('error');
  } catch (e) { if (e.name !== 'AbortError') setSyncStatus('error'); }
}

// ── 편집 토큰 ────────────────────────────────────
function promptEditToken(){
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (지우고 확인 시 잠금)' : '편집 비밀번호를 입력하세요', cur);
  if (v === null) return;
  try {
    if (v.trim()) localStorage.setItem(TOKEN_KEY, v.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
  updateEditUI();
}
function updateEditUI(){
  const editable = !!getEditToken();
  document.body.classList.toggle('read-only', !editable);
  document.getElementById('btnEdit').textContent = editable ? '🔓' : '🔒';
  setSyncStatus(editable ? '' : 'readonly');
  if (!editable) { deleteMode = false; document.body.classList.remove('delete-mode'); }
  updateDeleteBtn();
}

// 삭제 모드 — 평소엔 카드 × 가 숨겨져 있고, 이 버튼을 켰을 때만 삭제 가능(실수 방지)
let deleteMode = false;
function toggleDeleteMode(){
  if (!getEditToken()) return;
  deleteMode = !deleteMode;
  document.body.classList.toggle('delete-mode', deleteMode);
  updateDeleteBtn();
}
function updateDeleteBtn(){
  const b = document.getElementById('btnDeleteMode');
  if (!b) return;
  b.classList.toggle('active', deleteMode);
  b.title = deleteMode ? '삭제 모드 끄기' : '삭제 모드';
}

// ── 렌더 ─────────────────────────────────────────
function render(){
  document.querySelectorAll('#tabs .tab').forEach(b => {
    const on = b.dataset.cat === activeCat;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const box = document.getElementById('cards');
  const items = state.items
    .filter(it => it.category === activeCat)
    .sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));

  if (!items.length) {
    box.innerHTML = `<div class="empty">아직 등록된 링크가 없어요.${getEditToken() ? '<br/><small>아래 ＋ 로 URL을 등록하세요.</small>' : '<br/><small>🔒 로 편집 비밀번호를 입력하면 등록할 수 있어요.</small>'}</div>`;
    return;
  }
  box.innerHTML = items.map(it => {
    const img = it.image
      ? `<img class="thumb" src="${escapeAttr(it.image)}" alt="" loading="lazy"
            onerror="this.classList.add('broken')" />`
      : `<div class="thumb placeholder">${escapeHtml(it.domain || 'link')}</div>`;
    return `
      <article class="card" data-id="${escapeAttr(it.id)}">
        <a class="card-link" href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer">
          ${it.note ? `<div class="card-note-top">${escapeHtml(it.note)}</div>` : ''}
          <div class="thumb-wrap">${img}</div>
          <div class="card-body">
            <div class="card-title">${escapeHtml(it.title || it.url)}</div>
            <div class="card-domain">${escapeHtml(it.domain || '')}</div>
          </div>
        </a>
        <button class="card-del" type="button" data-id="${escapeAttr(it.id)}" aria-label="삭제">×</button>
      </article>`;
  }).join('');

  box.querySelectorAll('.card-del').forEach(btn => {
    btn.onclick = () => deleteItem(btn.dataset.id);
  });
  // 카드: 탭 → 뷰어 / 길게 누르기 → 이동·복사 시트(편집 토큰 있을 때)
  box.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    const a = card.querySelector('.card-link');
    attachLongPress(card, id);
    if (a) a.addEventListener('click', (e) => {
      if (_lpFired) { e.preventDefault(); _lpFired = false; return; }   // 길게 누른 직후 클릭 무시
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();
      openViewer(a.getAttribute('href'));
    });
  });
}

// ── 길게 누르기 → 이동/복사 ──────────────────────
let _lpTimer = null, _lpFired = false, _lpStart = null;
function attachLongPress(el, id){
  const cancel = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
  el.addEventListener('touchstart', (e) => {
    _lpFired = false;
    const t = e.touches[0]; _lpStart = { x: t.clientX, y: t.clientY };
    cancel();
    _lpTimer = setTimeout(() => { if (getEditToken()) { _lpFired = true; openMoveSheet(id); } }, 480);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (_lpStart && (Math.abs(t.clientX - _lpStart.x) > 10 || Math.abs(t.clientY - _lpStart.y) > 10)) cancel();
  }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => {   // 데스크톱 우클릭
    e.preventDefault();
    if (getEditToken()) { _lpFired = true; openMoveSheet(id); }
  });
}

let moveItemId = null, moveMode = 'move';
function openMoveSheet(id){
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  moveItemId = id; moveMode = 'move';
  document.getElementById('moveTitle').textContent = it.title || it.url;
  updateMoveModeBtns();
  renderMoveCats();
  document.getElementById('moveDialog').showModal();
}
function updateMoveModeBtns(){
  document.querySelectorAll('#moveModes .seg').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === moveMode));
}
function renderMoveCats(){
  const it = state.items.find(x => x.id === moveItemId);
  const box = document.getElementById('moveCats');
  box.innerHTML = CATS.map(c => {
    const isCur = it && it.category === c.id;
    const disabled = moveMode === 'move' && isCur;
    return `<button type="button" class="move-cat${isCur ? ' current' : ''}" data-cat="${c.id}"${disabled ? ' disabled' : ''}>${escapeHtml(c.label)}${isCur ? ' (현재)' : ''}</button>`;
  }).join('');
  box.querySelectorAll('.move-cat').forEach(b => { b.onclick = () => applyMove(b.dataset.cat); });
}
function applyMove(targetCat){
  const it = state.items.find(x => x.id === moveItemId);
  if (!it) return;
  if (moveMode === 'move') { it.category = targetCat; }
  else { state.items.push({ ...it, id: genId(), category: targetCat, added_at: nowIso() }); }
  saveLocalAndSync();
  activeCat = targetCat;            // 옮긴/복사한 탭으로 전환해 결과 확인
  render();
  document.getElementById('moveDialog').close();
}

// 임베드 가능한 iframe src 로 변환 (YouTube·Facebook 등은 전용 임베드 사용)
function embedSrc(url){
  const vid = ytId(url);
  if (vid) return `https://www.youtube.com/embed/${vid}?autoplay=1&rel=0&playsinline=1`;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const isFb = h === 'facebook.com' || h.endsWith('.facebook.com') || h === 'fb.watch' || h === 'fb.com' || h === 'm.facebook.com';
    if (isFb) {
      // facebook 페이지는 직접 iframe 불가 → 공식 플러그인으로. 동영상/릴스는 video, 그 외 post.
      const isVideo = h === 'fb.watch' || /\/(videos?|watch|reel|share\/v)\b/i.test(new URL(url).pathname) || /[?&]v=/.test(new URL(url).search);
      const plugin = isVideo ? 'video' : 'post';
      return `https://www.facebook.com/plugins/${plugin}.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=true`;
    }
  } catch {}
  return url;
}

// 임베드가 원천 불가한 링크(페이스북 릴스·공유·스토리 등) — 앱 내 재생 불가, 외부에서만.
function nonEmbeddable(url){
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    const isFb = h.endsWith('facebook.com') || h === 'fb.watch' || h === 'fb.com';
    if (isFb && /\/(reel|reels|share|stories|story)\b/i.test(u.pathname)) return 'facebook';
    if (h.endsWith('instagram.com') || h.endsWith('tiktok.com')) return h.split('.').slice(-2,-1)[0];
    return '';
  } catch { return ''; }
}

// ── 앱 내 뷰어 (뒤로가기로 닫힘) ──────────────────
function openViewer(url){
  if (!url) return;
  const frame = document.getElementById('viewerFrame');
  const fb = document.getElementById('viewerFallback');
  const svc = nonEmbeddable(url);
  if (svc) {
    // 임베드 불가 — 빈 화면 대신 안내 + 큰 열기 버튼
    frame.src = 'about:blank'; frame.classList.add('hidden');
    const name = svc === 'facebook' ? '페이스북' : svc === 'instagram' ? '인스타그램' : svc === 'tiktok' ? '틱톡' : '원본 서비스';
    document.getElementById('viewerFallbackMsg').innerHTML =
      `이 영상은 ${name} 정책상 앱 안에서 재생할 수 없어요.<br/>아래 버튼으로 ${name}에서 열면 재생됩니다.`;
    document.getElementById('viewerFallbackOpen').href = url;
    fb.classList.remove('hidden');
  } else {
    fb.classList.add('hidden'); frame.classList.remove('hidden');
    frame.src = embedSrc(url);
  }
  document.getElementById('viewerOpen').href = url;
  document.getElementById('viewerHost').textContent = domainOf(url);
  document.getElementById('viewer').classList.remove('hidden');
  document.body.classList.add('viewer-open');
  // 뒤로가기(폰/브라우저)로 뷰어가 닫히도록 히스토리 항목 push
  if (!(history.state && history.state.funfunViewer)) history.pushState({ funfunViewer: 1 }, '');
}
function closeViewer(){
  const v = document.getElementById('viewer');
  if (!v || v.classList.contains('hidden')) return;
  v.classList.add('hidden');
  const frame = document.getElementById('viewerFrame');
  frame.src = 'about:blank';   // 재생 정지
  frame.classList.remove('hidden');
  document.getElementById('viewerFallback').classList.add('hidden');
  document.body.classList.remove('viewer-open');
}
function dismissViewer(){
  // 닫기 버튼/ESC — pushState 한 항목을 되돌려(popstate) 닫음
  if (history.state && history.state.funfunViewer) history.back();
  else closeViewer();
}

function deleteItem(id){
  if (!getEditToken()) return;
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  if (!confirm('이 링크를 삭제할까요?')) return;
  state.items = state.items.filter(x => x.id !== id);
  saveLocalAndSync();
  render();
}

// ── 등록 ─────────────────────────────────────────
function openAddDialog(){
  if (!getEditToken()) {
    if (confirm('편집 비밀번호가 필요합니다. 지금 입력할까요?')) promptEditToken();
    if (!getEditToken()) return;
  }
  lastPreview = null;
  document.getElementById('fUrl').value = '';
  document.getElementById('fNote').value = '';
  document.getElementById('fCategory').value = activeCat;
  const pv = document.getElementById('preview');
  pv.className = 'preview hidden'; pv.innerHTML = '';
  document.getElementById('addStatus').textContent = '';
  document.getElementById('addDialog').showModal();
  setTimeout(() => document.getElementById('fUrl').focus(), 50);
}

async function fetchPreview(url){
  const token = getEditToken();
  const res = await fetch(`${API_BASE}/api/preview?url=${encodeURIComponent(url)}`, {
    headers: { 'X-Edit-Token': token },
  });
  if (!res.ok) throw new Error('preview_failed');
  return res.json();
}

function renderPreview(url, meta){
  const pv = document.getElementById('preview');
  const vid = ytId(url);
  const img = (meta && meta.image) || (vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : '');
  const title = (meta && meta.title) || domainOf(url) || url;
  pv.className = 'preview';
  pv.innerHTML = `
    <div class="thumb-wrap">${img
      ? `<img class="thumb" src="${escapeAttr(img)}" alt="" onerror="this.classList.add('broken')" />`
      : `<div class="thumb placeholder">${escapeHtml(domainOf(url) || 'link')}</div>`}</div>
    <div class="preview-meta">
      <div class="card-title">${escapeHtml(title)}</div>
      <div class="card-domain">${escapeHtml((meta && meta.domain) || domainOf(url))}</div>
    </div>`;
}

async function runPreview(){
  const url = normalizeUrl(document.getElementById('fUrl').value);
  const status = document.getElementById('addStatus');
  if (!url) { document.getElementById('preview').className = 'preview hidden'; lastPreview = null; return; }
  status.textContent = '미리보기 불러오는 중…';
  // YouTube 면 즉시 썸네일 먼저 표시
  renderPreview(url, null);
  try {
    const meta = await fetchPreview(url);
    lastPreview = { url, meta };
    renderPreview(url, meta);
    status.textContent = '';
  } catch {
    lastPreview = { url, meta: { title: domainOf(url), image: ytId(url) ? `https://img.youtube.com/vi/${ytId(url)}/hqdefault.jpg` : '', domain: domainOf(url) } };
    status.textContent = '미리보기를 못 가져왔어요(등록은 가능).';
  }
}

async function saveAdd(){
  const url = normalizeUrl(document.getElementById('fUrl').value);
  if (!url) { document.getElementById('addStatus').textContent = '올바른 URL을 입력하세요.'; return; }
  const category = document.getElementById('fCategory').value;
  const note = document.getElementById('fNote').value.trim().slice(0, 120);

  if (state.items.some(it => it.url === url && it.category === category)) {
    document.getElementById('addStatus').textContent = '이미 같은 분류에 등록된 링크예요.';
    return;
  }

  let meta = (lastPreview && lastPreview.url === url) ? lastPreview.meta : null;
  if (!meta) {
    document.getElementById('addStatus').textContent = '미리보기 불러오는 중…';
    try { meta = await fetchPreview(url); } catch { meta = null; }
  }
  const vid = ytId(url);
  const item = {
    id: genId(), category, url,
    title: (meta && meta.title) || domainOf(url),
    image: (meta && meta.image) || (vid ? `https://img.youtube.com/vi/${vid}/hqdefault.jpg` : ''),
    domain: (meta && meta.domain) || domainOf(url),
    note, added_at: nowIso(),
  };
  state.items.push(item);
  saveLocalAndSync();
  activeCat = category;
  render();
  document.getElementById('addDialog').close();
}

// ── 부팅 ─────────────────────────────────────────
(async function init(){
  updateEditUI();
  state = await loadInitial();
  cacheLocal();
  render();

  document.getElementById('btnEdit').onclick = promptEditToken;
  document.getElementById('btnDeleteMode').onclick = toggleDeleteMode;
  document.getElementById('btnAdd').onclick = openAddDialog;
  document.querySelectorAll('#tabs .tab').forEach(b => {
    b.onclick = () => { activeCat = b.dataset.cat; render(); };
  });
  document.getElementById('moveCancel').onclick = () => document.getElementById('moveDialog').close();
  document.querySelectorAll('#moveModes .seg').forEach(b => {
    b.onclick = () => { moveMode = b.dataset.mode; updateMoveModeBtns(); renderMoveCats(); };
  });
  document.getElementById('addCancel').onclick = () => document.getElementById('addDialog').close();
  document.getElementById('addSave').onclick = saveAdd;
  document.getElementById('fUrl').addEventListener('input', () => {
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(runPreview, 600);
  });
  document.getElementById('viewerClose').onclick = dismissViewer;
  // 폰/브라우저 뒤로가기 → 뷰어 열려있으면 닫고 앱 목록 유지
  window.addEventListener('popstate', () => {
    const v = document.getElementById('viewer');
    if (v && !v.classList.contains('hidden')) closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const v = document.getElementById('viewer');
    if (v && !v.classList.contains('hidden')) { dismissViewer(); return; }
    const d = document.getElementById('addDialog'); if (d.open) d.close();
  });

  // 다시 보일 때 서버 최신 반영 (저장 펜딩 없을 때만)
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (_saveTimer || _saveCtrl) return;
    const remote = await fetchFromServer();
    if (!remote) return;
    state = migrate(remote);
    cacheLocal();
    render();
  });
})();
