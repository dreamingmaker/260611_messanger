'use strict';

/* ====================================================================
   P2P 사내 메신저 클라이언트  (채널 > 주제 > 스레드)
   브라우저는 "자기 PC 노드"의 localhost 에만 접속한다.
   ==================================================================== */

const socket = io();

const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080',
  '#9a6324', '#800000', '#808000', '#000075', '#e67e22', '#16a085',
  '#2980b9', '#8e44ad', '#c0392b', '#27ae60',
];
const EMOJIS = ['😀','😄','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😴','😭','😮','😡','👍','👎','🙏','👏','🙌','💪','🎉','🔥','💯','✅','❌','❤️','💙','💚','⭐','☕','💬'];
const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

// ---------- 상태 ----------
const LS = { name: 'p2p.name', color: 'p2p.color' };
let me = null;                 // { id, name, color }
let channels = [];             // [{ id, name }]
let recs = {};                 // id -> record (channel | msg)
let peers = [];                // 접속 중인 다른 동료 [{id,name,color}]
let cur = { channel: 'ch-general', topic: null };
let unread = {};               // key(channel,topic) -> count
let view = { msgs: [] };       // 현재 스레드에 그려진 메시지
let selectedColor = localStorage.getItem(LS.color) || COLORS[Math.floor(Math.random() * COLORS.length)];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const loginEl = $('login'), loginForm = $('login-form'), nameInput = $('name-input');
const colorPicker = $('color-picker'), loginError = $('login-error');
const appEl = $('app'), meAvatar = $('me-avatar'), meName = $('me-name');
const connDot = $('conn-dot'), connText = $('conn-text'), logoutBtn = $('logout-btn');
const addChannelBtn = $('add-channel-btn'), channelList = $('channel-list');
const dmListEl = $('dm-list');
const peerCount = $('peer-count'), userList = $('user-list');
const menuBtn = $('menu-btn'), crumb = $('crumb'), headerActions = $('header-actions');
const overview = $('overview'), messages = $('messages'), typingBar = $('typing-bar');
const composer = $('composer'), emojiBtn = $('emoji-btn'), msgInput = $('msg-input'), sendBtn = $('send-btn'), emojiPop = $('emoji-pop');
const imgBtn = $('img-btn'), imgInput = $('img-input'), dropOverlay = $('drop-overlay');
const fileBtn = $('file-btn'), fileInput = $('file-input');
const sidebarBackdrop = $('sidebar-backdrop');
const modal = $('modal'), modalForm = $('modal-form'), modalTitle = $('modal-title'), modalInput = $('modal-input'), modalCancel = $('modal-cancel');
const summaryModal = $('summary-modal'), summaryTitle = $('summary-title'), summaryBody = $('summary-body'), summaryClose = $('summary-close'), unreadBar = $('unread-bar');
let lastRead = {};
try { lastRead = JSON.parse(localStorage.getItem('p2p.lastRead') || '{}'); } catch (e) { lastRead = {}; }
function saveLastRead() { try { localStorage.setItem('p2p.lastRead', JSON.stringify(lastRead)); } catch (e) {} }
let _edits = {}, _reactions = {}, _votes = {}, _submits = {}, _avail = {}, _taskstat = {}, _acks = {}, mentionFlags = {};
const typingUsers = new Map();

// ====================================================================
// 유틸
// ====================================================================
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeColor(c) { return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : '#888'; }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }
function renderText(s) { return linkify(esc(s)).replace(/\n/g, '<br>'); }
function initial(name) { const a = [...String(name || '?')]; return a.length ? a[0] : '?'; }
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function dayLabel(ts) { const d = new Date(ts); return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일'; }
function fmtTime(ts) {
  const d = new Date(ts); let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h < 12 ? '오전' : '오후'; h = h % 12; if (h === 0) h = 12;
  return ap + ' ' + h + ':' + m;
}
function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function key(c, t) { return JSON.stringify([c, t]); }
function channelName(id) { const c = channels.find((x) => x.id === id); return c ? c.name : '채널'; }
// ---- DM(1:1) ----
function isDMChannel(ch) { return typeof ch === 'string' && ch.indexOf('dm:') === 0; }
function dmIdFor(partnerId) { return 'dm:' + [me.id, partnerId].sort().join('|'); }
function dmPartnerId(ch) { const p = ch.slice(3).split('|'); return p[0] === me.id ? p[1] : p[0]; }
function knownUser(id) {
  const p = peers.find((u) => u.id === id);
  if (p) return p;
  for (const r of Object.values(recs)) if (r.type === 'user' && r.uid === id) return { id: id, name: r.name, color: r.color }; // 영구 명부(오프라인도 이름 해석)
  for (const r of Object.values(recs)) if (r.author && r.author.id === id) return r.author;
  return { id: id, name: '(알 수 없음)', color: '#888' };
}
function roster() { // 등록된 전체 구성원(고정 신원). 온라인 여부 무관.
  const m = {};
  for (const r of Object.values(recs)) if (r.type === 'user' && r.uid && !m[r.uid]) m[r.uid] = { id: r.uid, name: r.name, color: r.color };
  if (me && !m[me.id]) m[me.id] = { id: me.id, name: me.name, color: me.color };
  return Object.values(m);
}
function myDMs() {
  const set = new Set();
  for (const r of Object.values(recs)) {
    if (r.type === 'msg' && isDMChannel(r.channel) && r.channel.slice(3).split('|').indexOf(me.id) !== -1) set.add(r.channel);
  }
  if (isDMChannel(cur.channel)) set.add(cur.channel);
  const lastTs = (ch) => { let t = 0; for (const r of Object.values(recs)) if (r.type === 'msg' && r.channel === ch && r.ts > t) t = r.ts; return t; };
  return [...set].map((ch) => ({ channel: ch, partner: knownUser(dmPartnerId(ch)) })).sort((a, b) => lastTs(b.channel) - lastTs(a.channel));
}

// 삭제 표식(del)으로 지워진 메시지 id 집합 (작성자 본인이 지운 것만 인정)
function buildDeleted() {
  const set = new Set();
  for (const r of Object.values(recs)) {
    if (r.type !== 'del') continue;
    const t = recs[r.target];
    if (t && t.type === 'msg' && t.author && r.author && t.author.id === r.author.id) set.add(r.target);
  }
  return set;
}
// 수정: target -> {text} (작성자 본인의 최신 edit 적용)
function buildEdits() {
  const m = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'edit' || typeof r.text !== 'string') continue;
    const t = recs[r.target];
    if (!t || t.type !== 'msg' || !t.author || !r.author || t.author.id !== r.author.id) continue;
    const c = m[r.target];
    if (!c || r.ts > c.ts || (r.ts === c.ts && (r.lc || 0) > (c.lc || 0))) m[r.target] = { text: r.text, ts: r.ts, lc: r.lc || 0 };
  }
  return m;
}
// 리액션: target -> emoji -> Set(authorId). 토글 횟수 패리티(홀수=눌림)로 순서 무관하게 수렴
function buildReactions() {
  const cnt = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'react' || !r.author || !recs[r.target]) continue;
    const t = cnt[r.target] || (cnt[r.target] = {});
    const e = t[r.emoji] || (t[r.emoji] = {});
    e[r.author.id] = (e[r.author.id] || 0) + 1;
  }
  const m = {};
  for (const target in cnt) {
    m[target] = {};
    for (const emoji in cnt[target]) {
      const set = new Set();
      for (const aid in cnt[target][emoji]) if (cnt[target][emoji][aid] % 2 === 1) set.add(aid);
      if (set.size) m[target][emoji] = set; else delete m[target][emoji];
    }
    if (!Object.keys(m[target]).length) delete m[target];
  }
  return m;
}
// 투표 집계: target -> { optIndex -> Set(authorId) }. 단일선택=작성자별 최신 vote, 복수선택=패리티
function buildVotes() {
  const byTarget = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'vote' || !r.author || typeof r.opt !== 'number') continue;
    const t = recs[r.target];
    if (!t || !t.poll) continue;
    (byTarget[r.target] || (byTarget[r.target] = [])).push(r);
  }
  const out = {};
  for (const target in byTarget) {
    const poll = recs[target].poll;
    const byAuthor = {};
    for (const r of byTarget[target]) (byAuthor[r.author.id] || (byAuthor[r.author.id] = [])).push(r);
    const tally = {};
    for (const aid in byAuthor) {
      const list = byAuthor[aid];
      if (poll.multi) {
        const cnt = {};
        for (const r of list) cnt[r.opt] = (cnt[r.opt] || 0) + 1;
        for (const o in cnt) { const oi = Number(o); if (cnt[o] % 2 === 1 && oi >= 0 && oi < poll.opts.length) (tally[oi] || (tally[oi] = new Set())).add(aid); }
      } else {
        let best = null;
        for (const r of list) { if (!best || r.ts > best.ts || (r.ts === best.ts && (r.lc || 0) > (best.lc || 0))) best = r; }
        if (best && best.opt >= 0 && best.opt < poll.opts.length) (tally[best.opt] || (tally[best.opt] = new Set())).add(aid);
      }
    }
    out[target] = tally;
  }
  return out;
}
// 수합 제출 집계: target -> { authorId -> 최신 submit }
function buildSubmits() {
  const out = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'submit' || !r.author) continue;
    const t = recs[r.target];
    if (!t || !t.intake) continue;
    const bucket = out[r.target] || (out[r.target] = {});
    const cur = bucket[r.author.id];
    if (!cur || r.ts > cur.ts || (r.ts === cur.ts && (r.lc || 0) > (cur.lc || 0))) bucket[r.author.id] = r;
  }
  return out;
}
// 일정조율 가용응답 집계: target -> { authorId -> 최신 avail }
function buildAvail() {
  const out = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'avail' || !r.author || !Array.isArray(r.slots)) continue;
    const t = recs[r.target];
    if (!t || !t.sched) continue;
    const b = out[r.target] || (out[r.target] = {});
    const cur = b[r.author.id];
    if (!cur || r.ts > cur.ts || (r.ts === cur.ts && (r.lc || 0) > (cur.lc || 0))) b[r.author.id] = r;
  }
  return out;
}
// 작업 진행상태 집계: target -> { authorId -> 최신 taskstat }
function buildTaskStat() {
  const out = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'taskstat' || !r.author) continue;
    const t = recs[r.target];
    if (!t || !t.task) continue;
    const b = out[r.target] || (out[r.target] = {});
    const cur = b[r.author.id];
    if (!cur || r.ts > cur.ts || (r.ts === cur.ts && (r.lc || 0) > (cur.lc || 0))) b[r.author.id] = r;
  }
  return out;
}
// 확인(ACK) 집계: target -> Set(확인한 authorId). 토글 패리티(홀수=확인)
function buildAcks() {
  const cnt = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'ack' || !r.author || !recs[r.target]) continue;
    const t = cnt[r.target] || (cnt[r.target] = {});
    t[r.author.id] = (t[r.author.id] || 0) + 1;
  }
  const m = {};
  for (const target in cnt) { const s = new Set(); for (const aid in cnt[target]) if (cnt[target][aid] % 2 === 1) s.add(aid); if (s.size) m[target] = s; }
  return m;
}
function ackTitle(m, acks) {
  const exp = isDMChannel(m.channel) ? m.channel.slice(3).split('|').map(knownUser) : roster();
  const did = exp.filter((u) => acks.has(u.id)).map((u) => u.name);
  const not = exp.filter((u) => !acks.has(u.id) && !(m.author && u.id === m.author.id)).map((u) => u.name);
  let s = '확인: ' + (did.join(', ') || '없음');
  if (not.length) s += '  ·  미확인: ' + not.join(', ');
  return s;
}
// 주제별 리셋 기준 시각: key(채널,주제) -> 최대 reset.ts. 이 시각 이하(<=)의 메시지는 숨긴다
function buildResets() {
  const m = {};
  for (const r of Object.values(recs)) {
    if (r.type !== 'reset' || typeof r.topic !== 'string') continue;
    const k = key(r.channel, r.topic);
    if (!m[k] || r.ts > m[k]) m[k] = r.ts;
  }
  return m;
}
function msgsOf(channel, topic) {
  const del = buildDeleted();
  const cut = buildResets()[key(channel, topic)] || 0;
  return Object.values(recs)
    .filter((r) => r.type === 'msg' && r.channel === channel && r.topic === topic && !del.has(r.id) && r.ts > cut)
    .sort((a, b) => (a.ts - b.ts) || (a.lc - b.lc) || a.id.localeCompare(b.id));
}
function topicsOf(channel) {
  const del = buildDeleted();
  const resets = buildResets();
  const map = new Map();
  for (const r of Object.values(recs)) {
    if (r.type !== 'msg' || r.channel !== channel || del.has(r.id)) continue;
    if (r.ts <= (resets[key(channel, r.topic)] || 0)) continue;
    const e = map.get(r.topic) || { topic: r.topic, count: 0, lastTs: 0, last: null };
    e.count++;
    if (r.ts >= e.lastTs) { e.lastTs = r.ts; e.last = r; }
    map.set(r.topic, e);
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
}
function channelUnread(channel) {
  let n = 0;
  for (const t of topicsOf(channel)) n += unread[key(channel, t.topic)] || 0;
  // 새로 만든(아직 메시지 없는) 주제는 위 목록에 없으므로 무시되어도 무방
  return n;
}
function totalUnread() { let n = 0; for (const k in unread) n += unread[k]; return n; }
function updateTitle() { const n = totalUnread(); document.title = (n > 0 ? '(' + n + ') ' : '') + 'P2P 사내 메신저'; }

// ====================================================================
// 로그인 / 화면 전환
// ====================================================================
function renderColorPicker() {
  colorPicker.innerHTML = '';
  COLORS.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'color-dot' + (c === selectedColor ? ' selected' : '');
    d.style.background = c;
    d.onclick = () => { selectedColor = c; renderColorPicker(); };
    colorPicker.appendChild(d);
  });
}
renderColorPicker();

