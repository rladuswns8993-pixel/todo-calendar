import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
const LOCAL_KEY = 'todo-calendar-local-v1';
const NOTE_KEY = 'todo-calendar-note-v1';
const NOTE_BACKUP = 'todo-calendar-note-backup-';   // + 사용자 id: 로그인 모드에서도 이 기기에 노트 사본을 보관
let noteBackupKey = NOTE_BACKUP + 'anon', noteSeq = 0;
const DOW = ['일','월','화','수','목','금','토'];
const MAX_TEXT = 500;

/* ── 날짜·문자 유틸 ── */
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const todayKey = () => fmt(new Date());
const md = s => { const d = parse(s); return `${d.getMonth()+1}/${d.getDate()}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $ = id => document.getElementById(id);

/* ── 상태 ── */
let tasks = [];
let sel = todayKey();
let view = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
let lastToday = todayKey();
let syncState = 'connecting';
let backend = null;
let editing = false, dirty = false, drag = null, suppressClick = false;

const SYNC_LABEL = {
  local: '이 기기에만 저장 중',
  connecting: '연결 중…',
  ok: '동기화됨',
  pending: '저장 중…',
  offline: '오프라인 · 연결되면 자동 동기화',
};

const find = id => tasks.find(t => t.id === id);
// 미완료가 먼저, 완료는 아래로 (같은 묶음 안에서는 추가한 순서대로)
const byDate = date => tasks.filter(t => t.date === date).sort((a, b) => (a.done - b.done) || (a.order - b.order));

function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ════════ 저장소 ════════ */

/* Firebase 설정 전: 이 기기 브라우저에만 저장 */
function localBackend(){
  try { const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); tasks = Array.isArray(v) ? v : []; } catch (e) { tasks = []; }
  const persist = () => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(tasks)); } catch (e) {} requestRender(); };
  syncState = 'local';
  try { applyNote(localStorage.getItem(NOTE_KEY) || ''); } catch (e) { applyNote(''); }
  return {
    saveNote(text){ try { localStorage.setItem(NOTE_KEY, text); } catch (e) {} noteSaved(); },
    add(t){ tasks.push(t); persist(); },
    update(id, patch){ const t = find(id); if (t){ Object.assign(t, patch); persist(); } },
    remove(id){ tasks = tasks.filter(x => x.id !== id); persist(); },
    clear(){ tasks = []; persist(); },
    signOut: null,
  };
}

/* Firebase 설정 후: 로그인 + 클라우드 동기화 (오프라인에서도 동작) */
async function firebaseBackend(){
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
  });
  let userId = null, unsub = null, noteUnsub = null;
  const col = () => F.collection(db, 'users', userId, 'tasks');
  const noteRef = () => F.doc(db, 'users', userId, 'meta', 'note');
  const fail = e => { console.error(e); toast('저장하지 못했어요 (' + (e.code || e.message) + ')'); };

  setupLogin(A, auth);

  A.onAuthStateChanged(auth, user => {
    if (unsub){ unsub(); unsub = null; }
    if (noteUnsub){ noteUnsub(); noteUnsub = null; }
    if (!user){ userId = null; tasks = []; applyNote('', true); showLogin(true); return; }
    userId = user.uid;
    const backupKey = NOTE_BACKUP + userId;
    const backup = () => { try { return localStorage.getItem(backupKey) || ''; } catch (e) { return ''; } };
    noteUnsub = F.onSnapshot(noteRef(), snap => {
      if (snap.exists()){
        const text = snap.data().text || '';
        applyNote(text);
        if (!snap.metadata.hasPendingWrites) try { localStorage.setItem(backupKey, text); } catch (e) {}
      } else if (backup()){
        // 서버에 노트가 없는데 이 기기에 백업이 있으면 백업을 보여주고, 서버 응답이면 올려요
        applyNote(backup());
        if (!snap.metadata.fromCache) F.setDoc(noteRef(), { text: backup(), updatedAt: Date.now() }).catch(() => {});
      } else applyNote('');
    }, e => {
      console.error(e);
      applyNote(backup());
      setNoteStatus('서버 연결 안 됨 · 이 기기에만 보관 중');
    });
    noteBackupKey = backupKey;
    syncState = 'connecting';
    showLogin(false);
    unsub = F.onSnapshot(col(), { includeMetadataChanges: true }, snap => {
      tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      syncState = !navigator.onLine ? 'offline'
        : snap.metadata.hasPendingWrites ? 'pending'
        : snap.metadata.fromCache ? 'connecting' : 'ok';
      requestRender();
    }, fail);
  });

  return {
    saveNote(text){
      // 먼저 이 기기에 백업 → 서버가 저장을 확인해야 "저장됨"
      try { localStorage.setItem(noteBackupKey, text); } catch (e) {}
      setNoteStatus('이 기기에 저장됨 · 동기화 중…');
      const seq = ++noteSeq;
      F.setDoc(noteRef(), { text, updatedAt: Date.now() })
        .then(() => { if (seq === noteSeq) noteSaved(); })
        .catch(e => {
          console.error(e);
          if (seq === noteSeq) setNoteStatus('동기화 실패 · 이 기기에만 보관 중');
          toast(e.code === 'permission-denied' ? '노트 동기화가 막혀 있어요. Firebase 보안 규칙을 게시해 주세요.' : '노트를 동기화하지 못했어요 (' + (e.code || e.message) + ')');
        });
    },
    add(t){ const { id, ...data } = t; F.setDoc(F.doc(col(), id), data).catch(fail); },
    update(id, patch){ F.updateDoc(F.doc(col(), id), patch).catch(fail); },
    remove(id){ F.deleteDoc(F.doc(col(), id)).catch(fail); },
    clear(){
      for (let i = 0; i < tasks.length; i += 400){
        const b = F.writeBatch(db);
        tasks.slice(i, i + 400).forEach(t => b.delete(F.doc(col(), t.id)));
        b.commit().catch(fail);
      }
    },
    signOut(){ A.signOut(auth); },
  };
}

/* ════════ 로그인 화면 ════════ */
const AUTH_MSG = {
  'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않아요',
  'auth/wrong-password': '이메일 또는 비밀번호가 맞지 않아요',
  'auth/user-not-found': '이메일 또는 비밀번호가 맞지 않아요',
  'auth/invalid-email': '이메일 형식이 올바르지 않아요',
  'auth/email-already-in-use': '이미 있는 계정이에요. 로그인해 주세요',
  'auth/weak-password': '비밀번호는 6자 이상이어야 해요',
  'auth/admin-restricted-operation': '새 계정 만들기가 막혀 있어요',
  'auth/operation-not-allowed': 'Firebase에서 이메일 로그인이 꺼져 있어요',
  'auth/too-many-requests': '시도가 너무 많아요. 잠시 후 다시 해 주세요',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요',
};
function setupLogin(A, auth){
  let signup = false;
  $('modeBtn').onclick = () => {
    signup = !signup;
    $('loginBtn').textContent = signup ? '계정 만들기' : '로그인';
    $('modeBtn').textContent = signup ? '이미 계정이 있어요 · 로그인' : '처음이에요 · 계정 만들기';
    $('pw').autocomplete = signup ? 'new-password' : 'current-password';
    $('loginErr').textContent = '';
  };
  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('email').value.trim(), pw = $('pw').value;
    $('loginBtn').disabled = true; $('loginErr').textContent = '';
    try {
      if (signup) await A.createUserWithEmailAndPassword(auth, email, pw);
      else await A.signInWithEmailAndPassword(auth, email, pw);
      $('pw').value = '';
    } catch (err) {
      $('loginErr').textContent = AUTH_MSG[err.code] || ('로그인하지 못했어요 (' + err.code + ')');
    } finally { $('loginBtn').disabled = false; }
  };
}
function showLogin(on){
  $('login').hidden = !on;
  $('app').hidden = on;
  if (!on) render();
}

/* ════════ 렌더 ════════ */
function requestRender(){
  if (editing || (drag && drag.on)){ dirty = true; return; }
  render();
}
function render(){ dirty = false; renderGrid(); renderSide(); }

function pillHTML(t, o = {}){
  return `<div class="pill${t.done ? ' done' : ''}${o.lg ? ' lg' : ''}" data-id="${esc(t.id)}">`
    + `<span class="cb" data-act="toggle" title="완료 체크"></span>`
    + `<span class="tx">${esc(t.text)}</span>`
    + (o.tag ? `<span class="tag">${o.tag}</span>` : '')
    + (o.actions || '') + `</div>`;
}

function renderGrid(){
  const { y, m } = view, t = todayKey();
  $('title').innerHTML = `${m+1}월<span class="yr">${y}</span>`;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const rows = Math.ceil((first.getDay() + new Date(y, m+1, 0).getDate()) / 7);
  let h = '';
  for (let i = 0; i < rows * 7; i++){
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = fmt(d), list = byDate(k);
    const cls = ['cell'];
    if (d.getMonth() !== m) cls.push('out');
    if (k === t) cls.push('today');
    if (k === sel) cls.push('sel');
    let items = list.map(x => pillHTML(x)).join('');
    if (list.length) items += `<div class="more" hidden></div>`;
    const dots = list.slice(0, 4).map(x => `<i class="${x.done ? 'd' : ''}"></i>`).join('');
    const left = list.filter(x => !x.done).length;
    h += `<div class="${cls.join(' ')}" data-date="${k}"><div class="dn"><b>${d.getDate()}</b>`
      + (left ? `<span class="left" title="${left}개 남음">${left}<small>개 남음</small></span>` : '')
      + `<button class="add" data-act="add" title="할 일 추가">+</button></div>`
      + `<div class="items">${items}</div><div class="dots">${dots}</div></div>`;
  }
  const g = $('grid');
  g.style.gridTemplateRows = `repeat(${rows}, minmax(var(--rowh), 1fr))`;
  g.innerHTML = h;
  fitCells();
}

/* 칸 높이에 들어가는 만큼만 보여주고 나머지는 "외 N개" */
function fitCells(){
  for (const cell of $('grid').children){
    const items = cell.querySelector('.items');
    if (!items || !items.firstChild) continue;
    if (!items.offsetParent) return;                 // 폰 화면(점 표시)에서는 생략
    const pills = [...items.querySelectorAll('.pill')];
    const more = items.querySelector('.more');
    pills.forEach(p => { p.hidden = false; });
    more.hidden = true;
    const limit = cell.getBoundingClientRect().bottom - 8;
    if (pills[pills.length - 1].getBoundingClientRect().bottom <= limit) continue;
    more.hidden = false; more.textContent = '외 00개';
    const need = more.getBoundingClientRect().height + 4;
    let n = 0;
    while (n < pills.length && pills[n].getBoundingClientRect().bottom + need <= limit) n++;
    pills.forEach((p, i) => { p.hidden = i >= n; });
    more.textContent = `외 ${pills.length - n}개`;
  }
}
new ResizeObserver(() => { if (!(drag && drag.on)) fitCells(); }).observe($('grid'));

function renderSide(){
  const t = todayKey(), d = parse(sel);
  const diff = Math.round((d - parse(t)) / 864e5);
  const title = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === -1 ? '어제' : `${d.getMonth()+1}월 ${d.getDate()}일`;
  const sub = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일`;
  const list = byDate(sel), done = list.filter(x => x.done).length;
  const late = tasks.filter(x => !x.done && x.date < t).sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  const del = `<button class="act x" data-act="del" title="삭제">×</button>`;

  // 입력칸(addForm)은 index.html에 고정돼 있고 다시 그리지 않아요 → 동기화 중에도 키보드·입력 내용 유지
  $('sideHead').innerHTML = `<h2>${title}</h2><div class="sub">${sub}</div>`
    + (list.length ? `<div class="prog"><span><i style="width:${Math.round(done / list.length * 100)}%"></i></span>${done} / ${list.length}</div>` : '');
  $('daySec').dataset.date = sel;
  $('dayCnt').textContent = list.length;
  $('dayList').innerHTML = list.map(x => pillHTML(x, { lg: 1, actions: del })).join('');
  $('lateCnt').textContent = late.length;
  $('lateList').innerHTML = late.length
    ? late.map(x => pillHTML(x, { lg: 1, tag: md(x.date), actions: `<button class="act" data-act="to-today" title="오늘로 옮기기">오늘로</button>` })).join('')
    : `<div class="empty">밀린 일이 없어요</div>`;
  $('sideFoot').innerHTML = `<span class="sync s-${syncState}">${SYNC_LABEL[syncState]}</span>`
    + `<span>${backend && backend.signOut ? `<button data-act="logout">로그아웃</button>` : ''}<button data-act="clear">모두 지우기</button></span>`;
}

