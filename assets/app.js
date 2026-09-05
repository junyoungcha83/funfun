// Fun fun — 카테고리별 링크 모음. 서버(KV) 동기화 + localStorage 캐시. 등록/삭제는 편집 토큰.
const API_BASE   = 'https://funfun-api.junyoung-cha83.workers.dev';
const STORAGE_KEY = 'funfun-state-v1';
const TOKEN_KEY   = 'funfun-edit-token';
const SAVE_DEBOUNCE_MS = 800;

// 목록(탭)은 이제 데이터에 들어 있어 앱에서 직접 만들고 지울 수 있다.
// 아래는 처음 쓰는 사람에게 깔리는 기본값일 뿐이다.
const DEFAULT_CATS = [
  { id: 'money',  label: '경제' },
  { id: 'estate', label: '부동산' },
  { id: 'make',   label: '만들기' },
  { id: 'cook',   label: '요리' },
  { id: 'trivia', label: '정보' },
  { id: 'edu',    label: '교육' },
  { id: 'travel', label: '여행' },
  { id: 'ai',     label: 'AI' },
  { id: 'memo',   label: '나의메모', kind: 'note' },   // 링크가 아닌 제목/내용 텍스트 메모
];
const NOTE_CAT = 'memo';

let state = { version: 1, cats: DEFAULT_CATS.map(c => ({ ...c })), items: [] };

const cats = () => state.cats;
const catById = id => state.cats.find(c => c.id === id);
const catLabel = id => { const c = catById(id); return c ? c.label : ''; };
const linkCats = () => state.cats.filter(c => c.kind !== 'note');   // 이동/복사 대상은 링크 탭만
const firstCatId = () => (state.cats[0] || {}).id || NOTE_CAT;
// 링크를 담을 수 있는 첫 목록 — 등록 폼의 기본 선택
const fallbackLinkCat = () => (linkCats()[0] || {}).id || '';
let activeCat = '';        // 첫 렌더에서 첫 목록으로 정해진다
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

// 저장된 목록을 정리한다. 예전 데이터에는 cats 가 없으므로 기본값을 깔고,
// 메모 탭은 성격이 달라 없으면 되살린다(지워지면 메모를 볼 길이 없어진다).
function migrateCats(loaded){
  const raw = (loaded && Array.isArray(loaded.cats)) ? loaded.cats : DEFAULT_CATS;
  const seen = new Set(), out = [];
  for (const c of raw) {
    const id = String((c && c.id) || '').trim();
    const label = String((c && c.label) || '').trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const o = { id, label };
    if (c.kind === 'note' || id === NOTE_CAT) o.kind = 'note';
    out.push(o);
  }
  if (!out.length) return DEFAULT_CATS.map(c => ({ ...c }));
  if (!out.some(c => c.id === NOTE_CAT)) out.push({ id: NOTE_CAT, label: '나의메모', kind: 'note' });
  return out;
}