function showApp() { loginEl.classList.add('hidden'); appEl.classList.remove('hidden'); }
function showLogin() { appEl.classList.add('hidden'); loginEl.classList.remove('hidden'); }
function setStatus(on) {
  connDot.className = 'conn-dot ' + (on ? 'on' : 'off');
  connText.textContent = on ? '내 노드 연결됨' : '노드 연결 끊김';
}
function doLogin(name, color) {
  me = { name, color };
  localStorage.setItem(LS.name, name);
  localStorage.setItem(LS.color, color);
  socket.emit('login', { name, color });
}
function doLogout() {
  localStorage.removeItem(LS.name);
  me = null; recs = {}; channels = []; unread = {};
  showLogin();
}
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  loginError.textContent = '';
  enableAudio(); requestNotify();
  doLogin(name, selectedColor);
});
logoutBtn.onclick = doLogout;

// ====================================================================
// 소켓 이벤트
// ====================================================================
socket.on('connect', () => {
  setStatus(true);
  if (me) socket.emit('login', { name: me.name, color: me.color });
});
socket.on('session', (d) => {
  if (me) return;
  if (d && d.hasName) { doLogin(d.name, d.color); return; } // 고정 신원: 이 PC에 신원이 있으면 자동 입장
  const sn = localStorage.getItem(LS.name);
  if (sn) doLogin(sn, selectedColor);
});
socket.on('disconnect', () => setStatus(false));
socket.on('loginError', (msg) => { me = null; showLogin(); loginError.textContent = msg; });

socket.on('init', (d) => {
  me = d.me;
  localStorage.setItem(LS.name, me.name);
  localStorage.setItem(LS.color, me.color);
  channels = d.channels || [];
  peers = d.peers || [];
  recs = {};
  for (const r of d.records || []) recs[r.id] = r;
  renderMe();
  showApp();
  const exists = channels.some((c) => c.id === cur.channel);
  selectChannel(exists ? cur.channel : (channels[0] && channels[0].id) || 'ch-general');
  renderUsers();
});

socket.on('record', (r) => {
  if (!r || recs[r.id]) { if (r) recs[r.id] = r; return; }
  recs[r.id] = r;
  if (r.type === 'msg') onMsg(r);
  else if (r.type === 'del') onDelete(r);
  else if (r.type === 'reset') onReset(r);
  else if (r.type === 'react' || r.type === 'edit' || r.type === 'vote' || r.type === 'submit' || r.type === 'avail' || r.type === 'taskstat' || r.type === 'ack') rerenderIfCurrent(r.target);
  else if (r.type === 'user') { if (me) { renderUsers(); renderSidebar(); } } // 명부 갱신(오프라인 이름 표시)
  else if (r.type === 'docver') { if (docsModal && !docsModal.classList.contains('hidden')) { if (_openDocId) openDocDetail(_openDocId); else renderDocsList(); } }
  else if (r.type === 'channel') { /* channels 이벤트로 갱신됨 */ }
});
socket.on('channels', (list) => { channels = list || []; renderSidebar(); if (!overview.classList.contains('hidden')) renderOverview(); updateCrumb(); });
socket.on('peers', (list) => { peers = list || []; renderUsers(); });

// ====================================================================
// 메시지 처리
// ====================================================================
function onMsg(r) {
  if (!me) return;
  const isCur = cur.topic != null && r.channel === cur.channel && r.topic === cur.topic;
  const fromMe = me && r.author && r.author.id === me.id;
  const threadVisible = !messages.classList.contains('hidden');
  const nb = isNearBottom();

  if (isCur && threadVisible) { appendMsg(r); if (nb || fromMe) scrollBottom(); }

  const mentionedMe = me && Array.isArray(r.mentions) && r.mentions.indexOf(me.id) !== -1;
  const read = isCur && !document.hidden;
  if (!read && !fromMe) {
    unread[key(r.channel, r.topic)] = (unread[key(r.channel, r.topic)] || 0) + 1;
    if (mentionedMe) mentionFlags[key(r.channel, r.topic)] = true;
    notify(r, mentionedMe);
  }
  renderSidebar();
  if (cur.topic == null && cur.channel === r.channel && !overview.classList.contains('hidden')) renderOverview();
  updateTitle();
}

// 삭제 표식 수신 → 화면 다시 그리기 (지워진 메시지가 사라짐)
function onDelete() {
  if (cur.topic != null && !messages.classList.contains('hidden')) renderThread();
  else if (cur.topic == null && !overview.classList.contains('hidden')) renderOverview();
  renderSidebar();
  updateTitle();
}
// 채널 리셋 표식 수신 → 해당 채널 안읽음 정리 + 화면 갱신
function onReset(r) {
  if (r && r.channel && typeof r.topic === 'string') delete unread[key(r.channel, r.topic)];
  if (cur.topic != null && !messages.classList.contains('hidden')) renderThread();
  else if (cur.topic == null && !overview.classList.contains('hidden')) renderOverview();
  renderSidebar();
  updateTitle();
}
// 리액션/수정 표식 수신 → 그 메시지가 현재 보는 스레드에 있으면 다시 그림
function rerenderIfCurrent(targetId) {
  const t = recs[targetId];
  if (!t || t.type !== 'msg') return;
  if (cur.topic != null && t.channel === cur.channel && t.topic === cur.topic && !messages.classList.contains('hidden')) renderThread();
}

// ====================================================================
// 화면: 사이드바
// ====================================================================
function renderMe() {
  meAvatar.style.background = me.color; meAvatar.textContent = initial(me.name);
  meName.textContent = me.name;
}
function renderSidebar() {
  if (!me) return;
  channelList.innerHTML = '';
  channels.forEach((c) => {
    const li = document.createElement('li');
    const active = c.id === cur.channel;
    li.className = 'channel-item' + (active ? ' active' : '');
    const cu = channelUnread(c.id);
    li.innerHTML = '<span class="ch-hash">#</span><span class="ch-name">' + esc(c.name) + '</span>' +
      (cu ? '<span class="badge">' + cu + '</span>' : '');
    li.onclick = () => selectChannel(c.id);
    channelList.appendChild(li);

    if (active) {
      const sub = document.createElement('ul');
      sub.className = 'topic-sub';
      const topics = topicsOf(c.id);
      // 현재 보고 있는(새로 만든) 주제가 목록에 없으면 임시로 추가
      if (cur.topic != null && !topics.some((t) => t.topic === cur.topic)) {
        topics.unshift({ topic: cur.topic, count: 0, lastTs: Date.now(), last: null });
      }
      if (!topics.length) {
        const e = document.createElement('li'); e.className = 'topic-empty'; e.textContent = '주제 없음';
        sub.appendChild(e);
      } else {
        topics.forEach((t) => {
          const row = document.createElement('li');
          const tActive = cur.topic === t.topic;
          row.className = 'topic-row' + (tActive ? ' active' : '');
          const tu = unread[key(c.id, t.topic)] || 0;
          const tm = mentionFlags[key(c.id, t.topic)];
          row.innerHTML = '<span class="t-leaf">▸</span><span class="t-name">' + esc(t.topic) + '</span>' +
            (tu ? '<span class="badge' + (tm ? ' mention' : '') + '">' + tu + '</span>' : (tm ? '<span class="badge mention">@</span>' : ''));
          row.onclick = (ev) => { ev.stopPropagation(); openTopic(c.id, t.topic); };
          sub.appendChild(row);
        });
      }
      channelList.appendChild(sub);
    }
  });
  renderDMList();
}
function renderDMList() {
  if (!dmListEl) return;
  dmListEl.innerHTML = '';
  myDMs().forEach((d) => {
    const li = document.createElement('li');
    li.className = 'channel-item' + (d.channel === cur.channel ? ' active' : '');
    const on = peers.some((p) => p.id === d.partner.id);
    const u = unread[key(d.channel, '')] || 0;
    const dmm = mentionFlags[key(d.channel, '')];
    li.innerHTML = '<span class="u-dot" style="background:' + (on ? 'var(--online)' : '#7e879b') + '"></span>' +
      '<span class="ch-name">' + esc(d.partner.name) + '</span>' +
      (u ? '<span class="badge' + (dmm ? ' mention' : '') + '">' + u + '</span>' : (dmm ? '<span class="badge mention">@</span>' : ''));
    li.onclick = () => openDM(d.partner.id);
    dmListEl.appendChild(li);
  });
}
function renderUsers() {
  userList.innerHTML = '';
  const all = [];
  if (me) all.push({ id: me.id, name: me.name, color: me.color, self: true });
  for (const p of peers) all.push(p);
  peerCount.textContent = all.length;
  all.sort((a, b) => (a.self ? -1 : b.self ? 1 : a.name.localeCompare(b.name, 'ko')));
  all.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'user-item';
    const tag = u.self ? ' <span style="color:var(--sidebar-muted)">(나)</span>' : '';
    li.innerHTML = '<div class="avatar sm" style="background:' + safeColor(u.color) + '">' + esc(initial(u.name)) + '</div>' +
      '<span class="u-name">' + esc(u.name) + tag + '</span>';
    if (!u.self) { li.style.cursor = 'pointer'; li.title = '1:1 대화 시작'; li.onclick = () => openDM(u.id); }
    userList.appendChild(li);
  });
}