function select(date, focusInput){
  sel = date;
  const d = parse(date);
  if (d.getFullYear() !== view.y || d.getMonth() !== view.m) view = { y: d.getFullYear(), m: d.getMonth() };
  render();
  if (focusInput) $('addInput').focus();
}
function shiftMonth(n){ const d = new Date(view.y, view.m + n, 1); view = { y: d.getFullYear(), m: d.getMonth() }; renderGrid(); }

/* ════════ 조작 ════════ */
const isTouchUI = () => matchMedia('(hover: none)').matches;

document.addEventListener('click', e => {
  if (suppressClick){ suppressClick = false; return; }
  if (!backend) return;
  const actEl = e.target.closest('[data-act]');
  const pillEl = e.target.closest('.pill[data-id]');
  const task = pillEl && find(pillEl.dataset.id);
  if (actEl){
    const a = actEl.dataset.act;
    if (a === 'toggle' && task) backend.update(task.id, { done: !task.done });
    else if (a === 'del' && task) backend.remove(task.id);
    else if (a === 'to-today' && task) backend.update(task.id, { date: todayKey(), order: Date.now() });
    else if (a === 'add') select(actEl.closest('.cell').dataset.date, true);
    else if (a === 'prev') shiftMonth(-1);
    else if (a === 'next') shiftMonth(1);
    else if (a === 'goto-today') select(todayKey());
    else if (a === 'logout'){ if (confirm('로그아웃할까요?')) backend.signOut(); }
    else if (a === 'clear'){ if (confirm('모든 할 일을 지울까요? 되돌릴 수 없어요.')) backend.clear(); }
    return;
  }
  const tx = e.target.closest('.side .pill.lg .tx');
  if (tx){ if (!tx.isContentEditable) startEdit(tx); return; }
  const cell = e.target.closest('.cell[data-date]');
  if (cell) select(cell.dataset.date);
});