function migrate(loaded){
  const cats = migrateCats(loaded);
  const known = new Set(cats.map(c => c.id));
  const linkFallback = (cats.find(c => c.kind !== 'note') || cats[0]).id;
  const items = (loaded && Array.isArray(loaded.items) ? loaded.items : []).map(it => {
    // 텍스트 메모 — URL 없이 제목/내용만 가짐
    if (it.type === 'note' || it.category === NOTE_CAT) {
      return {
        id: it.id || genId(),
        type: 'note',
        category: NOTE_CAT,
        title: String(it.title || ''),
        body: String(it.body || ''),
        added_at: it.added_at || nowIso(),
        updated_at: it.updated_at || it.added_at || nowIso(),
      };
    }
    return {
      id: it.id || genId(),
      // 목록이 지워졌으면 링크가 사라지지 않게 첫 링크 목록으로 옮긴다
      category: known.has(it.category) ? it.category : linkFallback,
      url: String(it.url || ''),
      title: String(it.title || ''),
      image: String(it.image || ''),
      domain: String(it.domain || domainOf(it.url || '')),
      note: String(it.note || ''),
      added_at: it.added_at || nowIso(),
    };
  }).filter(it => (it.type === 'note' ? (it.title || it.body) : it.url));
  return { version: 1, cats, items };
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
  return migrate(null);      // 처음이면 기본 목록이 깔린다
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
  renderTabs();        // ＋(목록 관리) 는 편집 중일 때만 보인다
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

// ── 목록(탭) ─────────────────────────────────────
// 탭은 데이터에서 그린다. 편집 비밀번호가 들어가 있을 때만 끝에 ＋ 가 붙는다.
function renderTabs(){
  const nav = document.getElementById('tabs');
  if (!nav) return;
  if (!catById(activeCat)) activeCat = firstCatId();     // 보던 목록이 지워졌을 때
  const tabs = cats().map(c => {
    const on = c.id === activeCat;
    return `<button class="tab${on ? ' active' : ''}" role="tab" data-cat="${escapeAttr(c.id)}"
             aria-selected="${on ? 'true' : 'false'}">${escapeHtml(c.label)}</button>`;
  }).join('');
  const manage = getEditToken()
    ? `<button class="tab tab-manage" id="tabManage" type="button" title="목록 만들기·이름변경·삭제"
        aria-label="목록 관리">＋</button>` : '';
  nav.innerHTML = tabs + manage;
  nav.querySelectorAll('.tab[data-cat]').forEach(b => {
    b.onclick = () => { activeCat = b.dataset.cat; render(); };
  });
  const m = document.getElementById('tabManage');
  if (m) m.onclick = openCatDialog;
}

// 등록 폼의 분류 선택 — 링크 목록만 넣는다(메모 탭은 성격이 다르다)
function fillCategorySelect(){
  const sel = document.getElementById('fCategory');
  if (!sel) return;
  sel.innerHTML = linkCats()
    .map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label)}</option>`).join('');
}

// ── 렌더 ─────────────────────────────────────────
function render(){
  renderTabs();
  const box = document.getElementById('cards');
  const isNoteTab = activeCat === NOTE_CAT;
  box.classList.toggle('notes', isNoteTab);
  document.getElementById('btnAdd').setAttribute('aria-label', isNoteTab ? '메모 등록' : '링크 등록');

  const items = state.items
    .filter(it => it.category === activeCat)
    .sort((a, b) => String(b.updated_at || b.added_at).localeCompare(String(a.updated_at || a.added_at)));

  if (!items.length) {
    const what = isNoteTab ? '메모' : '링크';
    const hint = getEditToken()
      ? `<br/><small>아래 ＋ 로 ${isNoteTab ? '메모를' : 'URL을'} 등록하세요.</small>`
      : '<br/><small>🔒 로 편집 비밀번호를 입력하면 등록할 수 있어요.</small>';
    box.innerHTML = `<div class="empty">아직 등록된 ${what}가 없어요.${hint}</div>`;
    return;
  }

  if (isNoteTab) { renderNotes(box, items); return; }

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

// ── 나의메모 (텍스트) ────────────────────────────
function fmtDate(iso){
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
  } catch { return ''; }
}

function renderNotes(box, items){
  box.innerHTML = items.map(it => `
    <article class="card note-card" data-id="${escapeAttr(it.id)}">
      <button class="note-open" type="button" data-id="${escapeAttr(it.id)}">
        <div class="note-title">${escapeHtml(it.title || '(제목 없음)')}</div>
        <div class="note-body">${escapeHtml(it.body || '')}</div>
        <div class="note-date">${escapeHtml(fmtDate(it.updated_at || it.added_at))}</div>
      </button>
      <button class="card-del" type="button" data-id="${escapeAttr(it.id)}" aria-label="삭제">×</button>
    </article>`).join('');

  box.querySelectorAll('.card-del').forEach(btn => { btn.onclick = () => deleteItem(btn.dataset.id); });
  box.querySelectorAll('.note-open').forEach(btn => { btn.onclick = () => openMemoView(btn.dataset.id); });
}

let memoEditId = null;   // null = 새 메모
function openMemoDialog(id){
  if (!getEditToken()) {
    if (confirm('편집 비밀번호가 필요합니다. 지금 입력할까요?')) promptEditToken();
    if (!getEditToken()) return;
  }
  const it = id ? state.items.find(x => x.id === id) : null;
  memoEditId = it ? it.id : null;
  document.getElementById('memoTitle').textContent = it ? '메모 수정' : '메모 등록';
  document.getElementById('mTitle').value = it ? (it.title || '') : '';
  document.getElementById('mBody').value  = it ? (it.body  || '') : '';
  document.getElementById('memoStatus').textContent = '';
  document.getElementById('memoDialog').showModal();
  setTimeout(() => document.getElementById('mTitle').focus(), 50);
}

function saveMemo(){
  const title = document.getElementById('mTitle').value.trim().slice(0, 120);
  const body  = document.getElementById('mBody').value.trim();
  if (!title && !body) { document.getElementById('memoStatus').textContent = '제목이나 내용을 입력하세요.'; return; }

  if (memoEditId) {
    const it = state.items.find(x => x.id === memoEditId);
    if (it) { it.title = title; it.body = body; it.updated_at = nowIso(); }
  } else {
    state.items.push({
      id: genId(), type: 'note', category: NOTE_CAT,
      title, body, added_at: nowIso(), updated_at: nowIso(),
    });
  }
  memoEditId = null;
  saveLocalAndSync();
  activeCat = NOTE_CAT;
  render();
  document.getElementById('memoDialog').close();
}

let memoViewId = null;
function openMemoView(id){
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  memoViewId = id;
  document.getElementById('memoViewTitle').textContent = it.title || '(제목 없음)';
  document.getElementById('memoViewDate').textContent = fmtDate(it.updated_at || it.added_at);
  document.getElementById('memoViewBody').textContent = it.body || '';
  document.getElementById('memoViewEdit').style.display = getEditToken() ? '' : 'none';
  document.getElementById('memoViewDialog').showModal();
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

let moveItemId = null;
function openMoveSheet(id){
  const it = state.items.find(x => x.id === id);
  if (!it) return;
  moveItemId = id;
  document.getElementById('moveTitle').textContent = it.title || it.url;
  const lc = document.getElementById('moveLinkCopy');
  lc.textContent = '📋 링크 주소 복사'; lc.disabled = false;
  renderMoveCats();
  document.getElementById('moveDialog').showModal();
}
function catButtonsHtml(it, mode){
  return linkCats().map(c => {
    const isCur = it.category === c.id;
    const disabled = mode === 'move' && isCur;   // 같은 탭으로 이동은 막음(복사는 허용)
    return `<button type="button" class="move-cat${isCur ? ' current' : ''}" data-cat="${c.id}"${disabled ? ' disabled' : ''}>${escapeHtml(c.label)}${isCur ? ' (현재)' : ''}</button>`;
  }).join('');
}
function renderMoveCats(){
  const it = state.items.find(x => x.id === moveItemId);
  if (!it) return;
  const mv = document.getElementById('moveCatsMove');
  const cp = document.getElementById('moveCatsCopy');
  mv.innerHTML = catButtonsHtml(it, 'move');
  cp.innerHTML = catButtonsHtml(it, 'copy');
  mv.querySelectorAll('.move-cat').forEach(b => { b.onclick = () => doMove(b.dataset.cat); });
  cp.querySelectorAll('.move-cat').forEach(b => { b.onclick = () => doCopy(b.dataset.cat); });
}
function doMove(cat){
  const it = state.items.find(x => x.id === moveItemId);
  if (!it) return;
  it.category = cat;
  saveLocalAndSync(); activeCat = cat; render();
  document.getElementById('moveDialog').close();
}
function doCopy(cat){
  const it = state.items.find(x => x.id === moveItemId);
  if (!it) return;
  state.items.push({ ...it, id: genId(), category: cat, added_at: nowIso() });
  saveLocalAndSync(); activeCat = cat; render();
  document.getElementById('moveDialog').close();
}
async function copyLink(){
  const it = state.items.find(x => x.id === moveItemId);
  if (!it) return;
  let ok = false;
  try { await navigator.clipboard.writeText(it.url); ok = true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = it.url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
    } catch {}
  }
  const lc = document.getElementById('moveLinkCopy');
  lc.textContent = ok ? '복사됨 ✓' : '복사 실패';
  lc.disabled = true;
  setTimeout(() => document.getElementById('moveDialog').close(), 800);
}

// X(트위터) 글 주소에서 글 번호를 뽑는다. x.com·twitter.com 둘 다 쓴다.
//   https://x.com/누구/status/1234567890  ·  .../statuses/123  ·  뒤에 ?s=20 같은 게 붙기도 한다
function xTweetId(u){
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '').replace(/^mobile\./, '');
    if (h !== 'x.com' && h !== 'twitter.com') return '';
    const m = url.pathname.match(/\/status(?:es)?\/(\d+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

// 임베드 가능한 iframe src 로 변환 (YouTube·X·Facebook 등은 전용 임베드 사용)
function embedSrc(url){
  const vid = ytId(url);
  if (vid) return `https://www.youtube.com/embed/${vid}?autoplay=1&rel=0&playsinline=1`;
  // x.com 은 x-frame-options: SAMEORIGIN 이라 주소를 그대로 넣으면 흰 화면만 뜬다.
  // 공식 임베드(platform.twitter.com)는 프레임 제한이 없어 영상까지 재생된다.
  const tw = xTweetId(url);
  if (tw) return `https://platform.twitter.com/embed/Tweet.html?id=${tw}&theme=light&lang=ko&dnt=true`;
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
    // X 는 글 하나(status)만 임베드된다. 프로필·홈·검색 주소는 통째로 막혀 있다.
    const hx = h.replace(/^mobile\./, '');
    if ((hx === 'x.com' || hx === 'twitter.com') && !xTweetId(url)) return 'x';
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
    const name = svc === 'facebook' ? '페이스북' : svc === 'instagram' ? '인스타그램'
               : svc === 'tiktok' ? '틱톡' : svc === 'x' ? 'X' : '원본 서비스';
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
  if (!confirm(it.type === 'note' ? '이 메모를 삭제할까요?' : '이 링크를 삭제할까요?')) return;
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
  fillCategorySelect();          // 목록이 바뀌었을 수 있으니 열 때마다 다시 채운다
  const sel = document.getElementById('fCategory');
  sel.value = (activeCat === NOTE_CAT) ? fallbackLinkCat() : activeCat;
  if (!sel.value) sel.value = fallbackLinkCat();
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