// ====================================================================
// 화면: 헤더 / 개요 / 스레드
// ====================================================================
function updateCrumb() {
  if (isDMChannel(cur.channel)) {
    const u = knownUser(dmPartnerId(cur.channel));
    const on = peers.some((p) => p.id === u.id);
    crumb.innerHTML = '<span class="c-hash">@</span><span class="c-topic">' + esc(u.name) + '</span>' +
      '<span class="c-sub">' + (on ? '● 접속 중' : '○ 오프라인') + '</span>';
    headerActions.innerHTML = '<button class="btn-ghost-sm" id="topic-summary">📝 요약</button><button class="btn-ghost-sm" id="topic-export">⬇ 내보내기</button>';
    headerActions.querySelector('#topic-summary').onclick = () => summarizeMessages(msgsOf(cur.channel, ''), u.name + ' 님과의 대화 요약');
    headerActions.querySelector('#topic-export').onclick = exportTopicTxt;
    return;
  }
  if (cur.topic == null) {
    const n = topicsOf(cur.channel).length;
    crumb.innerHTML = '<span class="c-hash">#</span><span class="c-channel">' + esc(channelName(cur.channel)) +
      '</span><span class="c-sub">주제 ' + n + '개</span>';
    headerActions.innerHTML = '';
  } else {
    crumb.innerHTML = '<button class="c-back" title="주제 목록">←</button><span class="c-hash">#</span>' +
      '<span class="c-channel">' + esc(channelName(cur.channel)) + '</span>' +
      '<span class="c-sep">›</span><span class="c-topic">' + esc(cur.topic) + '</span>';
    crumb.querySelector('.c-back').onclick = () => selectChannel(cur.channel);
    headerActions.innerHTML = '<button class="btn-ghost-sm" id="topic-summary">📝 요약</button><button class="btn-ghost-sm" id="topic-export">⬇ 내보내기</button><button class="btn-ghost-sm" id="topic-reset">⟳ 주제 리셋</button>';
    headerActions.querySelector('#topic-summary').onclick = () => summarizeMessages(msgsOf(cur.channel, cur.topic), '“' + cur.topic + '” 주제 요약');
    headerActions.querySelector('#topic-export').onclick = exportTopicTxt;
    headerActions.querySelector('#topic-reset').onclick = () => {
      if (confirm('“' + cur.topic + '” 주제의 이전 대화를 모두 리셋할까요?\\n모든 동료에게서 이 주제의 과거 메시지가 사라집니다. (되돌릴 수 없음)')) socket.emit('resetTopic', { channel: cur.channel, topic: cur.topic });
    };
  }
  const cc = crumb.querySelector('.c-channel');
  if (cc) cc.onclick = () => selectChannel(cur.channel);
}

function showOverview() {
  overview.classList.remove('hidden');
  messages.classList.add('hidden'); typingBar.classList.add('hidden'); composer.classList.add('hidden');
}
function showThread() {
  overview.classList.add('hidden');
  messages.classList.remove('hidden'); composer.classList.remove('hidden');
}

function selectChannel(id) {
  cur = { channel: id, topic: null };
  if (unreadBar) unreadBar.classList.add('hidden');
  closeSidebarMobile();
  showOverview();
  renderOverview();
  renderSidebar();
  updateCrumb();
}

function renderOverview() {
  const topics = topicsOf(cur.channel);
  const bar = '<div class="overview-bar"><span class="ov-title">주제 ' + topics.length + '개</span>' +
    '<button class="btn-new-topic" id="ov-new-topic">＋ 새 주제</button></div>';
  let body;
  if (!topics.length) {
    body = '<div class="ov-empty">아직 주제가 없습니다.<br>＋ 새 주제 버튼으로 첫 대화를 시작해보세요.</div>';
  } else {
    body = topics.map((t) => {
      const u = unread[key(cur.channel, t.topic)] || 0;
      const last = t.last;
      const lastBody = last ? (last.file && !last.text ? '📎 ' + esc(last.file.name || '파일') : (last.image && !last.text ? '🖼 사진' : esc((last.text || '').slice(0, 80)))) : '';
      const preview = last ? '<b>' + esc(last.author ? last.author.name : '') + ':</b> ' + lastBody : '';
      return '<div class="topic-card" data-topic="' + encodeURIComponent(t.topic) + '">' +
        '<div class="tc-top"><span class="tc-leaf">▸</span><span class="tc-name">' + esc(t.topic) + '</span>' +
        (u ? '<span class="badge">' + u + '</span>' : '') +
        '<span class="tc-meta">' + t.count + '개 · ' + (last ? fmtAgo(last.ts) : '') + '</span></div>' +
        (preview ? '<div class="tc-preview">' + preview + '</div>' : '') + '</div>';
    }).join('');
  }
  overview.innerHTML = bar + body;
  $('ov-new-topic').onclick = openNewTopic;
  overview.querySelectorAll('.topic-card').forEach((el) => {
    el.onclick = () => openTopic(cur.channel, decodeURIComponent(el.dataset.topic));
  });
}

// 열 때, 마지막으로 읽은 시점 이후의 메시지(안 읽은 것)에 대해 요약 바 노출
function showUnreadBar(channel, topic) {
  if (!unreadBar) return;
  const k = key(channel, topic);
  const prev = lastRead[k] || 0;
  const all = msgsOf(channel, topic);
  const unreadMsgs = all.filter((m) => m.ts > prev && !(me && m.author && m.author.id === me.id));
  if (all.length) { lastRead[k] = Math.max(prev, all[all.length - 1].ts); saveLastRead(); }
  if (unreadMsgs.length >= 1) {
    unreadBar.innerHTML = '🆕 안 읽은 메시지 ' + unreadMsgs.length + '개 · <button class="ub-btn" id="ub-sum">읽은 부분 요약</button> <button class="ub-btn ghost" id="ub-x">닫기</button>';
    unreadBar.classList.remove('hidden');
    $('ub-sum').onclick = () => summarizeMessages(unreadMsgs, '안 읽은 메시지 요약 (' + unreadMsgs.length + '개)');
    $('ub-x').onclick = () => unreadBar.classList.add('hidden');
  } else {
    unreadBar.classList.add('hidden');
  }
}
function openTopic(channel, topic) {
  cur = { channel, topic };
  unread[key(channel, topic)] = 0;
  delete mentionFlags[key(channel, topic)];
  closeSidebarMobile();
  showThread();
  renderThread();
  showUnreadBar(channel, topic);
  renderSidebar();
  updateCrumb();
  updateTitle();
  if (window.innerWidth > 720) msgInput.focus();
  msgInput.placeholder = '주제 “' + topic + '”에 메시지…';
}

function openDM(partnerId) {
  if (!me || partnerId === me.id) return;
  cur = { channel: dmIdFor(partnerId), topic: '' };
  unread[key(cur.channel, '')] = 0;
  delete mentionFlags[key(cur.channel, '')];
  closeSidebarMobile();
  showThread();
  renderThread();
  showUnreadBar(cur.channel, '');
  renderSidebar();
  updateCrumb();
  updateTitle();
  if (window.innerWidth > 720) msgInput.focus();
  msgInput.placeholder = (knownUser(partnerId).name || '상대') + ' 님에게 1:1 메시지…';
}

function renderThread() {
  view.msgs = msgsOf(cur.channel, cur.topic);
  _edits = buildEdits(); _reactions = buildReactions(); _votes = buildVotes(); _submits = buildSubmits(); _avail = buildAvail(); _taskstat = buildTaskStat(); _acks = buildAcks();
  messages.innerHTML = '';
  if (!view.msgs.length) {
    const emptyMsg = isDMChannel(cur.channel)
      ? esc(knownUser(dmPartnerId(cur.channel)).name) + ' 님과 1:1 대화를 시작해보세요.'
      : '“' + esc(cur.topic) + '” 주제의 첫 메시지를 작성해보세요.';
    messages.innerHTML = '<div class="ov-empty">' + emptyMsg + '</div>';
    return;
  }
  let prev = null;
  for (const m of view.msgs) { appendOne(m, prev); prev = m; }
  scrollBottom();
}
function appendMsg(m) {
  if (!view.msgs.length) messages.innerHTML = '';
  _edits = buildEdits(); _reactions = buildReactions(); _votes = buildVotes(); _submits = buildSubmits(); _avail = buildAvail(); _taskstat = buildTaskStat(); _acks = buildAcks();
  const prev = view.msgs[view.msgs.length - 1] || null;
  view.msgs.push(m);
  appendOne(m, prev);
}
function appendOne(m, prev) {
  if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
    const sep = document.createElement('div');
    sep.className = 'day-sep'; sep.innerHTML = '<span>' + dayLabel(m.ts) + '</span>';
    messages.appendChild(sep);
    prev = null;
  }
  const grouped = prev && prev.author && m.author && prev.author.id === m.author.id && (m.ts - prev.ts < 5 * 60 * 1000);
  const mine = me && m.author && m.author.id === me.id;
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '');
  if (!grouped) {
    const av = document.createElement('div');
    av.className = 'avatar'; av.style.background = (m.author && m.author.color) || '#888';
    av.textContent = initial(m.author && m.author.name);
    wrap.appendChild(av);
  } else {
    const sp = document.createElement('div'); sp.className = 'spacer'; wrap.appendChild(sp);
  }
  const body = document.createElement('div'); body.className = 'msg-body';
  if (!grouped) {
    const meta = document.createElement('div'); meta.className = 'msg-meta';
    meta.innerHTML = '<span class="name">' + esc(m.author ? m.author.name : '') + '</span><span class="time">' + fmtTime(m.ts) + '</span>';
    body.appendChild(meta);
  }
  const bubble = document.createElement('div'); bubble.className = 'bubble' + (m.image && !m.text ? ' img-only' : '');
  let html = '';
  if (m.file) html += fileCardHtml(m.file);
  const _ed = _edits[m.id];
  const _dispText = _ed ? _ed.text : (m.text || '');
  if (_dispText) html += '<div class="msg-text">' + highlightMentions(renderText(_dispText), m.mentions) + (_ed ? ' <span class="edited-mark">(편집됨)</span>' : '') + '</div>';
  bubble.innerHTML = html;
  // 이미지는 src 를 HTML 문자열이 아니라 DOM 속성으로 지정(XSS 방지) + data:image/ 검증
  if (m.image && typeof m.image === 'string' && m.image.indexOf('data:image/') === 0) {
    const im = document.createElement('img');
    im.className = 'msg-img'; im.alt = '이미지'; im.src = m.image;
    if (m.imw && m.imh) im.style.aspectRatio = m.imw + ' / ' + m.imh;
    im.onclick = () => openImageFull(m.image);
    bubble.insertBefore(im, bubble.firstChild);
  }
  if (m.replyTo && recs[m.replyTo]) {
    const rt = recs[m.replyTo];
    const q = document.createElement('div'); q.className = 'reply-quote';
    q.textContent = '↩ ' + ((rt.author && rt.author.name) || '?') + ': ' + msgPreview(rt).slice(0, 60);
    q.onclick = (e) => { e.stopPropagation(); jumpToMsg(m.replyTo); };
    bubble.insertBefore(q, bubble.firstChild);
  }
  if (m.poll) bubble.appendChild(renderPollCard(m));
  if (m.intake) bubble.appendChild(renderIntakeCard(m));
  if (m.sched) bubble.appendChild(renderSchedCard(m));
  if (m.task) bubble.appendChild(renderTaskCard(m));
  body.appendChild(bubble);
  const card = bubble.querySelector('.file-card');
  if (card && m.file) card.onclick = () => downloadFile(m.file);
  const rx = _reactions[m.id];
  if (rx && Object.keys(rx).length) {
    const row = document.createElement('div'); row.className = 'reactions';
    for (const emoji of Object.keys(rx)) {
      const set = rx[emoji]; if (!set || !set.size) continue;
      const chip = document.createElement('button'); chip.type = 'button';
      chip.className = 'rx-chip' + (me && set.has(me.id) ? ' mine' : '');
      chip.textContent = emoji + ' ' + set.size;
      chip.onclick = () => socket.emit('react', { target: m.id, emoji: emoji });
      row.appendChild(chip);
    }
    body.appendChild(row);
  }
  const acks = _acks[m.id];
  if (acks && acks.size) {
    const arow = document.createElement('div'); arow.className = 'ack-row';
    const chip = document.createElement('button'); chip.type = 'button';
    chip.className = 'ack-chip' + (me && acks.has(me.id) ? ' mine' : '');
    chip.textContent = '✓ ' + acks.size + ' 확인';
    chip.title = ackTitle(m, acks);
    chip.onclick = () => socket.emit('ack', { target: m.id });
    arow.appendChild(chip); body.appendChild(arow);
  }
  wrap.appendChild(body);
  wrap.dataset.id = m.id;
  const ctrl = document.createElement('div'); ctrl.className = 'msg-ctrl';
  const addRx = document.createElement('button');
  addRx.type = 'button'; addRx.className = 'msg-ctrl-btn'; addRx.title = '리액션'; addRx.textContent = '😊';
  addRx.onclick = (e) => { e.stopPropagation(); openReactionPicker(addRx, m.id); };
  ctrl.appendChild(addRx);
  const ackBtn = document.createElement('button');
  ackBtn.type = 'button'; ackBtn.className = 'msg-ctrl-btn' + (me && _acks[m.id] && _acks[m.id].has(me.id) ? ' on' : ''); ackBtn.title = '확인했음'; ackBtn.textContent = '✓';
  ackBtn.onclick = (e) => { e.stopPropagation(); socket.emit('ack', { target: m.id }); };
  ctrl.appendChild(ackBtn);
  const reBtn = document.createElement('button');
  reBtn.type = 'button'; reBtn.className = 'msg-ctrl-btn'; reBtn.title = '답글'; reBtn.textContent = '↩';
  reBtn.onclick = (e) => { e.stopPropagation(); setReplyTarget(m); };
  ctrl.appendChild(reBtn);
  if (mine && (m.text || _edits[m.id])) {
    const ebtn = document.createElement('button');
    ebtn.type = 'button'; ebtn.className = 'msg-ctrl-btn'; ebtn.title = '수정'; ebtn.textContent = '✏';
    ebtn.onclick = (e) => { e.stopPropagation(); startEdit(m, bubble); };
    ctrl.appendChild(ebtn);
  }
  if (mine) {
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'msg-ctrl-btn'; del.title = '회수'; del.textContent = '🗑';
    del.onclick = () => { if (confirm('이 메시지를 회수할까요? 모두에게서 사라집니다.')) socket.emit('deleteMsg', m.id); };
    ctrl.appendChild(del);
  }
  wrap.appendChild(ctrl);
  messages.appendChild(wrap);
}
function openImageFull(dataUrl) {
  try { fetch(dataUrl).then((r) => r.blob()).then((b) => window.open(URL.createObjectURL(b), '_blank')); }
  catch (e) { window.open(dataUrl, '_blank'); }
}
function fileCardHtml(f) {
  const hint = f.large ? '받기 (보낸 사람 PC에서)' : '클릭하여 받기';
  return '<div class="file-card"><span class="fc-icon">📄</span>' +
    '<span class="fc-info"><span class="fc-name">' + esc(f.name || '파일') + '</span>' +
    '<span class="fc-size">' + fmtSize(f.size) + ' · ' + hint + '</span></span></div>';
}
function triggerSave(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = name || 'file';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}
async function downloadFile(f) {
  try {
    if (f.large && f.fileId) {
      const res = await fetch('/file/' + encodeURIComponent(f.fileId) + '?name=' + encodeURIComponent(f.name || 'file'));
      if (!res.ok) { alert((await res.text()) || '다운로드에 실패했습니다.'); return; }
      triggerSave(await res.blob(), f.name);
    } else {
      triggerSave(await fetch(f.data).then((r) => r.blob()), f.name);
    }
  } catch (e) { alert('다운로드에 실패했습니다.'); }
}