/* 추가: 폼 제출 방식 → PC Enter, 아이폰·안드로이드 키보드의 완료/리턴, 동그라미 버튼 모두 동작 */
$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!backend) return;
  const inp = $('addInput');
  const v = inp.value.trim().slice(0, MAX_TEXT);
  if (!v){ inp.focus(); return; }
  inp.value = '';
  autoGrow(inp);
  backend.add({ id: uid(), text: v, date: sel, done: false, order: Date.now() });
  inp.focus();   // 동그라미를 눌러 추가해도 키보드가 닫히지 않게
});

/* 여러 줄 입력칸: 내용에 맞춰 높이 자동 조절 */
function autoGrow(el){ el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
$('addInput').addEventListener('input', e => autoGrow(e.target));

/* ── 노트: 날짜와 상관없이 항상 보이는 메모, 입력을 멈추면 자동 저장 · 굵게 지원 ── */
const noteEl = $('noteInput');
const NOTE_MAX = 20000;
let noteTimer = null, noteRange = null;
function setNoteStatus(s){ $('noteSt').textContent = s; }
function noteSaved(){ setNoteStatus('저장됨'); }

// 저장·불러오기 때 허용하는 것: 글자, 줄바꿈, 줄(div), 굵게(b) — 그 외 태그·속성은 모두 버려요
function cleanInto(src, dst){
  for (const n of src.childNodes){
    if (n.nodeType === 3){ dst.append(n.data); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (/^(SCRIPT|STYLE|TEMPLATE|TITLE|HEAD)$/.test(tag)) continue;
    if (tag === 'BR'){ dst.append(document.createElement('br')); continue; }
    let el = null;
    if (tag === 'B' || tag === 'STRONG' || (tag === 'SPAN' && /bold|[6-9]00/.test(n.style && n.style.fontWeight || ''))) el = document.createElement('b');
    else if (tag === 'DIV' || tag === 'P' || tag === 'LI') el = document.createElement('div');
    if (el){ cleanInto(n, el); dst.append(el); } else cleanInto(n, dst);
  }
}
// 저장된 노트를 화면용으로 바꿀 때 브라우저 HTML 해석기를 쓰지 않고 직접 읽어요 (허용 태그 외에는 실행·로드될 틈이 없게)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
function parseNote(html){
  const box = document.createElement('div');
  const stack = [box];
  const re = /<(\/?)([a-zA-Z]+)\b[^>]*>|[^<]+|</g;
  let m;
  while ((m = re.exec(html))){
    const top = stack[stack.length - 1];
    if (!m[2]){ top.append(m[0].replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, k) => ENT[k])); continue; }
    const tag = m[2].toLowerCase(), close = !!m[1];
    const kind = tag === 'br' ? 'br' : (tag === 'b' || tag === 'strong') ? 'b' : (tag === 'div' || tag === 'p') ? 'div' : null;
    if (!kind) continue;                                   // 그 외 태그는 버림
    if (kind === 'br'){ if (!close) top.append(document.createElement('br')); continue; }
    if (!close){ const el = document.createElement(kind); top.append(el); stack.push(el); continue; }
    for (let i = stack.length - 1; i > 0; i--){            // 닫는 태그: 짝이 맞는 곳까지 닫기
      if (stack[i].tagName.toLowerCase() === kind){ stack.length = i; break; }
    }
  }
  return box;
}
function cleanHTML(node){ const box = document.createElement('div'); cleanInto(node, box); return box; }
function escapeHTML(s){ return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function noteToHTML(text){
  if (/<(b|br|div|strong)\b/i.test(text)) return text;            // 굵게 지원 이후 저장된 노트
  return escapeHTML(text).replace(/\n/g, '<br>');                    // 예전 일반 글 노트
}
function serializeNote(){
  if (!noteEl.textContent.trim()) return '';
  return cleanHTML(noteEl).innerHTML;
}
function applyNote(text, force){
  // 내가 쓰는 중일 때는 다른 기기 내용으로 덮어쓰지 않아요
  if (!force && (document.activeElement === noteEl || noteTimer)) return;
  const box = parseNote(noteToHTML(text || ''));
  if (noteEl.innerHTML !== box.innerHTML) noteEl.replaceChildren(...box.childNodes);
}
function flushNote(){
  if (!noteTimer) return;
  clearTimeout(noteTimer); noteTimer = null;
  const html = serializeNote();
  if (html.length > NOTE_MAX){ setNoteStatus('노트가 너무 길어 저장하지 못했어요'); return; }
  if (backend) backend.saveNote(html);
}
noteEl.addEventListener('input', () => {
  // 다 지웠을 때 남는 빈 줄바꿈을 치워서 안내 문구가 다시 보이게
  if (!noteEl.textContent && noteEl.querySelectorAll('br').length <= 1 && !noteEl.querySelector('div')) noteEl.replaceChildren();
  setNoteStatus('입력 중…');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 700);
});
// 붙여넣기·끌어넣기는 글자만 (다른 곳의 서식·이미지는 안 들어와요)
noteEl.addEventListener('paste', e => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
noteEl.addEventListener('drop', e => e.preventDefault());
noteEl.addEventListener('blur', flushNote);
addEventListener('pagehide', flushNote);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNote(); });