// ── 목록 관리 ────────────────────────────────────
// id 는 사람이 볼 일이 없으므로 겹치지 않기만 하면 된다.
function genCatId(){ return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function countIn(catId){ return state.items.filter(it => it.category === catId).length; }

function renderCatList(){
  const box = document.getElementById('catList');
  if (!box) return;
  const list = cats();
  box.innerHTML = list.map((c, i) => {
    const n = countIn(c.id);
    const isNote = c.kind === 'note';
    // 안에 든 게 있으면 못 지운다 — 지우는 순간 그 항목들이 갈 곳이 없어진다
    const why = isNote ? '메모 탭은 지울 수 없어요' : n ? `${n}개가 들어 있어 못 지워요` : '';
    return `<li class="cat-row">
      <span class="cat-move">
        <button type="button" class="cat-arrow" data-up="${escapeAttr(c.id)}"
          ${i === 0 ? 'disabled' : ''} title="위로" aria-label="${escapeAttr(c.label)} 위로">▲</button>
        <button type="button" class="cat-arrow" data-down="${escapeAttr(c.id)}"
          ${i === list.length - 1 ? 'disabled' : ''} title="아래로" aria-label="${escapeAttr(c.label)} 아래로">▼</button>
      </span>
      <span class="cat-name">${escapeHtml(c.label)}</span>
      <span class="cat-count">${isNote ? '메모' : `${n}개`}</span>
      <button type="button" class="cat-btn" data-ren="${escapeAttr(c.id)}">이름</button>
      <button type="button" class="cat-btn danger" data-del="${escapeAttr(c.id)}"
        ${why ? `disabled title="${escapeAttr(why)}"` : ''}>삭제</button>
    </li>`;
  }).join('');
  box.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => renameCat(b.dataset.ren));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => deleteCat(b.dataset.del));
  box.querySelectorAll('[data-up]').forEach(b => b.onclick = () => moveCat(b.dataset.up, -1));
  box.querySelectorAll('[data-down]').forEach(b => b.onclick = () => moveCat(b.dataset.down, 1));
}