function isNearBottom() { return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160; }
function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

// ====================================================================
// 입력 / 전송
// ====================================================================
function sendCurrent() {
  if (cur.topic == null) return;
  const text = msgInput.value;
  if (!text.trim()) return;
  const payload = { channel: cur.channel, topic: cur.topic, text: text, mentions: resolveMentions(text) };
  if (replyTo) payload.replyTo = replyTo;
  socket.emit('send', payload);
  msgInput.value = ''; clearReply(); autoGrow();
}
composer.addEventListener('submit', (e) => { e.preventDefault(); sendCurrent(); });
// IME(한글 등) 조합 중 Enter: 글자 중복을 막고, 조합이 확정된 직후 한 번에 전송한다.
let imeEnterAt = 0;
msgInput.addEventListener('compositionend', () => {
  if (imeEnterAt && Date.now() - imeEnterAt < 1000) { imeEnterAt = 0; sendCurrent(); }
  else imeEnterAt = 0;
});
msgInput.addEventListener('keydown', (e) => {
  if (mentionState) { // @멘션 자동완성 열림: 방향키/Enter/Tab/Esc 가로채기
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.idx = (mentionState.idx + 1) % mentionState.items.length; renderMentionPop(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.idx = (mentionState.idx - 1 + mentionState.items.length) % mentionState.items.length; renderMentionPop(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && !(e.isComposing || e.keyCode === 229)) { e.preventDefault(); pickMention(mentionState.items[mentionState.idx]); return; }
  }
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229) { imeEnterAt = Date.now(); return; } // 조합 확정 후 전송
  e.preventDefault();
  sendCurrent();
});
msgInput.addEventListener('input', () => { autoGrow(); pingTyping(); updateMentionPop(); });
function autoGrow() { msgInput.style.height = 'auto'; msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px'; }

// 이모지
emojiBtn.onclick = (e) => {
  e.stopPropagation();
  if (!emojiPop.dataset.built) {
    EMOJIS.forEach((em) => {
      const s = document.createElement('span'); s.textContent = em;
      s.onclick = () => { insertAtCursor(em); emojiPop.classList.add('hidden'); };
      emojiPop.appendChild(s);
    });
    emojiPop.dataset.built = '1';
  }
  emojiPop.classList.toggle('hidden');
};
emojiPop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => emojiPop.classList.add('hidden'));
function insertAtCursor(t) {
  const i = msgInput, s = i.selectionStart, e = i.selectionEnd;
  i.value = i.value.slice(0, s) + t + i.value.slice(e);
  i.selectionStart = i.selectionEnd = s + t.length;
  i.focus(); autoGrow();
}

// ====================================================================
// 이미지 공유 (드래그앤드롭 · 붙여넣기 · 버튼) — 축소 후 메시지에 담아 전파
// ====================================================================
function processImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { reject(new Error('이미지 파일이 아닙니다.')); return; }
    if (file.size > 25 * 1024 * 1024) { reject(new Error('이미지가 너무 큽니다 (25MB 초과).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { reject(new Error('이미지 크기를 읽을 수 없습니다.')); return; }
      const max = 1600;
      if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (dataUrl.length > 4 * 1024 * 1024) dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      resolve({ dataUrl: dataUrl, w: w, h: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 불러올 수 없습니다.')); };
    img.src = url;
  });
}
async function sendImage(file) {
  if (cur.topic == null) { alert('이미지를 보낼 주제를 먼저 선택(또는 생성)하세요.'); return; }
  try {
    const r = await processImage(file);
    socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', image: r.dataUrl, imw: r.w, imh: r.h });
  } catch (e) { alert(e.message || '이미지 전송에 실패했습니다.'); }
}
function handleImageFiles(fileList) {
  const files = Array.prototype.filter.call(fileList || [], (f) => f.type && f.type.indexOf('image/') === 0);
  if (!files.length) return;
  if (cur.topic == null) { alert('이미지를 보낼 주제를 먼저 선택(또는 생성)하세요.'); return; }
  files.forEach((f) => sendImage(f));
}
imgBtn.onclick = () => imgInput.click();
imgInput.onchange = () => { handleImageFiles(imgInput.files); imgInput.value = ''; };

// 일반 파일(zip 등) 전송 — 메시지에 담아 전파(임베드), 최대 20MB
async function sendFile(file) {
  if (cur.topic == null) { alert('파일을 보낼 주제를 먼저 선택(또는 생성)하세요.'); return; }
  if (file.size >= 200 * 1024 * 1024) { alert('파일이 너무 큽니다 (최대 200MB).'); return; }
  try {
    if (file.size < 20 * 1024 * 1024) {
      // 작은 파일(<20MB): 메시지에 담아 전체 복제 → 누구나 바로 받기
      const data = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error('파일을 읽을 수 없습니다.'));
        fr.readAsDataURL(file);
      });
      socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', file: { name: file.name, size: file.size, mime: file.type || 'application/octet-stream', data: data } });
    } else {
      // 대용량(>=20MB): 내 노드에 업로드 → 메타데이터만 전파(받을 때 보낸 사람 PC에서 가져감)
      const res = await fetch('/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!res.ok) throw new Error('업로드 실패');
      const j = await res.json();
      socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', file: { name: file.name, size: file.size, mime: file.type || 'application/octet-stream', fileId: j.fileId, large: true } });
    }
  } catch (e) { alert(e.message || '파일 전송에 실패했습니다.'); }
}
// 드롭: 이미지는 인라인(자동 축소), 그 외 파일은 다운로드 카드로
function handleDroppedFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return;
  if (cur.topic == null) { alert('보낼 주제를 먼저 선택(또는 생성)하세요.'); return; }
  files.forEach((f) => { if (f.type && f.type.indexOf('image/') === 0) sendImage(f); else sendFile(f); });
}
fileBtn.onclick = () => fileInput.click();
fileInput.onchange = () => { Array.prototype.forEach.call(fileInput.files || [], (f) => sendFile(f)); fileInput.value = ''; };

// 붙여넣기(Ctrl/⌘+V)는 "입력창에 포커스가 있을 때만" 동작한다.
// 스크린샷 복사(items)와 탐색기에서 이미지 파일 복사(files) 모두 인식.
msgInput.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  let imgs = [];
  if (dt.files && dt.files.length) {
    for (const f of dt.files) if (f && f.type && f.type.indexOf('image/') === 0) imgs.push(f);
  }
  if (!imgs.length && dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) { const f = it.getAsFile(); if (f) imgs.push(f); }
    }
  }
  if (!imgs.length) return; // 이미지가 아니면 일반 텍스트 붙여넣기는 그대로 유지
  e.preventDefault();
  imgs.forEach((f) => sendImage(f));
});
let dragDepth = 0;
function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
document.addEventListener('dragenter', (e) => {
  if (!me || !hasFiles(e)) return;
  dragDepth++;
  if (cur.topic != null) dropOverlay.classList.remove('hidden');
});
document.addEventListener('dragover', (e) => { if (me && hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', (e) => {
  if (!me || !hasFiles(e)) return;
  dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add('hidden'); }
});
document.addEventListener('drop', (e) => {
  if (!me || !hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; dropOverlay.classList.add('hidden');
  handleDroppedFiles(e.dataTransfer.files);
});

// ====================================================================
// 알림
// ====================================================================
let actx = null;
function enableAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
}
function playBeep() {
  if (!actx) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.type = 'sine'; o.frequency.value = 680;
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.3);
    o.start(); o.stop(actx.currentTime + 0.31);
  } catch (e) {}
}
function requestNotify() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {} }
function notify(r, mentionedMe) {
  playBeep();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const body = (r.file && !r.text) ? ('📎 ' + (r.file.name || '파일')) : (r.image && !r.text) ? '🖼 사진' : String(r.text || '').slice(0, 120);
      const dm = isDMChannel(r.channel);
      let title = dm ? ((r.author ? r.author.name : '') + ' · 1:1 메시지') : ((r.author ? r.author.name : '') + ' · ' + channelName(r.channel) + ' › ' + r.topic);
      if (mentionedMe) title = '🔔 멘션 · ' + title;
      const n = new Notification(title, { body: body });
      n.onclick = () => { window.focus(); if (dm) openDM(dmPartnerId(r.channel)); else openTopic(r.channel, r.topic); n.close(); };
    } catch (e) {}
  }
}
window.addEventListener('focus', () => {
  if (me && cur.topic != null) { unread[key(cur.channel, cur.topic)] = 0; renderSidebar(); updateTitle(); }
});