// 굵게 버튼 (PC는 Ctrl+B / ⌘+B 도 돼요)
const boldBtn = $('noteBold');
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  const inNote = s.rangeCount && noteEl.contains(s.anchorNode);
  if (inNote) noteRange = s.getRangeAt(0).cloneRange();
  boldBtn.classList.toggle('on', !!inNote && document.queryCommandState('bold'));
});
boldBtn.addEventListener('pointerdown', e => e.preventDefault());   // 버튼을 눌러도 글 선택이 풀리지 않게
boldBtn.addEventListener('mousedown', e => e.preventDefault());
boldBtn.addEventListener('click', () => {
  const s = getSelection();
  if (!(s.rangeCount && noteEl.contains(s.anchorNode))){
    noteEl.focus();
    s.removeAllRanges();
    if (noteRange && noteEl.contains(noteRange.startContainer)) s.addRange(noteRange);
    else { const r = document.createRange(); r.selectNodeContents(noteEl); r.collapse(false); s.addRange(r); }
  }
  document.execCommand('bold');
  boldBtn.classList.toggle('on', document.queryCommandState('bold'));
});

/* 줄바꿈 넣기 (Alt+Enter용) */
function insertNewline(el){
  if (el.isContentEditable){ document.execCommand('insertText', false, '\n'); return; }
  el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/* Enter 처리: PC는 Enter=완료, Shift/Alt+Enter=줄바꿈 · 폰은 리턴=줄바꿈 (등록은 동그라미 버튼) */
function enterAction(e){
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return 'none';
  if (e.altKey){ e.preventDefault(); insertNewline(e.target); return 'none'; }
  if (e.shiftKey || isTouchUI()) return 'none';
  e.preventDefault();
  return 'submit';
}

document.addEventListener('keydown', e => {
  if (!backend) return;
  if (e.target.id === 'addInput'){
    if (enterAction(e) === 'submit') $('addForm').requestSubmit();
    else if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName) || $('app').hidden) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  else if (e.key === 'ArrowRight') shiftMonth(1);
  else if (e.key === 't' || e.key === 'T') select(todayKey());
  else if (e.key === 'n' || e.key === 'N'){ e.preventDefault(); $('addInput').focus(); }
});