function openCatDialog(){
  document.getElementById('catNew').value = '';
  renderCatList();
  document.getElementById('catDialog').showModal();
}

function addCat(){
  const input = document.getElementById('catNew');
  const label = input.value.trim();
  if (!label) { input.focus(); return; }
  if (cats().some(c => c.label === label)) { alert('같은 이름의 목록이 이미 있어요.'); input.focus(); return; }
  state.cats.push({ id: genCatId(), label });
  saveLocalAndSync();
  input.value = '';
  renderCatList(); render();
}

// 목록 순서 바꾸기 — 이웃과 자리만 맞바꾼다. 탭 순서가 곧 이 순서다.
function moveCat(id, dir){
  const i = state.cats.findIndex(c => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.cats.length) return;
  const a = state.cats;
  [a[i], a[j]] = [a[j], a[i]];
  saveLocalAndSync();
  renderCatList(); render();
}

function renameCat(id){
  const c = catById(id); if (!c) return;
  const v = prompt('목록 이름', c.label);
  if (v === null) return;
  const label = v.trim();
  if (!label) return;
  if (cats().some(x => x.id !== id && x.label === label)) { alert('같은 이름의 목록이 이미 있어요.'); return; }
  c.label = label;
  saveLocalAndSync();
  renderCatList(); render();
}