// ====================================================================
// 모달 (새 채널 / 새 주제) · 사이드바(모바일)
// ====================================================================
let modalMode = 'channel';
function openModal(mode) {
  modalMode = mode;
  modalTitle.textContent = mode === 'channel' ? '새 채널 만들기' : '새 주제 시작';
  modalInput.placeholder = mode === 'channel' ? '채널 이름' : '주제 이름';
  modalInput.value = '';
  modal.classList.remove('hidden');
  modalInput.focus();
}
function openNewTopic() { openModal('topic'); }
addChannelBtn.onclick = () => openModal('channel');
modalCancel.onclick = () => modal.classList.add('hidden');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
modalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = modalInput.value.trim();
  modal.classList.add('hidden');
  if (!v) return;
  if (modalMode === 'channel') socket.emit('createChannel', v);
  else openTopic(cur.channel, v.slice(0, 60));
});

function openSidebar() { appEl.classList.add('sidebar-open'); sidebarBackdrop.classList.remove('hidden'); }
function closeSidebarMobile() { appEl.classList.remove('sidebar-open'); sidebarBackdrop.classList.add('hidden'); }
menuBtn.onclick = openSidebar;
sidebarBackdrop.onclick = closeSidebarMobile;

// ====================================================================
// AI 요약
// ====================================================================
function msgsForSummary(list) {
  return list.filter((m) => m.type !== 'system').map((m) => ({
    from: (m.author && m.author.name) || '?',
    text: m.text || (m.image ? '[사진]' : m.file ? '[파일: ' + (m.file.name || '') + ']' : ''),
  })).filter((m) => m.text);
}
function showSummary(title, text) {
  summaryTitle.textContent = title;
  summaryBody.textContent = text;
  summaryModal.classList.remove('hidden');
}
async function summarizeMessages(list, title) {
  const msgs = msgsForSummary(list);
  if (!msgs.length) { showSummary(title, '요약할 메시지가 없습니다.'); return; }
  showSummary(title, '요약하는 중… ⏳');
  try {
    const res = await fetch('/summarize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title, messages: msgs }) });
    const j = await res.json();
    showSummary(title, j.summary || '(요약 결과 없음)');
  } catch (e) { showSummary(title, '요약 요청 실패: ' + e.message); }
}
summaryClose.onclick = () => summaryModal.classList.add('hidden');
summaryModal.addEventListener('click', (e) => { if (e.target === summaryModal) summaryModal.classList.add('hidden'); });

// ====================================================================
// 멘션 / 리액션 / 인라인 수정
// ====================================================================
function highlightMentions(html, mentionIds) {
  if (!Array.isArray(mentionIds) || !mentionIds.length) return html;
  const names = [];
  for (const id of mentionIds) { const u = knownUser(id); if (u && u.name) names.push({ token: '@' + esc(u.name), cls: (me && id === me.id) ? 'mention me-mention' : 'mention' }); }
  if (!names.length) return html;
  names.sort((a, b) => b.token.length - a.token.length);
  let out = '', i = 0;
  while (i < html.length) {
    if (html[i] === '<') { // 태그(<a href> 등)는 건드리지 않고 통과
      const end = html.indexOf('>', i);
      if (end === -1) { out += html.slice(i); break; }
      out += html.slice(i, end + 1); i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      let seg = next === -1 ? html.slice(i) : html.slice(i, next);
      for (const n of names) seg = seg.split(n.token).join('<span class="' + n.cls + '">' + n.token + '</span>');
      out += seg; i = next === -1 ? html.length : next;
    }
  }
  return out;
}
function resolveMentions(text) {
  const ids = [];
  const cands = (me ? [me] : []).concat(peers).filter((u) => u && u.name);
  cands.sort((a, b) => b.name.length - a.name.length);
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@') {
      const rest = text.slice(i + 1);
      let hit = null;
      for (const c of cands) { if (rest.indexOf(c.name) === 0) { hit = c; break; } }
      if (hit) { if (ids.indexOf(hit.id) === -1) ids.push(hit.id); i += 1 + hit.name.length; continue; }
    }
    i++;
  }
  return ids;
}
function openReactionPicker(anchor, msgId) {
  closeReactionPicker();
  const pop = document.createElement('div'); pop.className = 'rx-pop'; pop.id = 'rx-pop';
  REACTIONS.forEach((em) => {
    const s = document.createElement('button'); s.type = 'button'; s.textContent = em;
    s.onclick = (e) => { e.stopPropagation(); socket.emit('react', { target: msgId, emoji: em }); closeReactionPicker(); };
    pop.appendChild(s);
  });
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 230, r.left - 60)) + 'px';
  pop.style.top = Math.max(8, r.top - 46) + 'px';
}
function closeReactionPicker() { const p = document.getElementById('rx-pop'); if (p) p.remove(); }
document.addEventListener('click', closeReactionPicker);
function startEdit(m, bubble) {
  const cur0 = (_edits[m.id] ? _edits[m.id].text : m.text) || '';
  bubble.innerHTML = '';
  const ta = document.createElement('textarea'); ta.className = 'edit-ta'; ta.value = cur0;
  const bar = document.createElement('div'); bar.className = 'edit-bar';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'ub-btn'; save.textContent = '저장';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ub-btn ghost'; cancel.textContent = '취소';
  save.onclick = () => { if (ta.value.trim()) socket.emit('editMsg', { target: m.id, text: ta.value }); else renderThread(); };
  cancel.onclick = () => renderThread();
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save.onclick(); } });
  bar.appendChild(save); bar.appendChild(cancel);
  bubble.appendChild(ta); bubble.appendChild(bar);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ====================================================================
// 검색
// ====================================================================
const searchModal = $('search-modal'), searchInput = $('search-input'), searchResults = $('search-results'), searchBtn = $('search-btn'), searchClose = $('search-close');
function safeName(s) { let out = ''; for (const ch of String(s)) out += /[a-zA-Z0-9가-힣._-]/.test(ch) ? ch : '_'; return out; }
function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q);
  const start = Math.max(0, i - 30);
  const seg = text.slice(start, i + q.length + 40);
  const escq = esc(text.substr(i, q.length));
  return (start > 0 ? '…' : '') + esc(seg).split(escq).join('<mark>' + escq + '</mark>');
}
function runSearch(q) {
  q = (q || '').trim().toLowerCase();
  searchResults.innerHTML = '';
  if (!q || !me) return;
  const del = buildDeleted(); const eds = buildEdits();
  const out = [];
  for (const r of Object.values(recs)) {
    if (r.type !== 'msg' || del.has(r.id)) continue;
    if (isDMChannel(r.channel)) { if (r.channel.slice(3).split('|').indexOf(me.id) === -1) continue; }
    else if (!channels.some((c) => c.id === r.channel)) continue;
    const text = (eds[r.id] ? eds[r.id].text : r.text) || '';
    if (text.toLowerCase().indexOf(q) === -1) continue;
    out.push({ r: r, text: text });
  }
  out.sort((a, b) => b.r.ts - a.r.ts);
  if (!out.length) { searchResults.innerHTML = '<div class="ov-empty">검색 결과가 없습니다.</div>'; return; }
  out.slice(0, 200).forEach((it) => {
    const r = it.r;
    const label = isDMChannel(r.channel) ? ('@' + knownUser(dmPartnerId(r.channel)).name) : (channelName(r.channel) + ' › ' + r.topic);
    const row = document.createElement('div'); row.className = 'search-row';
    row.innerHTML = '<div class="sr-loc">' + esc(label) + ' · ' + esc((r.author && r.author.name) || '') + ' · ' + fmtAgo(r.ts) + '</div>' +
      '<div class="sr-snip">' + snippet(it.text, q) + '</div>';
    row.onclick = () => { searchModal.classList.add('hidden'); if (isDMChannel(r.channel)) openDM(dmPartnerId(r.channel)); else openTopic(r.channel, r.topic); };
    searchResults.appendChild(row);
  });
}
if (searchBtn) {
  searchBtn.onclick = () => { searchModal.classList.remove('hidden'); searchInput.value = ''; searchResults.innerHTML = ''; searchInput.focus(); };
  let _stid = 0;
  searchInput.addEventListener('input', () => { clearTimeout(_stid); _stid = setTimeout(() => runSearch(searchInput.value), 120); });
  searchClose.onclick = () => searchModal.classList.add('hidden');
  searchModal.addEventListener('click', (e) => { if (e.target === searchModal) searchModal.classList.add('hidden'); });
}

// ====================================================================
// 내보내기(.txt)
// ====================================================================
function buildTopicTxt(channel, topic) {
  const list = msgsOf(channel, topic);
  const eds = buildEdits();
  const NL = String.fromCharCode(10);
  const header = isDMChannel(channel) ? ('@' + knownUser(dmPartnerId(channel)).name + ' 님과의 대화') : (channelName(channel) + ' > ' + topic);
  const lines = list.map((m) => {
    const who = (m.author && m.author.name) || '?';
    let t = (eds[m.id] ? eds[m.id].text : m.text) || '';
    if (!t && m.image) t = '[사진]';
    if (!t && m.file) t = '[파일: ' + (m.file.name || '') + ']';
    return '[' + dayLabel(m.ts) + ' ' + fmtTime(m.ts) + '] ' + who + ': ' + t;
  });
  return header + NL + '========================================' + NL + NL + lines.join(NL) + NL;
}
function exportTopicTxt() {
  const base = isDMChannel(cur.channel) ? ('DM-' + knownUser(dmPartnerId(cur.channel)).name) : (channelName(cur.channel) + '-' + cur.topic);
  triggerSave(new Blob([buildTopicTxt(cur.channel, cur.topic)], { type: 'text/plain;charset=utf-8' }), safeName(base) + '.txt');
}

// ====================================================================
// 입력 중 표시(타이핑)
// ====================================================================
let _lastTypingAt = 0;
function pingTyping() {
  if (cur.topic == null) return;
  const now = Date.now();
  if (now - _lastTypingAt < 1000) return;
  _lastTypingAt = now;
  socket.emit('typing', { channel: cur.channel });
}
socket.on('peerTyping', (d) => {
  if (!d || !d.id || (me && d.id === me.id)) return;
  typingUsers.set(d.id, { name: d.name, channel: d.channel, exp: Date.now() + 3000 });
  renderTyping();
});
function renderTyping() {
  const now = Date.now();
  const names = [];
  for (const [id, u] of typingUsers) {
    if (u.exp <= now) { typingUsers.delete(id); continue; }
    if (u.channel === cur.channel && cur.topic != null) names.push(u.name);
  }
  if (names.length) { typingBar.textContent = names.slice(0, 3).join(', ') + ' 님이 입력 중…'; typingBar.classList.remove('hidden'); }
  else typingBar.classList.add('hidden');
}
setInterval(renderTyping, 1000);