/* 수정: 사이드바의 할 일 글자를 누르면 바로 수정 (끝내기: Enter 또는 다른 곳 클릭, 취소: Esc) */
function startEdit(tx){
  const task = find(tx.closest('.pill').dataset.id);
  if (!task) return;
  editing = true;
  try { tx.contentEditable = 'plaintext-only'; } catch (err) { tx.contentEditable = 'true'; }
  if (!tx.isContentEditable) tx.contentEditable = 'true';
  tx.spellcheck = false;
  tx.focus();
  const r = document.createRange(); r.selectNodeContents(tx); r.collapse(false);   // 커서를 글 끝에
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  let cancelled = false, finished = false;
  tx.onkeydown = ev => {
    if (enterAction(ev) === 'submit') tx.blur();
    else if (ev.key === 'Escape'){ cancelled = true; tx.blur(); }
  };
  tx.onblur = () => {
    if (finished) return; finished = true;
    editing = false;
    const v = tx.innerText.replace(/ /g, ' ').trim().slice(0, MAX_TEXT);
    if (!cancelled && v && v !== task.text) backend.update(task.id, { text: v });
    render();
  };
}

/* 드래그로 날짜 이동: 마우스는 바로, 터치는 길게 눌러서 */
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !backend) return;
  const p = e.target.closest('.pill[data-id]');
  if (!p || e.target.closest('[data-act]') || e.target.isContentEditable) return;
  const r = p.getBoundingClientRect();
  drag = { id: p.dataset.id, el: p, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
           ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, on: false, target: null,
           touch: e.pointerType !== 'mouse' };
  if (drag.touch){
    const d = drag;
    d.timer = setTimeout(() => {
      if (drag !== d || d.on) return;
      startDrag(); moveDrag();
      if (navigator.vibrate) navigator.vibrate(12);
    }, 380);
  }
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.on){
    const dist = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy);
    if (drag.touch){ if (dist > 8){ clearTimeout(drag.timer); drag = null; } return; }
    if (dist < 5) return;
    startDrag();
  }
  moveDrag();
});
document.addEventListener('touchmove', e => { if (drag && drag.on) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => { if (e.target.closest('.pill[data-id]')) e.preventDefault(); });
document.addEventListener('pointerup', () => endDrag(true));
document.addEventListener('pointercancel', () => endDrag(false));

function startDrag(){
  drag.on = true;
  const c = drag.el.cloneNode(true);
  c.classList.add('lifted', 'floating');
  c.style.width = drag.w + 'px';
  document.body.appendChild(c);
  drag.clone = c;
  drag.el.classList.add('ghost');
  document.body.classList.add('dragging');
  getSelection().removeAllRanges();
  requestAnimationFrame(autoScroll);
}
function moveDrag(){
  drag.clone.style.left = (drag.x - drag.ox) + 'px';
  drag.clone.style.top = (drag.y - drag.oy) + 'px';
  const under = document.elementFromPoint(drag.x, drag.y);
  const t = under && under.closest('.cell[data-date], [data-drop][data-date]');
  if (t !== drag.target){
    if (drag.target) drag.target.classList.remove('drop');
    if (t) t.classList.add('drop');
    drag.target = t;
  }
}
function autoScroll(){
  if (!drag || !drag.on) return;
  const H = innerHeight, edge = 70;
  const v = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > H - edge ? (drag.y - (H - edge)) / 4 : 0;
  if (v){ scrollBy(0, v); moveDrag(); }
  requestAnimationFrame(autoScroll);
}
function endDrag(commit){
  const d = drag; drag = null;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.on) return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
  d.clone.remove(); d.el.classList.remove('ghost');
  document.body.classList.remove('dragging');
  if (d.target) d.target.classList.remove('drop');
  const task = find(d.id);
  if (commit && d.target && task && task.date !== d.target.dataset.date){
    backend.update(task.id, { date: d.target.dataset.date, order: Date.now() });
  }
  render();
}

/* 자정이 지나면 오늘·밀린 일 갱신, 온라인 상태 변화 반영 */
setInterval(() => {
  const t = todayKey();
  if (t !== lastToday){ if (sel === lastToday) sel = t; lastToday = t; requestRender(); }
}, 60000);
addEventListener('online', () => { if (syncState === 'offline') syncState = 'connecting'; requestRender(); });
addEventListener('offline', () => { if (syncState !== 'local') syncState = 'offline'; requestRender(); });

/* ════════ 시작 ════════ */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// 개발용: 내 PC(localhost)에서 ?local 을 붙이면 Firebase 없이 화면만 테스트
const devLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
const configured = !devLocal && firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR');
(async () => {
  if (!configured){ backend = localBackend(); showLogin(false); return; }
  try { backend = await firebaseBackend(); }
  catch (e) {
    console.error(e);
    showLogin(true);
    $('loginErr').textContent = '서버에 연결하지 못했어요. 인터넷 연결 후 다시 열어 주세요.';
    $('loginBtn').disabled = true;
  }
})();