function deleteCat(id){
  const c = catById(id); if (!c || c.kind === 'note') return;
  if (countIn(id)) { alert('안에 든 항목을 먼저 옮기거나 지워 주세요.'); return; }
  if (!confirm(`'${c.label}' 목록을 지울까요?`)) return;
  state.cats = state.cats.filter(x => x.id !== id);
  if (activeCat === id) activeCat = firstCatId();
  saveLocalAndSync();
  renderCatList(); render();
}

// ── 부팅 ─────────────────────────────────────────
(async function init(){
  updateEditUI();
  state = await loadInitial();
  cacheLocal();
  render();

  document.getElementById('btnEdit').onclick = promptEditToken;
  document.getElementById('btnDeleteMode').onclick = toggleDeleteMode;
  document.getElementById('btnAdd').onclick = () =>
    (activeCat === NOTE_CAT ? openMemoDialog(null) : openAddDialog());
  document.getElementById('catAdd').onclick = addCat;
  document.getElementById('catClose').onclick = () => document.getElementById('catDialog').close();
  document.getElementById('catNew').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCat(); }
  });
  document.getElementById('moveCancel').onclick = () => document.getElementById('moveDialog').close();
  document.getElementById('moveLinkCopy').onclick = copyLink;
  document.getElementById('addCancel').onclick = () => document.getElementById('addDialog').close();
  document.getElementById('addSave').onclick = saveAdd;
  document.getElementById('memoCancel').onclick = () => document.getElementById('memoDialog').close();
  document.getElementById('memoSave').onclick = saveMemo;
  document.getElementById('memoViewClose').onclick = () => document.getElementById('memoViewDialog').close();
  document.getElementById('memoViewEdit').onclick = () => {
    document.getElementById('memoViewDialog').close();
    openMemoDialog(memoViewId);
  };
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
    for (const id of ['memoViewDialog', 'memoDialog', 'addDialog']) {
      const d = document.getElementById(id);
      if (d && d.open) { d.close(); return; }
    }
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