// ====================================================================
// 투표(poll)
// ====================================================================
function renderPollCard(m) {
  const poll = m.poll || {};
  const opts = Array.isArray(poll.opts) ? poll.opts : [];
  const tally = _votes[m.id] || {};
  const counts = opts.map((_, i) => (tally[i] ? tally[i].size : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const maxc = Math.max(1, Math.max.apply(null, counts.concat([0])));
  const card = document.createElement('div'); card.className = 'poll-card';
  const q = document.createElement('div'); q.className = 'poll-q'; q.textContent = '📊 ' + (poll.q || '');
  card.appendChild(q);
  opts.forEach((opt, i) => {
    const cnt = counts[i];
    const mineVoted = !!(me && tally[i] && tally[i].has(me.id));
    const row = document.createElement('button'); row.type = 'button';
    row.className = 'poll-opt' + (mineVoted ? ' voted' : '');
    const bar = document.createElement('span'); bar.className = 'poll-bar'; bar.style.width = Math.round(cnt / maxc * 100) + '%';
    const lbl = document.createElement('span'); lbl.className = 'poll-opt-label'; lbl.textContent = (mineVoted ? '☑ ' : '') + opt;
    const num = document.createElement('span'); num.className = 'poll-opt-count'; num.textContent = cnt;
    row.appendChild(bar); row.appendChild(lbl); row.appendChild(num);
    row.onclick = () => socket.emit('vote', { target: m.id, opt: (!poll.multi && mineVoted) ? -1 : i });
    card.appendChild(row);
  });
  const foot = document.createElement('div'); foot.className = 'poll-foot';
  foot.textContent = (poll.multi ? '복수 선택 가능 · ' : '') + '총 ' + total + '표';
  card.appendChild(foot);
  return card;
}
const pollModal = $('poll-modal'), pollQ = $('poll-q'), pollOptsEl = $('poll-opts'), pollMulti = $('poll-multi'), pollBtn = $('poll-btn');
function addPollOptInput(val) {
  if (!pollOptsEl || pollOptsEl.children.length >= 10) return;
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'poll-opt-input';
  inp.placeholder = '선택지 ' + (pollOptsEl.children.length + 1); inp.maxLength = 100; if (val) inp.value = val;
  pollOptsEl.appendChild(inp);
}
function openPollModal() {
  if (cur.topic == null) { alert('투표는 주제나 1:1 대화를 먼저 연 뒤 만들 수 있어요.'); return; }
  pollQ.value = ''; pollMulti.checked = false; pollOptsEl.innerHTML = '';
  addPollOptInput(); addPollOptInput();
  pollModal.classList.remove('hidden'); pollQ.focus();
}
if (pollBtn) {
  pollBtn.onclick = openPollModal;
  $('poll-add').onclick = () => addPollOptInput();
  $('poll-close').onclick = () => pollModal.classList.add('hidden');
  $('poll-cancel').onclick = () => pollModal.classList.add('hidden');
  pollModal.addEventListener('click', (e) => { if (e.target === pollModal) pollModal.classList.add('hidden'); });
  $('poll-create').onclick = () => {
    const q = pollQ.value.trim();
    const opts = [].map.call(pollOptsEl.children, (i) => i.value.trim()).filter(Boolean);
    if (!q) { alert('질문을 입력하세요.'); return; }
    if (opts.length < 2) { alert('선택지를 2개 이상 입력하세요.'); return; }
    socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', poll: { q: q, opts: opts, multi: pollMulti.checked } });
    pollModal.classList.add('hidden');
  };
}

// ====================================================================
// 수합(intake)
// ====================================================================
const intakeModal = $('intake-modal'), intakeBtn = $('intake-btn'), intakeOptsWrap = $('intake-opts-wrap'), intakeOptsEl = $('intake-opts');
function fmtDue(ts) { try { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (e) { return ''; } }
function intakeExpected(channel) { return isDMChannel(channel) ? channel.slice(3).split('|').map(knownUser) : roster(); }
function renderIntakeCard(m) {
  const ia = m.intake || {};
  const subs = _submits[m.id] || {};
  const responders = Object.keys(subs);
  const all = intakeExpected(m.channel);
  const missing = all.filter((u) => responders.indexOf(u.id) === -1);
  const mineSub = me ? subs[me.id] : null;
  const card = document.createElement('div'); card.className = 'intake-card';
  const head = document.createElement('div'); head.className = 'intake-head'; head.textContent = '📥 ' + (ia.title || '');
  card.appendChild(head);
  if (ia.prompt) { const p = document.createElement('div'); p.className = 'intake-prompt'; p.textContent = ia.prompt; card.appendChild(p); }
  if (ia.due) { const d = document.createElement('div'); d.className = 'intake-due'; d.textContent = (ia.due < Date.now() ? '⛔ 마감됨: ' : '⏰ 마감: ') + fmtDue(ia.due); card.appendChild(d); }
  const resp = document.createElement('div'); resp.className = 'intake-respond';
  if (ia.kind === 'choice') {
    (ia.opts || []).forEach((opt, i) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'intake-opt' + (mineSub && mineSub.opt === i ? ' chosen' : '');
      b.textContent = (mineSub && mineSub.opt === i ? '☑ ' : '') + opt;
      b.onclick = () => socket.emit('submit', { target: m.id, opt: i });
      resp.appendChild(b);
    });
  } else {
    const ta = document.createElement('textarea'); ta.className = 'intake-text'; ta.placeholder = '응답 입력…'; if (mineSub) ta.value = mineSub.text || '';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ub-btn'; btn.textContent = mineSub ? '응답 수정' : '응답 제출';
    btn.onclick = () => { if (ta.value.trim()) socket.emit('submit', { target: m.id, text: ta.value }); };
    resp.appendChild(ta); resp.appendChild(btn);
  }
  card.appendChild(resp);
  const status = document.createElement('div'); status.className = 'intake-status';
  status.textContent = missing.length
    ? ('제출 ' + responders.length + ' / ' + all.length + ' · 미제출: ' + missing.slice(0, 8).map((u) => u.name).join(', ') + (missing.length > 8 ? (' 외 ' + (missing.length - 8) + '명') : ''))
    : ('제출 ' + responders.length + ' / ' + all.length + ' · 전원 제출 완료 ✅');
  card.appendChild(status);
  const det = document.createElement('details'); det.className = 'intake-detail';
  const sm = document.createElement('summary'); sm.textContent = '응답 보기 (' + responders.length + ')'; det.appendChild(sm);
  responders.forEach((aid) => {
    const s = subs[aid]; const u = knownUser(aid);
    const ans = (ia.kind === 'choice') ? ((ia.opts || [])[s.opt] || '?') : (s.text || '');
    const row = document.createElement('div'); row.className = 'intake-resp-row';
    const nm = document.createElement('b'); nm.textContent = u.name + ': ';
    const sp = document.createElement('span'); sp.textContent = ans;
    row.appendChild(nm); row.appendChild(sp); det.appendChild(row);
  });
  const exp = document.createElement('button'); exp.type = 'button'; exp.className = 'btn-ghost-sm'; exp.style.marginTop = '6px'; exp.textContent = '⬇ 결과 내보내기';
  exp.onclick = () => exportIntake(m);
  det.appendChild(exp);
  card.appendChild(det);
  return card;
}
function exportIntake(m) {
  const ia = m.intake || {}; const subs = _submits[m.id] || {};
  const all = intakeExpected(m.channel);
  const NL = String.fromCharCode(10);
  const lines = ['[수합] ' + ia.title, ia.prompt || '', '=============================', ''];
  all.forEach((u) => {
    const s = subs[u.id];
    const ans = s ? (ia.kind === 'choice' ? ((ia.opts || [])[s.opt] || '?') : (s.text || '')) : '(미제출)';
    lines.push(u.name + ': ' + ans);
  });
  triggerSave(new Blob([lines.join(NL) + NL], { type: 'text/plain;charset=utf-8' }), safeName('수합-' + ia.title) + '.txt');
}
function addIntakeOpt() { if (intakeOptsEl.children.length >= 20) return; const i = document.createElement('input'); i.type = 'text'; i.className = 'poll-opt-input'; i.placeholder = '선택지 ' + (intakeOptsEl.children.length + 1); i.maxLength = 100; intakeOptsEl.appendChild(i); }
function openIntakeModal() {
  if (cur.topic == null) { alert('수합은 주제나 1:1 대화를 먼저 연 뒤 만들 수 있어요.'); return; }
  $('intake-title').value = ''; $('intake-prompt').value = ''; $('intake-due').value = '';
  $('intake-kind-text').checked = true; intakeOptsWrap.classList.add('hidden'); intakeOptsEl.innerHTML = '';
  intakeModal.classList.remove('hidden'); $('intake-title').focus();
}
if (intakeBtn) {
  intakeBtn.onclick = openIntakeModal;
  $('intake-add').onclick = addIntakeOpt;
  $('intake-close').onclick = () => intakeModal.classList.add('hidden');
  $('intake-cancel').onclick = () => intakeModal.classList.add('hidden');
  intakeModal.addEventListener('click', (e) => { if (e.target === intakeModal) intakeModal.classList.add('hidden'); });
  document.querySelectorAll('input[name="intake-kind"]').forEach((r) => { r.onchange = () => { const c = $('intake-kind-choice').checked; intakeOptsWrap.classList.toggle('hidden', !c); if (c && !intakeOptsEl.children.length) { addIntakeOpt(); addIntakeOpt(); } }; });
  $('intake-create').onclick = () => {
    const title = $('intake-title').value.trim();
    if (!title) { alert('제목을 입력하세요.'); return; }
    const kind = $('intake-kind-choice').checked ? 'choice' : 'text';
    const intake = { title: title, prompt: $('intake-prompt').value.trim(), kind: kind };
    if (kind === 'choice') { intake.opts = [].map.call(intakeOptsEl.children, (i) => i.value.trim()).filter(Boolean); if (intake.opts.length < 2) { alert('선택지를 2개 이상 입력하세요.'); return; } }
    const dv = $('intake-due').value; if (dv) { const t = Date.parse(dv); if (t) intake.due = t; }
    socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', intake: intake });
    intakeModal.classList.add('hidden');
  };
}

// ====================================================================
// 답글 / 인용
// ====================================================================
const replyBar = $('reply-bar');
let replyTo = null;
function msgPreview(m) {
  if (!m) return '';
  const ed = _edits[m.id];
  if (ed && ed.text) return ed.text;
  if (m.text) return m.text;
  if (m.image) return '🖼 사진';
  if (m.file) return '📎 ' + (m.file.name || '파일');
  if (m.poll) return '📊 ' + (m.poll.q || '투표');
  if (m.intake) return '📥 ' + (m.intake.title || '수합');
  if (m.sched) return '📅 ' + (m.sched.title || '일정');
  if (m.task) return '📋 ' + (m.task.title || '작업');
  return '메시지';
}
function setReplyTarget(m) {
  replyTo = m.id;
  replyBar.innerHTML = '';
  const t = document.createElement('span'); t.className = 'reply-bar-txt';
  t.textContent = '↩ ' + ((m.author && m.author.name) || '?') + ' 에게 답글: ' + msgPreview(m).slice(0, 80);
  const x = document.createElement('button'); x.type = 'button'; x.className = 'reply-bar-x'; x.textContent = '✕'; x.onclick = clearReply;
  replyBar.appendChild(t); replyBar.appendChild(x);
  replyBar.classList.remove('hidden');
  msgInput.focus();
}
function clearReply() { replyTo = null; replyBar.classList.add('hidden'); replyBar.innerHTML = ''; }
function jumpToMsg(id) {
  const el = messages.querySelector('[data-id="' + id + '"]');
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('jump-hl'); setTimeout(() => el.classList.remove('jump-hl'), 1500); }
}

// ====================================================================
// 작업/담당 추적 (Task)
// ====================================================================
const TASK_LABELS = { todo: '할 일', doing: '진행 중', done: '완료' };
const taskModal = $('task-modal'), taskBtn = $('task-btn'), taskAsgEl = $('task-asg-list');
function renderTaskCard(m) {
  const tk = m.task || {};
  const stats = _taskstat[m.id] || {};
  const ids = [];
  (tk.assignees || []).forEach((id) => { if (ids.indexOf(id) === -1) ids.push(id); });
  Object.keys(stats).forEach((id) => { if (ids.indexOf(id) === -1) ids.push(id); });
  const statusOf = (id) => (stats[id] ? stats[id].status : 'todo');
  const doneCount = ids.filter((id) => statusOf(id) === 'done').length;
  const card = document.createElement('div'); card.className = 'task-card';
  const head = document.createElement('div'); head.className = 'task-head';
  head.textContent = (ids.length && doneCount === ids.length ? '✅ ' : '📋 ') + (tk.title || '');
  card.appendChild(head);
  if (tk.desc) { const d = document.createElement('div'); d.className = 'task-desc'; d.textContent = tk.desc; card.appendChild(d); }
  if (tk.due) { const d = document.createElement('div'); d.className = 'intake-due'; d.textContent = (tk.due < Date.now() ? '⛔ 기한 지남: ' : '⏰ 기한: ') + fmtDue(tk.due); card.appendChild(d); }
  ids.forEach((id) => {
    const u = knownUser(id); const st = statusOf(id);
    const row = document.createElement('div'); row.className = 'task-asg';
    const nm = document.createElement('span'); nm.className = 'task-asg-name'; nm.textContent = u.name;
    const badge = document.createElement('span'); badge.className = 'task-badge ts-' + st; badge.textContent = TASK_LABELS[st] || st;
    row.appendChild(nm); row.appendChild(badge); card.appendChild(row);
  });
  const wrap = document.createElement('div'); wrap.className = 'task-mine-wrap';
  const lbl = document.createElement('span'); lbl.className = 'task-mine-lbl'; lbl.textContent = '내 상태:';
  const mineBar = document.createElement('div'); mineBar.className = 'task-mine';
  const myst = me ? statusOf(me.id) : 'todo';
  ['todo', 'doing', 'done'].forEach((s) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'task-set ts-' + s + (me && myst === s ? ' on' : ''); b.textContent = TASK_LABELS[s];
    b.onclick = () => socket.emit('taskstat', { target: m.id, status: s });
    mineBar.appendChild(b);
  });
  wrap.appendChild(lbl); wrap.appendChild(mineBar); card.appendChild(wrap);
  const foot = document.createElement('div'); foot.className = 'intake-status';
  foot.textContent = ids.length ? ('완료 ' + doneCount + ' / ' + ids.length) : '담당자 없음 (각자 내 상태로 참여)';
  card.appendChild(foot);
  return card;
}
function openTaskModal() {
  if (cur.topic == null) { alert('작업은 주제나 1:1 대화를 먼저 연 뒤 만들 수 있어요.'); return; }
  $('task-title').value = ''; $('task-desc').value = ''; $('task-due').value = '';
  const cands = isDMChannel(cur.channel) ? cur.channel.slice(3).split('|').map(knownUser) : roster();
  taskAsgEl.innerHTML = '';
  cands.forEach((u) => {
    const lab = document.createElement('label'); lab.className = 'task-asg-pick';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = u.id;
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + u.name));
    taskAsgEl.appendChild(lab);
  });
  taskModal.classList.remove('hidden'); $('task-title').focus();
}
if (taskBtn) {
  taskBtn.onclick = openTaskModal;
  $('task-close').onclick = () => taskModal.classList.add('hidden');
  $('task-cancel').onclick = () => taskModal.classList.add('hidden');
  taskModal.addEventListener('click', (e) => { if (e.target === taskModal) taskModal.classList.add('hidden'); });
  $('task-create').onclick = () => {
    const title = $('task-title').value.trim();
    if (!title) { alert('제목을 입력하세요.'); return; }
    const assignees = [].slice.call(taskAsgEl.querySelectorAll('input:checked')).map((c) => c.value);
    const task = { title: title, desc: $('task-desc').value.trim(), assignees: assignees };
    const dv = $('task-due').value; if (dv) { const t = Date.parse(dv); if (t) task.due = t; }
    socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', task: task });
    taskModal.classList.add('hidden');
  };
}

