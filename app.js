import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
const LOCAL_KEY = 'todo-calendar-local-v1';
const DOW = ['일','월','화','수','목','금','토'];
const MAX_IN_CELL = 3;
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
const byDate = date => tasks.filter(t => t.date === date).sort((a, b) => a.order - b.order);

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
  return {
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
  let userId = null, unsub = null;
  const col = () => F.collection(db, 'users', userId, 'tasks');
  const fail = e => { console.error(e); toast('저장하지 못했어요 (' + (e.code || e.message) + ')'); };

  setupLogin(A, auth);

  A.onAuthStateChanged(auth, user => {
    if (unsub){ unsub(); unsub = null; }
    if (!user){ userId = null; tasks = []; showLogin(true); return; }
    userId = user.uid;
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
    let items = list.slice(0, MAX_IN_CELL).map(x => pillHTML(x)).join('');
    if (list.length > MAX_IN_CELL) items += `<div class="more">외 ${list.length - MAX_IN_CELL}개</div>`;
    const dots = list.slice(0, 4).map(x => `<i class="${x.done ? 'd' : ''}"></i>`).join('');
    h += `<div class="${cls.join(' ')}" data-date="${k}"><div class="dn"><b>${d.getDate()}</b>`
      + `<button class="add" data-act="add" title="할 일 추가">+</button></div>`
      + `<div class="items">${items}</div><div class="dots">${dots}</div></div>`;
  }
  const g = $('grid');
  g.style.gridTemplateRows = `repeat(${rows}, minmax(var(--rowh), 1fr))`;
  g.innerHTML = h;
}

function renderSide(){
  const t = todayKey(), d = parse(sel);
  const diff = Math.round((d - parse(t)) / 864e5);
  const title = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === -1 ? '어제' : `${d.getMonth()+1}월 ${d.getDate()}일`;
  const sub = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일`;
  const list = byDate(sel), done = list.filter(x => x.done).length;
  const late = tasks.filter(x => !x.done && x.date < t).sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  const del = `<button class="act x" data-act="del" title="삭제">×</button>`;
  const focused = document.activeElement && document.activeElement.id === 'addInput';
  const draft = $('addInput') ? $('addInput').value : '';

  $('side').innerHTML = `
    <div>
      <h2>${title}</h2><div class="sub">${sub}</div>
      ${list.length ? `<div class="prog"><span><i style="width:${Math.round(done / list.length * 100)}%"></i></span>${done} / ${list.length}</div>` : ''}
    </div>
    <section class="sec">
      <div class="sec-h">할 일 <em>${list.length}</em></div>
      <div class="list" data-date="${sel}">
        ${list.map(x => pillHTML(x, { lg: 1, actions: del })).join('')}
        <label class="pill lg input"><span class="cb"></span><input id="addInput" placeholder="할 일 추가" autocomplete="off" maxlength="${MAX_TEXT}" enterkeyhint="done"><span class="kbd">↵</span></label>
      </div>
      <div class="mhint">길게 눌러서 달력 날짜로 끌면 이동 · 글자를 누르면 수정</div>
    </section>
    <section class="sec late">
      <div class="sec-h">밀린 일 <em>${late.length}</em></div>
      <div class="list">
        ${late.length ? late.map(x => pillHTML(x, { lg: 1, tag: md(x.date), actions: `<button class="act" data-act="to-today" title="오늘로 옮기기">오늘로</button>` })).join('')
                      : `<div class="empty">밀린 일이 없어요</div>`}
      </div>
    </section>
    <div class="side-foot">
      <span class="sync s-${syncState}">${SYNC_LABEL[syncState]}</span>
      <span>${backend && backend.signOut ? `<button data-act="logout">로그아웃</button>` : ''}<button data-act="clear">모두 지우기</button></span>
    </div>`;
  const inp = $('addInput');
  inp.value = draft;
  if (focused) inp.focus();
}

function select(date, focusInput){
  sel = date;
  const d = parse(date);
  if (d.getFullYear() !== view.y || d.getMonth() !== view.m) view = { y: d.getFullYear(), m: d.getMonth() };
  const keep = $('addInput'); if (keep) keep.value = '';
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
  if (isTouchUI()){
    const tx = e.target.closest('.pill.lg .tx');
    if (tx && !tx.isContentEditable){ startEdit(tx); return; }
  }
  const cell = e.target.closest('.cell[data-date]');
  if (cell) select(cell.dataset.date);
});

document.addEventListener('keydown', e => {
  if (!backend) return;
  if (e.target.id === 'addInput'){
    if (e.key === 'Enter' && !e.isComposing){
      const v = e.target.value.trim().slice(0, MAX_TEXT);
      if (v){ e.target.value = ''; backend.add({ id: uid(), text: v, date: sel, done: false, order: Date.now() }); }
    } else if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName) || $('app').hidden) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  else if (e.key === 'ArrowRight') shiftMonth(1);
  else if (e.key === 't' || e.key === 'T') select(todayKey());
  else if (e.key === 'n' || e.key === 'N'){ e.preventDefault(); $('addInput').focus(); }
});

/* 수정: PC는 더블클릭, 폰은 글자 탭 */
document.addEventListener('dblclick', e => {
  const tx = e.target.closest('.pill.lg .tx');
  if (tx && !tx.isContentEditable) startEdit(tx);
});
function startEdit(tx){
  const task = find(tx.closest('.pill').dataset.id);
  if (!task) return;
  editing = true;
  tx.contentEditable = 'true'; tx.focus();
  const r = document.createRange(); r.selectNodeContents(tx);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  let cancelled = false, finished = false;
  tx.onkeydown = ev => {
    if (ev.key === 'Enter' && !ev.isComposing){ ev.preventDefault(); tx.blur(); }
    else if (ev.key === 'Escape'){ cancelled = true; tx.blur(); }
  };
  tx.onblur = () => {
    if (finished) return; finished = true;
    editing = false;
    const v = tx.textContent.trim().slice(0, MAX_TEXT);
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
  const t = under && under.closest('.cell[data-date], .list[data-date]');
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
const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR');
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