// ====================================================================
// 일정 조율 (when2meet)
// ====================================================================
const schedModal = $('sched-modal'), schedBtn = $('sched-btn'), schedSlotsEl = $('sched-slots');
const WDAY = ['일', '월', '화', '수', '목', '금', '토'];
function fmtSlotLabel(v) {
  const d = new Date(v); if (isNaN(d.getTime())) return String(v);
  return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WDAY[d.getDay()] + ') ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function renderSchedCard(m) {
  const sc = m.sched || {}; const slots = sc.slots || [];
  const av = _avail[m.id] || {};
  const responders = Object.keys(av);
  const all = intakeExpected(m.channel);
  const missing = all.filter((u) => responders.indexOf(u.id) === -1);
  const counts = slots.map(() => []);
  for (const aid of responders) for (const i of av[aid].slots) if (i >= 0 && i < slots.length) counts[i].push(aid);
  const maxc = Math.max(0, Math.max.apply(null, counts.map((c) => c.length).concat([0])));
  const mineSet = {}; if (me && av[me.id]) av[me.id].slots.forEach((i) => { mineSet[i] = 1; });
  const card = document.createElement('div'); card.className = 'sched-card';
  const head = document.createElement('div'); head.className = 'sched-head'; head.textContent = '📅 ' + (sc.title || '');
  card.appendChild(head);
  if (sc.due) { const d = document.createElement('div'); d.className = 'intake-due'; d.textContent = (sc.due < Date.now() ? '⛔ 마감됨: ' : '⏰ 마감: ') + fmtDue(sc.due); card.appendChild(d); }
  if (maxc > 0) {
    const best = []; counts.forEach((c, i) => { if (c.length === maxc) best.push(slots[i]); });
    const b = document.createElement('div'); b.className = 'sched-best'; b.textContent = '✅ 최적 시간: ' + best.join(', ') + ' (' + maxc + '명 가능)';
    card.appendChild(b);
  }
  slots.forEach((label, i) => {
    const cnt = counts[i].length;
    const row = document.createElement('button'); row.type = 'button';
    row.className = 'sched-slot' + (mineSet[i] ? ' mine' : '') + (cnt === maxc && maxc > 0 ? ' best' : '');
    const bar = document.createElement('span'); bar.className = 'sched-bar'; bar.style.width = (maxc ? Math.round(cnt / maxc * 100) : 0) + '%';
    const lab = document.createElement('span'); lab.className = 'sched-slot-label'; lab.textContent = (mineSet[i] ? '☑ ' : '☐ ') + label;
    const num = document.createElement('span'); num.className = 'sched-slot-count'; num.textContent = cnt + '명';
    row.appendChild(bar); row.appendChild(lab); row.appendChild(num);
    if (counts[i].length) row.title = counts[i].map((aid) => knownUser(aid).name).join(', ');
    row.onclick = () => toggleAvail(m.id, i);
    card.appendChild(row);
  });
  const status = document.createElement('div'); status.className = 'intake-status';
  status.textContent = missing.length
    ? ('응답 ' + responders.length + ' / ' + all.length + ' · 미응답: ' + missing.slice(0, 8).map((u) => u.name).join(', ') + (missing.length > 8 ? (' 외 ' + (missing.length - 8) + '명') : ''))
    : ('응답 ' + responders.length + ' / ' + all.length + ' · 전원 응답 완료 ✅');
  card.appendChild(status);
  return card;
}
function toggleAvail(schedId, slotIdx) {
  const m = recs[schedId]; if (!m || !m.sched) return;
  const av = _avail[schedId] || {};
  const mine = (me && av[me.id]) ? av[me.id].slots.slice() : [];
  const pos = mine.indexOf(slotIdx);
  if (pos === -1) mine.push(slotIdx); else mine.splice(pos, 1);
  socket.emit('avail', { target: schedId, slots: mine });
}
function openSchedModal() {
  if (cur.topic == null) { alert('일정 조율은 주제나 1:1 대화를 먼저 연 뒤 만들 수 있어요.'); return; }
  $('sched-title').value = ''; $('sched-due').value = ''; $('sched-dt').value = ''; schedSlotsEl.innerHTML = '';
  schedModal.classList.remove('hidden'); $('sched-title').focus();
}
function addSchedSlot() {
  const v = $('sched-dt').value; if (!v || schedSlotsEl.children.length >= 50) return;
  const label = fmtSlotLabel(v);
  for (const c of schedSlotsEl.children) if (c.dataset.label === label) return;
  const chip = document.createElement('span'); chip.className = 'sched-slot-chip'; chip.dataset.label = label;
  chip.textContent = label;
  const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.onclick = () => chip.remove();
  chip.appendChild(x); schedSlotsEl.appendChild(chip);
}
if (schedBtn) {
  schedBtn.onclick = openSchedModal;
  $('sched-add').onclick = addSchedSlot;
  $('sched-dt').addEventListener('change', addSchedSlot);
  $('sched-close').onclick = () => schedModal.classList.add('hidden');
  $('sched-cancel').onclick = () => schedModal.classList.add('hidden');
  schedModal.addEventListener('click', (e) => { if (e.target === schedModal) schedModal.classList.add('hidden'); });
  $('sched-create').onclick = () => {
    const title = $('sched-title').value.trim();
    if (!title) { alert('제목을 입력하세요.'); return; }
    const slots = [].map.call(schedSlotsEl.children, (c) => c.dataset.label);
    if (slots.length < 2) { alert('후보 시간대를 2개 이상 추가하세요.'); return; }
    const sched = { title: title, slots: slots };
    const dv = $('sched-due').value; if (dv) { const t = Date.parse(dv); if (t) sched.due = t; }
    socket.emit('send', { channel: cur.channel, topic: cur.topic, text: '', sched: sched });
    schedModal.classList.add('hidden');
  };
}

// ====================================================================
// 문서함(버전관리 + git식 +/- diff)
// ====================================================================
const docsModal = $('docs-modal'), docsBody = $('docs-body'), docsBtn = $('docs-btn'), docFileInput = $('doc-file-input');
const DOC_NL = String.fromCharCode(10), DOC_TAB = String.fromCharCode(9);
const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'html', 'htm', 'js', 'ts', 'css', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sql', 'yaml', 'yml', 'ini'];
let _openDocId = null, _docTargetId = null, _docTargetTitle = null;
function extLower(name) { const s = String(name); const i = s.lastIndexOf('.'); return i >= 0 ? s.slice(i + 1).toLowerCase() : ''; }
function dataUrlToBytes(u) { const i = u.indexOf(','); const b = atob(u.slice(i + 1)); const a = new Uint8Array(b.length); for (let j = 0; j < b.length; j++) a[j] = b.charCodeAt(j); return a; }
function dataUrlToBlob(u) { const i = u.indexOf(','); const mime = (u.slice(5, i).split(';')[0]) || 'application/octet-stream'; return new Blob([dataUrlToBytes(u)], { type: mime }); }
async function inflateRaw(bytes) { const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
function collapseWs(s) { return s.split(DOC_TAB).join(' ').split(' ').filter(function (x) { return x.length; }).join(' '); }
function xmlToText(xml) {
  xml = xml.split('</hp:p>').join(DOC_NL).split('</w:p>').join(DOC_NL); // 문단 경계 → 줄바꿈
  let out = '', inTag = false;
  for (let i = 0; i < xml.length; i++) { const c = xml[i]; if (c === '<') inTag = true; else if (c === '>') inTag = false; else if (!inTag) out += c; }
  out = out.split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'").split('&apos;').join("'").split('&amp;').join('&');
  return out.split(DOC_NL).map(collapseWs).filter(function (s) { return s.length; }).join(DOC_NL);
}
async function extractZipDocText(bytes, ext) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return '';
  const cnt = dv.getUint16(eocd + 10, true); let cd = dv.getUint32(eocd + 16, true);
  const texts = [];
  for (let n = 0; n < cnt; n++) {
    if (cd + 46 > bytes.length || dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const nameLen = dv.getUint16(cd + 28, true), extraLen = dv.getUint16(cd + 30, true), cmtLen = dv.getUint16(cd + 32, true);
    const lho = dv.getUint32(cd + 42, true);
    const fname = new TextDecoder('utf-8').decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    const want = (ext === 'hwpx') ? (fname.indexOf('Contents/') === 0 && fname.slice(-4) === '.xml') : (fname === 'word/document.xml');
    if (want && dv.getUint32(lho, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(lho + 26, true), lExtraLen = dv.getUint16(lho + 28, true), compSize = dv.getUint32(lho + 18, true);
      const ds = lho + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(ds, ds + compSize);
      let xb = null;
      if (method === 0) xb = comp; else if (method === 8) { try { xb = await inflateRaw(comp); } catch (e) { xb = null; } }
      if (xb) texts.push(xmlToText(new TextDecoder('utf-8').decode(xb)));
    }
    cd = cd + 46 + nameLen + extraLen + cmtLen;
  }
  return texts.join(DOC_NL);
}
async function extractText(fileObj) {
  try {
    const ext = extLower(fileObj.name); const bytes = dataUrlToBytes(fileObj.data);
    if (TEXT_EXTS.indexOf(ext) !== -1 || (fileObj.mime || '').indexOf('text/') === 0) return new TextDecoder('utf-8').decode(bytes);
    if (ext === 'hwpx' || ext === 'docx') return await extractZipDocText(bytes, ext);
  } catch (e) {}
  return '';
}
function lineDiff(aText, bText) {
  const a = String(aText || '').split(DOC_NL), b = String(bText || '').split(DOC_NL);
  const n = a.length, m = b.length;
  if (n * m > 4000000) return null;
  const dp = []; for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; } else { out.push({ t: '+', s: b[j] }); j++; } }
  while (i < n) { out.push({ t: '-', s: a[i] }); i++; }
  while (j < m) { out.push({ t: '+', s: b[j] }); j++; }
  return out;
}
function buildDocs() {
  const docs = {};
  for (const r of Object.values(recs)) { if (r.type !== 'docver' || !r.docId) continue; (docs[r.docId] || (docs[r.docId] = { docId: r.docId, versions: [] })).versions.push(r); }
  const list = [];
  for (const id in docs) { const vs = docs[id].versions.sort((a, b) => (a.ver - b.ver) || (a.ts - b.ts)); list.push({ docId: id, versions: vs, latest: vs[vs.length - 1], title: vs[vs.length - 1].title }); }
  return list.sort((a, b) => b.latest.ts - a.latest.ts);
}
function openDocs() { renderDocsList(); docsModal.classList.remove('hidden'); }
function renderDocsList() {
  _openDocId = null; docsBody.innerHTML = ''; $('docs-title').textContent = '📁 문서함';
  const docs = buildDocs();
  if (!docs.length) { docsBody.innerHTML = '<div class="ov-empty">아직 문서가 없습니다. ‘+ 새 문서’로 올려보세요.</div>'; return; }
  docs.forEach((d) => {
    const u = knownUser(d.latest.author.id);
    const row = document.createElement('div'); row.className = 'doc-row';
    row.innerHTML = '<div class="doc-row-title">' + esc(d.title) + '</div><div class="doc-row-sub">최신 v' + d.latest.ver + ' · ' + esc(u.name) + ' · ' + fmtAgo(d.latest.ts) + ' · ' + d.versions.length + '개 버전</div>';
    row.onclick = () => openDocDetail(d.docId);
    docsBody.appendChild(row);
  });
}
function findPrevVer(versions, v) { let prev = null; for (const x of versions) if (x.ver < v.ver && (!prev || x.ver > prev.ver)) prev = x; return prev; }
function openDocDetail(docId) {
  const d = buildDocs().find((x) => x.docId === docId);
  if (!d) { renderDocsList(); return; }
  _openDocId = docId; docsBody.innerHTML = ''; $('docs-title').textContent = '📄 ' + d.title;
  const bar = document.createElement('div'); bar.className = 'doc-detail-bar';
  const back = document.createElement('button'); back.className = 'btn-ghost-sm'; back.textContent = '← 목록'; back.onclick = renderDocsList;
  const nv = document.createElement('button'); nv.className = 'ub-btn'; nv.textContent = '+ 새 버전'; nv.onclick = () => pickDocFile(docId, d.title);
  bar.appendChild(back); bar.appendChild(nv); docsBody.appendChild(bar);
  d.versions.slice().reverse().forEach((v) => {
    const u = knownUser(v.author.id);
    const card = document.createElement('div'); card.className = 'doc-ver';
    const head = document.createElement('div'); head.className = 'doc-ver-head';
    head.innerHTML = '<b>v' + v.ver + '</b> · ' + esc(u.name) + ' · ' + fmtAgo(v.ts) + (v.note ? (' · ' + esc(v.note)) : '');
    card.appendChild(head);
    const acts = document.createElement('div'); acts.className = 'doc-ver-acts';
    const dl = document.createElement('button'); dl.className = 'btn-ghost-sm'; dl.textContent = '⬇ 다운로드'; dl.onclick = () => { try { triggerSave(dataUrlToBlob(v.file.data), v.file.name || '문서'); } catch (e) { alert('다운로드 실패'); } };
    acts.appendChild(dl);
    const prevV = findPrevVer(d.versions, v);
    card.appendChild(acts);
    if (prevV) {
      const diffBox = document.createElement('div'); diffBox.className = 'doc-diff hidden';
      const dbtn = document.createElement('button'); dbtn.className = 'btn-ghost-sm'; dbtn.textContent = '🔍 변경내용(v' + prevV.ver + '→v' + v.ver + ')';
      dbtn.onclick = () => { if (diffBox.classList.contains('hidden')) { renderDiffInto(diffBox, prevV, v); diffBox.classList.remove('hidden'); } else diffBox.classList.add('hidden'); };
      acts.appendChild(dbtn); card.appendChild(diffBox);
    }
    docsBody.appendChild(card);
  });
}
function renderDiffInto(box, prevV, v) {
  box.innerHTML = '';
  if (!v.text && !prevV.text) { box.innerHTML = '<div class="doc-diff-note">이 형식은 변경내용 비교를 지원하지 않습니다. (.hwpx / .docx / .txt 등에서 지원 — 한/글이면 .hwpx 로 저장하면 비교됩니다)</div>'; return; }
  const d = lineDiff(prevV.text, v.text);
  if (!d) { box.innerHTML = '<div class="doc-diff-note">문서가 너무 커서 비교를 생략했습니다.</div>'; return; }
  let add = 0, del = 0; d.forEach((ln) => { if (ln.t === '+') add++; else if (ln.t === '-') del++; });
  const sum = document.createElement('div'); sum.className = 'doc-diff-sum'; sum.textContent = '+' + add + ' 추가, −' + del + ' 삭제';
  box.appendChild(sum);
  if (add === 0 && del === 0) { const z = document.createElement('div'); z.className = 'doc-diff-note'; z.textContent = '텍스트 내용 변화 없음(서식만 변경되었을 수 있음).'; box.appendChild(z); return; }
  const body = document.createElement('div'); body.className = 'doc-diff-body';
  d.forEach((ln) => {
    if (ln.t === ' ' && !ln.s.length) return;
    const row = document.createElement('div'); row.className = 'dl ' + (ln.t === '+' ? 'dl-add' : ln.t === '-' ? 'dl-del' : 'dl-ctx');
    row.textContent = (ln.t === '+' ? '+ ' : ln.t === '-' ? '− ' : '  ') + ln.s;
    body.appendChild(row);
  });
  box.appendChild(body);
}
function pickDocFile(docId, title) { _docTargetId = docId; _docTargetTitle = title; if (docFileInput) { docFileInput.value = ''; docFileInput.click(); } }
function handleDocFile(file, docId, title) {
  if (file.size > 20 * 1024 * 1024) { alert('문서함은 20MB 이하 파일만 올릴 수 있어요.'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const ttl = docId ? title : (prompt('문서 제목', file.name) || file.name);
    if (!ttl) return;
    const note = prompt(docId ? '변경 메모(선택)' : '메모(선택)', '') || '';
    const fileObj = { name: file.name, size: file.size, mime: file.type || '', data: reader.result };
    const text = await extractText(fileObj);
    socket.emit('docpost', { docId: docId || undefined, title: ttl, note: note, file: fileObj, text: text });
    setTimeout(() => { if (docsModal && !docsModal.classList.contains('hidden')) { if (docId) openDocDetail(docId); else renderDocsList(); } }, 450);
  };
  reader.readAsDataURL(file);
}
if (docsBtn) {
  docsBtn.onclick = openDocs;
  $('docs-close').onclick = () => docsModal.classList.add('hidden');
  $('docs-new').onclick = () => pickDocFile(null, null);
  docsModal.addEventListener('click', (e) => { if (e.target === docsModal) docsModal.classList.add('hidden'); });
  if (docFileInput) docFileInput.addEventListener('change', () => { const f = docFileInput.files && docFileInput.files[0]; if (f) handleDocFile(f, _docTargetId, _docTargetTitle); });
}

// ====================================================================
// @멘션 자동완성
// ====================================================================
let mentionState = null;
const _NL = String.fromCharCode(10);
function tokenAtCursor() {
  const val = msgInput.value, pos = msgInput.selectionStart;
  let i = pos - 1;
  while (i >= 0) {
    const c = val[i];
    if (c === '@') {
      const before = i === 0 ? '' : val[i - 1];
      if (before === '' || before === ' ' || before === _NL) return { start: i, query: val.slice(i + 1, pos) };
      return null;
    }
    if (c === ' ' || c === _NL) return null;
    i--;
  }
  return null;
}
function updateMentionPop() {
  const tok = tokenAtCursor();
  if (!tok) { closeMentionPop(); return; }
  const q = tok.query.toLowerCase();
  const items = peers.filter((p) => p && p.name && p.name.toLowerCase().indexOf(q) !== -1).slice(0, 6);
  if (!items.length) { closeMentionPop(); return; }
  mentionState = { items: items, start: tok.start, idx: 0 };
  renderMentionPop();
}
function renderMentionPop() {
  if (!mentionState) return;
  let pop = document.getElementById('mention-pop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'mention-pop'; pop.className = 'mention-pop'; document.body.appendChild(pop); }
  pop.innerHTML = '';
  mentionState.items.forEach((p, i) => {
    const it = document.createElement('div'); it.className = 'mention-it' + (i === mentionState.idx ? ' active' : '');
    it.innerHTML = '<span class="avatar sm" style="background:' + safeColor(p.color) + '">' + esc(initial(p.name)) + '</span><span>' + esc(p.name) + '</span>';
    it.onmousedown = (e) => { e.preventDefault(); pickMention(p); };
    pop.appendChild(it);
  });
  const r = msgInput.getBoundingClientRect();
  pop.style.left = r.left + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
}
function closeMentionPop() { mentionState = null; const p = document.getElementById('mention-pop'); if (p) p.remove(); }
function pickMention(p) {
  if (!mentionState) return;
  const val = msgInput.value;
  const before = val.slice(0, mentionState.start);
  const after = val.slice(msgInput.selectionStart);
  const ins = '@' + p.name + ' ';
  msgInput.value = before + ins + after;
  const np = (before + ins).length;
  closeMentionPop();
  msgInput.focus();
  msgInput.setSelectionRange(np, np);
  autoGrow();
}
msgInput.addEventListener('blur', () => setTimeout(closeMentionPop, 150));

nameInput.focus();
