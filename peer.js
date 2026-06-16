'use strict';

/**
 * P2P 사내 메신저 노드 (중앙서버 없음)
 *
 *  - UDP 멀티캐스트로 같은 망의 다른 노드를 자동 발견
 *  - 발견한 노드와 TCP 메시(mesh)로 직접 연결
 *  - 메시지/채널을 gossip(epidemic broadcast)으로 전파
 *  - 새로 연결되면 anti-entropy 로 누락분을 주고받아 동기화(최종 일관성)
 *  - 각자 PC 의 브라우저는 자기 노드의 localhost UI 에만 접속
 *
 * 데이터 모델(Zulip 방식): 모든 메시지는 (채널, 주제) 쌍에 속한다.
 *
 * 실행: node peer.js   (start.bat 가 대신 실행 + 브라우저 열기)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// .env 로드(있으면): 의존성 없이 KEY=VALUE 파싱. 이미 지정된 환경변수가 우선.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf-8').split(String.fromCharCode(10))) {
      const t = raw.trim();
      if (!t || t[0] === '#') continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
    }
  }
} catch (e) {}

// ---------- 설정 ----------
const WEB_PORT = Number(process.env.PORT) || 34567;         // 브라우저 UI (localhost 전용, 사용 중이면 자동으로 다음 포트)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DISCOVERY_ADDR = process.env.DISCOVERY_ADDR || '239.255.41.42';
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT) || 50505;
const HELLO_INTERVAL = 3000;
const PEER_TIMEOUT = 12000;
const MAX_TEXT = 4000;
const REACTION_SET = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

const ID_FILE = path.join(DATA_DIR, 'identity.json');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const FILES_DIR = path.join(DATA_DIR, 'files');   // 대용량 파일 원본/캐시 보관

const EMBED_MAX = 20 * 1024 * 1024;   // 이 미만은 메시지에 임베드(전체 복제)
const LARGE_MAX = 200 * 1024 * 1024;  // 이 이상은 거부
const CHUNK = 256 * 1024;             // 메시 파일 전송 청크 크기

// AI 요약용 LLM: 로컬 Ollama(gemma3:4b). 요약 대화가 외부로 나가지 않고, 배포본에 API 키가 없습니다.
// 각 PC에 Ollama 설치 + `ollama pull gemma3:4b` 필요. 환경변수(LLM_URL/LLM_KEY/LLM_MODEL/LLM_PROVIDER)로 덮어쓸 수 있습니다.
// (중앙 Ollama 1대를 함께 쓰려면 LLM_URL 을 http://<그-PC>:11434/v1/chat/completions 로 설정)
const LLM_URL = process.env.LLM_URL || 'http://localhost:11434/v1/chat/completions';
const LLM_KEY = process.env.LLM_KEY || 'ollama';
const LLM_MODEL = process.env.LLM_MODEL || 'gemma3:4b';
const LLM_PROVIDER = process.env.LLM_PROVIDER || (LLM_URL.indexOf('anthropic') !== -1 ? 'anthropic' : 'openai');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- 정체성(노드 ID + 이름/색) ----------
let identity;
try { identity = JSON.parse(fs.readFileSync(ID_FILE, 'utf8')); } catch { identity = {}; }
if (!identity.id) identity.id = crypto.randomUUID();
if (!('name' in identity)) identity.name = null;
if (!('color' in identity)) identity.color = null;
function saveIdentity() { try { fs.writeFileSync(ID_FILE, JSON.stringify(identity)); } catch {} }
saveIdentity();
const myId = identity.id;

// ---------- 저장소(records: 채널/메시지) ----------
const DEFAULT_CHANNELS = [
  { id: 'ch-general', name: '전체' },
  { id: 'ch-random', name: '잡담' },
  { id: 'ch-work', name: '업무' },
];
let store = { records: {}, clock: 0 };
try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { store = { records: {}, clock: 0 }; }
if (!store.records) store.records = {};
if (!store.clock) store.clock = 0;
// 기본 채널 보장(고정 id 라 다른 노드와 자동 병합됨)
for (const c of DEFAULT_CHANNELS) {
  if (!store.records[c.id]) {
    store.records[c.id] = { id: c.id, type: 'channel', name: c.name, ts: 0, lc: 0, author: 'system' };
  }
}
let storeDirty = false;
function markDirty() { storeDirty = true; }
function flush() {
  if (!storeDirty) return;
  storeDirty = false;
  try { const tmp = STORE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, STORE_FILE); } catch (e) { console.error('저장 실패:', e.message); }
}
setInterval(flush, 1500);

function nextClock() { store.clock += 1; return store.clock; }
function bumpClock(lc) { if (lc > store.clock) store.clock = lc; }

function channelsList() {
  return Object.values(store.records)
    .filter((r) => r.type === 'channel')
    .sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id))
    .map((r) => ({ id: r.id, name: r.name }));
}
function allRecords() { return Object.values(store.records); }

// ===================================================================
// 로컬 UI 서버 (브라우저 <-> 자기 노드)
// ===================================================================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 대용량 파일 업로드: 내 노드 디스크(data/files)에 저장하고 fileId 반환
app.post('/upload', (req, res) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len > LARGE_MAX) { res.status(413).json({ error: 'too large' }); return; }
  const fileId = crypto.randomUUID();
  const dest = path.join(FILES_DIR, fileId);
  const ws = fs.createWriteStream(dest);
  req.pipe(ws);
  ws.on('finish', () => res.json({ fileId }));
  ws.on('error', () => { try { fs.unlinkSync(dest); } catch {} if (!res.headersSent) res.status(500).json({ error: 'write failed' }); });
  req.on('error', () => { try { ws.destroy(); } catch {} });
});

// 대용량 파일 다운로드: 로컬에 없으면 원본(보낸 사람) 노드에서 메시로 가져와 제공
const fetchingFiles = new Map(); // fileId -> Promise (중복 요청 합치기)
app.get('/file/:id', async (req, res) => {
  const fileId = String(req.params.id || '');
  if (!isUuid(fileId)) { res.status(400).send('잘못된 파일 id'); return; }
  const local = path.join(FILES_DIR, fileId);
  const meta = findFileMeta(fileId);
  const name = req.query.name || (meta && meta.name) || 'file';
  if (fs.existsSync(local)) return streamDownload(res, local, name, meta && meta.mime);
  if (!meta) { res.status(404).send('파일 정보를 찾을 수 없습니다.'); return; }
  if (meta.origin === myId) { res.status(404).send('원본 파일이 없습니다.'); return; }
  try {
    if (!fetchingFiles.has(fileId)) {
      fetchingFiles.set(fileId, fetchFromOrigin(fileId, meta.origin, local).finally(() => fetchingFiles.delete(fileId)));
    }
    await fetchingFiles.get(fileId);
    return streamDownload(res, local, name, meta && meta.mime);
  } catch (e) {
    res.status(503).send('보낸 사람이 오프라인이거나 파일을 가져올 수 없습니다.');
  }
});

function streamDownload(res, filePath, name, mime) {
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name));
  fs.createReadStream(filePath).pipe(res);
}
function findFileMeta(fileId) {
  for (const r of Object.values(store.records)) {
    if (r.type === 'msg' && r.file && r.file.fileId === fileId) return r.file;
  }
  return null;
}
function findFileMsg(fileId) {
  for (const r of Object.values(store.records)) {
    if (r.type === 'msg' && r.file && r.file.fileId === fileId) return r;
  }
  return null;
}
function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}
// 제어문자 제거(이스케이프 함정 회피: 정규식 대신 charCode 필터)
function stripCtrl(s) {
  s = String(s); let out = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 32 || c === 9) out += s[i]; }
  return out;
}

// AI 요약: 클라이언트가 보낸 메시지들을 LLM 으로 요약(설정된 경우). 미설정 시 외부 전송 없음.
app.post('/summarize', express.json({ limit: '4mb' }), async (req, res) => {
  const title = String((req.body && req.body.title) || '대화').slice(0, 120);
  const msgs = (req.body && Array.isArray(req.body.messages)) ? req.body.messages : [];
  if (!msgs.length) { res.json({ summary: '요약할 메시지가 없습니다.' }); return; }
  if (!LLM_URL) {
    const who = [...new Set(msgs.map((m) => String(m.from || '?')))].slice(0, 20).join(', ');
    res.json({ fallback: true, summary: '[AI 요약이 설정되지 않았습니다]\n메시지 ' + msgs.length + '개 · 참여자: ' + who + '\n\n서버에 LLM_URL(및 키/모델)을 설정하면 자동 요약됩니다. (README 참고)' });
    return;
  }
  const transcript = msgs.map((m) => String(m.from || '?').slice(0, 40) + ': ' + String(m.text || '').replace(/\s+/g, ' ').slice(0, 2000)).join('\n').slice(0, 24000);
  try {
    res.json({ summary: await callLLM(title, transcript) });
  } catch (e) {
    res.status(502).json({ error: true, summary: 'AI 요약 호출에 실패했습니다: ' + e.message });
  }
});

async function callLLM(title, transcript) {
  const sys = '너는 사내 메신저 대화 요약 도우미다. 주어진 대화를 한국어로 간결히 요약하라. 핵심 논의, 결정사항, 할 일(있으면)을 짧은 불릿으로. 추측이나 군더더기는 빼라.';
  const user = '제목: ' + title + '\n\n[대화]\n' + transcript + '\n\n위 대화를 요약해줘.';
  if (LLM_PROVIDER === 'anthropic') {
    const r = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': LLM_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 800, system: sys, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return ((j.content && j.content[0] && j.content[0].text) || '').trim() || '(요약 없음)';
  }
  const headers = { 'content-type': 'application/json' };
  if (LLM_KEY) headers['authorization'] = 'Bearer ' + LLM_KEY;
  const r = await fetch(LLM_URL, {
    method: 'POST', headers: headers,
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.3, stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim() || '(요약 없음)';
}

const web = http.createServer(app);
const io = new Server(web, { maxHttpBufferSize: 32 * 1024 * 1024 }); // 이미지/파일(data URL) 수용

function uiBroadcastRecord(rec) { io.emit('record', rec); }
function uiBroadcastChannels() { io.emit('channels', channelsList()); }
function uiBroadcastPeers() { io.emit('peers', onlinePeers()); }

io.on('connection', (socket) => {
  socket.emit('session', { hasName: !!identity.name, name: identity.name, color: identity.color });
  socket.on('login', ({ name, color } = {}) => {
    name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
    if (!name) { socket.emit('loginError', '이름을 입력하세요.'); return; }
    if (!identity.name) { // 최초 1회만 신원 설정 → 이후 고정(이름 변경 불가)
      identity.name = name;
      identity.color = (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) ? color : (identity.color || '#4363d8');
      saveIdentity();
      publish(newRecord({ type: 'user', uid: myId, name: identity.name, color: identity.color })); // 영구 명부 등록
    }
    sendHello('hello'); // 새 이름/색을 즉시 알림
    socket.emit('init', {
      me: { id: myId, name: identity.name, color: identity.color },
      channels: channelsList(),
      records: allRecords(),
      peers: onlinePeers(),
    });
    uiBroadcastPeers();
  });

  socket.on('createChannel', (name) => {
    name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
    if (!name || !identity.name) return;
    if (Object.values(store.records).some((r) => r.type === 'channel' && r.name === name)) {
      socket.emit('channels', channelsList());
      return;
    }
    const rec = newRecord({ type: 'channel', name, author: { id: myId, name: identity.name } });
    publish(rec);
    uiBroadcastChannels();
  });

  socket.on('send', ({ channel, topic, text, image, imw, imh, file, mentions, poll, intake, sched } = {}) => {
    if (!identity.name) return;
    if (typeof channel !== 'string') return;
    const isDM = channel.indexOf('dm:') === 0;
    if (isDM) {
      const parts = channel.slice(3).split('|');
      if (parts.length !== 2 || parts.indexOf(myId) === -1) return; // 내가 참여자가 아니면 거부
    } else if (typeof topic !== 'string' || !store.records[channel] || store.records[channel].type !== 'channel') {
      return;
    }
    topic = topic.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || '(주제 없음)';
    if (isDM) topic = ''; // DM 은 주제 없음
    text = String(text || '').slice(0, MAX_TEXT);
    let img = null, w = 0, h = 0;
    if (typeof image === 'string' && image.indexOf('data:image/') === 0 && image.length <= 8 * 1024 * 1024) {
      img = image; w = Number(imw) || 0; h = Number(imh) || 0;
    }
    let f = null;
    if (file && typeof file === 'object') {
      if (typeof file.fileId === 'string' && file.large) {
        // 대용량: 메타데이터만(바이트는 내 노드 디스크에 업로드돼 있음) → 받을 때 원본에서 가져감
        if (fs.existsSync(path.join(FILES_DIR, file.fileId))) {
          f = { name: String(file.name || '파일').slice(0, 150), size: Number(file.size) || 0, mime: String(file.mime || 'application/octet-stream').slice(0, 150), fileId: file.fileId, origin: myId, large: true };
        }
      } else if (typeof file.data === 'string' && file.data.indexOf('data:') === 0 && file.data.length <= 30 * 1024 * 1024) {
        f = { name: String(file.name || '파일').slice(0, 150), size: Number(file.size) || 0, mime: String(file.mime || 'application/octet-stream').slice(0, 150), data: file.data };
      }
    }
    let pollObj = null;
    if (poll && typeof poll === 'object' && typeof poll.q === 'string' && Array.isArray(poll.opts)) {
      const pq = stripCtrl(poll.q).trim().slice(0, 200);
      const popts = poll.opts.filter((o) => typeof o === 'string').map((o) => stripCtrl(o).trim().slice(0, 100)).filter(Boolean).slice(0, 10);
      if (pq && popts.length >= 2) pollObj = { q: pq, opts: popts, multi: !!poll.multi };
    }
    let intakeObj = null;
    if (intake && typeof intake === 'object' && typeof intake.title === 'string') {
      const ttl = stripCtrl(intake.title).trim().slice(0, 200);
      const ipr = stripCtrl(String(intake.prompt || '')).trim().slice(0, 1000);
      const kind = (intake.kind === 'choice') ? 'choice' : 'text';
      let iopts = [];
      if (kind === 'choice') iopts = (Array.isArray(intake.opts) ? intake.opts : []).filter((o) => typeof o === 'string').map((o) => stripCtrl(o).trim().slice(0, 100)).filter(Boolean).slice(0, 20);
      const due = (typeof intake.due === 'number' && intake.due > 0) ? intake.due : 0;
      if (ttl && (kind === 'text' || iopts.length >= 2)) intakeObj = { title: ttl, prompt: ipr, kind: kind, opts: iopts, due: due };
    }
    let schedObj = null;
    if (sched && typeof sched === 'object' && typeof sched.title === 'string' && Array.isArray(sched.slots)) {
      const sttl = stripCtrl(sched.title).trim().slice(0, 200);
      const sslots = sched.slots.filter((o) => typeof o === 'string').map((o) => stripCtrl(o).trim().slice(0, 80)).filter(Boolean).slice(0, 50);
      const sdue = (typeof sched.due === 'number' && sched.due > 0) ? sched.due : 0;
      if (sttl && sslots.length >= 2) schedObj = { title: sttl, slots: sslots, due: sdue };
    }
    if (!text.trim() && !img && !f && !pollObj && !intakeObj && !schedObj) return;
    const fields = { type: 'msg', channel, topic, text, author: { id: myId, name: identity.name, color: identity.color } };
    if (img) { fields.image = img; fields.imw = w; fields.imh = h; }
    if (f) fields.file = f;
    if (pollObj) fields.poll = pollObj;
    if (intakeObj) fields.intake = intakeObj;
    if (schedObj) fields.sched = schedObj;
    if (Array.isArray(mentions)) { const ids = mentions.filter((x) => typeof x === 'string').slice(0, 30); if (ids.length) fields.mentions = ids; }
    publish(newRecord(fields));
  });

  // 메시지 삭제(본인 것만): 삭제 표식(tombstone)을 만들어 모든 노드에 전파
  socket.on('deleteMsg', (targetId) => {
    if (!identity.name || typeof targetId !== 'string') return;
    const t = store.records[targetId];
    if (!t || t.type !== 'msg' || !t.author || t.author.id !== myId) return;
    const del = { type: 'del', target: targetId, author: { id: myId, name: identity.name } };
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) del.dm = t.channel; // DM 삭제는 당사자에게만
    publish(newRecord(del));
  });

  // 주제 대화 리셋: 그 시점 이전의 해당 (채널,주제) 메시지를 숨기는 표식을 전파(주제·채널은 유지)
  socket.on('resetTopic', ({ channel, topic } = {}) => {
    if (!identity.name || typeof channel !== 'string' || typeof topic !== 'string') return;
    if (!store.records[channel] || store.records[channel].type !== 'channel') return;
    publish(newRecord({ type: 'reset', channel: channel, topic: topic, author: { id: myId, name: identity.name } }));
  });

  // 메시지 리액션(이모지): 토글 방식(같은 author+emoji 가 또 오면 꺼짐 — 클라이언트가 패리티로 계산)
  socket.on('react', ({ target, emoji } = {}) => {
    if (!identity.name || typeof target !== 'string' || typeof emoji !== 'string') return;
    const t = store.records[target];
    if (!t || t.type !== 'msg') return;
    if (REACTION_SET.indexOf(emoji) === -1) return;
    const rec = { type: 'react', target: target, emoji: emoji, author: { id: myId, name: identity.name } };
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) rec.dm = t.channel;
    publish(newRecord(rec));
  });

  // 내 메시지 수정: 최신 edit 가 본문을 덮어씀(클라이언트가 ts 로 최신 선택)
  socket.on('editMsg', ({ target, text } = {}) => {
    if (!identity.name || typeof target !== 'string') return;
    const t = store.records[target];
    if (!t || t.type !== 'msg' || !t.author || t.author.id !== myId) return;
    text = String(text || '').slice(0, MAX_TEXT);
    if (!text.trim()) return;
    const rec = { type: 'edit', target: target, text: text, author: { id: myId, name: identity.name } };
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) rec.dm = t.channel;
    publish(newRecord(rec));
  });

  // 투표: target=투표 메시지, opt=선택지 index(-1=취소). 단일선택은 최신 vote, 복수선택은 패리티로 집계
  socket.on('vote', ({ target, opt } = {}) => {
    if (!identity.name || typeof target !== 'string') return;
    const t = store.records[target];
    if (!t || t.type !== 'msg' || !t.poll) return;
    opt = Number(opt);
    if (!Number.isInteger(opt) || opt < -1 || opt >= t.poll.opts.length) return;
    const rec = { type: 'vote', target: target, opt: opt, author: { id: myId, name: identity.name } };
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) rec.dm = t.channel;
    publish(newRecord(rec));
  });

  // 수합 제출: target=수합 메시지. kind=text 면 text, choice 면 opt. 사람당 최신 제출만 유효
  socket.on('submit', ({ target, text, opt } = {}) => {
    if (!identity.name || typeof target !== 'string') return;
    const t = store.records[target];
    if (!t || t.type !== 'msg' || !t.intake) return;
    const rec = { type: 'submit', target: target, kind: t.intake.kind, author: { id: myId, name: identity.name } };
    if (t.intake.kind === 'choice') {
      const o = Number(opt);
      if (!Number.isInteger(o) || o < 0 || o >= t.intake.opts.length) return;
      rec.opt = o;
    } else {
      const txt = stripCtrl(String(text || '')).trim().slice(0, MAX_TEXT);
      if (!txt) return;
      rec.text = txt;
    }
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) rec.dm = t.channel;
    publish(newRecord(rec));
  });

  // 일정조율 가용시간 응답: target=일정 메시지, slots=가능 슬롯 index 배열(사람당 최신만 유효)
  socket.on('avail', ({ target, slots } = {}) => {
    if (!identity.name || typeof target !== 'string' || !Array.isArray(slots)) return;
    const t = store.records[target];
    if (!t || t.type !== 'msg' || !t.sched) return;
    const nn = t.sched.slots.length; const set = []; const seen = {};
    for (const x of slots) { const i = Number(x); if (Number.isInteger(i) && i >= 0 && i < nn && !seen[i]) { seen[i] = 1; set.push(i); } }
    const rec = { type: 'avail', target: target, slots: set, author: { id: myId, name: identity.name } };
    if (typeof t.channel === 'string' && t.channel.indexOf('dm:') === 0) rec.dm = t.channel;
    publish(newRecord(rec));
  });

  // 문서함: 새 문서/새 버전 업로드(임베드 → 전원 복제로 durable). 버전번호 자동 증가. text=diff용 추출 텍스트
  socket.on('docpost', ({ docId, title, note, file, text } = {}) => {
    if (!identity.name) return;
    if (!file || typeof file !== 'object' || typeof file.data !== 'string' || file.data.indexOf('data:') !== 0) return;
    if (file.data.length > 28 * 1024 * 1024) return; // 약 20MB 이하
    const id = (typeof docId === 'string' && docId.length) ? docId.slice(0, 80) : crypto.randomUUID();
    let ver = 1;
    for (const r of Object.values(store.records)) if (r.type === 'docver' && r.docId === id && r.ver >= ver) ver = r.ver + 1;
    const f = { name: String(file.name || '문서').slice(0, 150), size: Number(file.size) || 0, mime: String(file.mime || '').slice(0, 150), data: file.data };
    const rec = {
      type: 'docver', docId: id, ver: ver,
      title: stripCtrl(String(title || f.name)).trim().slice(0, 150) || '문서',
      note: stripCtrl(String(note || '')).trim().slice(0, 500),
      file: f, text: String(text || '').slice(0, 200000), // 개행 유지(diff용) — stripCtrl 금지
      author: { id: myId, name: identity.name },
    };
    publish(newRecord(rec));
  });

  // 입력 중 표시(휘발성, 저장/가십 안 함): 1홉만 전달
  socket.on('typing', ({ channel } = {}) => {
    if (!identity.name || typeof channel !== 'string') return;
    const sig = { t: 'sig', kind: 'typing', id: myId, name: identity.name, channel: channel };
    if (channel.indexOf('dm:') === 0) {
      const parts = channel.slice(3).split('|');
      if (parts.indexOf(myId) === -1) return;
      for (const pid of parts) { if (pid !== myId) { const s = conns.get(pid); if (s) send(s, sig); } }
    } else {
      if (!store.records[channel] || store.records[channel].type !== 'channel') return;
      floodToPeers(sig, null);
    }
  });
});

// 새 record 생성(작성자=나)
function newRecord(fields) {
  return Object.assign({ id: crypto.randomUUID(), ts: Date.now(), lc: nextClock() }, fields);
}
// record 수신 대상: null=공개(전체 전파), 배열=해당 참여자 id 에게만(DM 등)
function audienceOf(rec) {
  if (rec.type === 'msg' && typeof rec.channel === 'string' && rec.channel.indexOf('dm:') === 0) return rec.channel.slice(3).split('|');
  if ((rec.type === 'del' || rec.type === 'react' || rec.type === 'edit' || rec.type === 'vote' || rec.type === 'submit' || rec.type === 'avail') && typeof rec.dm === 'string' && rec.dm.indexOf('dm:') === 0) return rec.dm.slice(3).split('|');
  return null;
}
// 내가 만든 record 를 저장 + UI + 전파(공개=전체, DM=당사자에게만)
function publish(rec) {
  store.records[rec.id] = rec;
  markDirty();
  uiBroadcastRecord(rec);
  const aud = audienceOf(rec);
  if (!aud) floodToPeers({ t: 'record', record: rec }, null);
  else for (const pid of aud) { if (pid !== myId) { const s = conns.get(pid); if (s) send(s, { t: 'record', record: rec }); } }
}
// 외부에서 들어온 record 흡수. 새것이면 true.
function ingest(rec, sourcePeerId, live) {
  if (!rec || !rec.id || typeof rec.type !== 'string') return false;
  if (store.records[rec.id]) return false; // 이미 있음
  if (rec.type === 'channel') {
    if (typeof rec.name !== 'string') return false;
  } else if (rec.type === 'msg') {
    if (typeof rec.channel !== 'string' || typeof rec.topic !== 'string') return false;
  } else if (rec.type === 'del') {
    if (typeof rec.target !== 'string') return false;
  } else if (rec.type === 'reset') {
    if (typeof rec.channel !== 'string' || typeof rec.topic !== 'string') return false;
  } else if (rec.type === 'react') {
    if (typeof rec.target !== 'string' || typeof rec.emoji !== 'string') return false;
  } else if (rec.type === 'edit') {
    if (typeof rec.target !== 'string' || typeof rec.text !== 'string') return false;
  } else if (rec.type === 'vote') {
    if (typeof rec.target !== 'string' || typeof rec.opt !== 'number') return false;
  } else if (rec.type === 'submit') {
    if (typeof rec.target !== 'string') return false;
  } else if (rec.type === 'avail') {
    if (typeof rec.target !== 'string' || !Array.isArray(rec.slots)) return false;
  } else if (rec.type === 'docver') {
    if (typeof rec.docId !== 'string' || !rec.file || typeof rec.file.data !== 'string') return false;
  } else if (rec.type === 'user') {
    if (typeof rec.uid !== 'string' || typeof rec.name !== 'string') return false;
    for (const x of Object.values(store.records)) if (x.type === 'user' && x.uid === rec.uid) return false; // TOFU: 신원당 1개(이름 고정)
  } else return false;
  let aud = audienceOf(rec);
  // del/edit/react 는 자칭 dm 을 신뢰하지 않고 "대상 메시지" 기준으로 권한·수신대상 검증/정규화
  if (rec.type === 'del' || rec.type === 'edit' || rec.type === 'react' || rec.type === 'vote' || rec.type === 'submit') {
    const tgt = store.records[rec.target];
    if (!tgt || tgt.type !== 'msg') return false; // 대상 없으면 거부(이후 동기화로 재수신 — 자가복구)
    if (rec.type === 'vote' && !tgt.poll) return false; // 투표는 투표 메시지에만
    if (rec.type === 'submit' && !tgt.intake) return false; // 제출은 수합 메시지에만
    if (rec.type === 'avail' && !tgt.sched) return false; // 가용응답은 일정 메시지에만
    if ((rec.type === 'edit' || rec.type === 'del') && (!rec.author || !tgt.author || rec.author.id !== tgt.author.id)) return false; // 원작성자만
    if (typeof tgt.channel === 'string' && tgt.channel.indexOf('dm:') === 0) rec.dm = tgt.channel; else delete rec.dm;
    aud = audienceOf(rec);
  }
  if (aud && aud.indexOf(myId) === -1) return false; // 나에게 온 DM 이 아니면 거부
  store.records[rec.id] = rec;
  bumpClock(rec.lc || 0);
  markDirty();
  uiBroadcastRecord(rec);
  if (rec.type === 'channel') uiBroadcastChannels();
  if (live && !aud) floodToPeers({ t: 'record', record: rec }, sourcePeerId); // 공개 record 만 재전파(가십)
  return true;
}

// ===================================================================
// TCP 메시(mesh)
// ===================================================================
const peers = new Map(); // id -> { id, name, color, ip, tcpPort, lastSeen }
const conns = new Map(); // id -> socket (핸드셰이크 완료)
let myTcpPort = 0;

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}
function send(sock, obj) { try { sock.write(frame(obj)); } catch {} }
function makeParser(onObj) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > 50 * 1024 * 1024) { buf = Buffer.alloc(0); break; } // 안전장치
      if (buf.length < 4 + len) break;
      const j = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      try { onObj(JSON.parse(j.toString('utf8'))); } catch {}
    }
  };
}

function floodToPeers(msg, exceptId) {
  const f = frame(msg);
  for (const [pid, sock] of conns) {
    if (pid === exceptId) continue;
    try { sock.write(f); } catch {}
  }
}

// 한 소켓(수신/발신 공통) 처리
function handleSocket(sock, knownPeerId) {
  let peerId = knownPeerId || null;
  let registered = false;

  const register = () => {
    if (registered || !peerId) return;
    if (conns.has(peerId)) { // 중복 연결 → 새 것 닫기
      try { sock.destroy(); } catch {}
      return;
    }
    conns.set(peerId, sock);
    registered = true;
    // DM 레코드 id 는 당사자에게만 노출
    send(sock, { t: 'ids', ids: Object.keys(store.records).filter((id) => { const a = audienceOf(store.records[id]); return !a || a.indexOf(peerId) !== -1; }) });
  };

  send(sock, { t: 'hi', id: myId });
  if (peerId) register();

  sock.on('data', makeParser((obj) => {
    if (obj.t === 'hi') {
      if (!peerId) peerId = obj.id;
      register();
    } else if (obj.t === 'ids') {
      const have = new Set(obj.ids || []);
      const missing = Object.keys(store.records).filter((id) => !have.has(id)).map((id) => store.records[id])
        .filter((rec) => { const a = audienceOf(rec); return !a || a.indexOf(peerId) !== -1; }); // DM 은 당사자에게만 동기화
      if (missing.length) {
        // 큰 동기화는 나눠서 전송
        for (let i = 0; i < missing.length; i += 200) {
          send(sock, { t: 'records', records: missing.slice(i, i + 200) });
        }
      }
    } else if (obj.t === 'records') {
      for (const rec of obj.records || []) ingest(rec, peerId, false);
    } else if (obj.t === 'record') {
      ingest(obj.record, peerId, true);
    } else if (obj.t === 'getfile') {
      serveFileOverMesh(sock, obj.fileId, obj.reqId, peerId);
    } else if (obj.t === 'filechunk') {
      const r = fileReqs.get(obj.reqId); if (r) r.onChunk(obj.data);
    } else if (obj.t === 'fileend') {
      const r = fileReqs.get(obj.reqId); if (r) r.onEnd();
    } else if (obj.t === 'filemiss') {
      const r = fileReqs.get(obj.reqId); if (r) r.onMiss();
    } else if (obj.t === 'sig') {
      if (obj.kind === 'typing' && obj.id !== myId) io.emit('peerTyping', { id: obj.id, name: obj.name, channel: obj.channel });
    }
  }));

  const cleanup = () => { if (peerId && conns.get(peerId) === sock) conns.delete(peerId); };
  sock.on('close', cleanup);
  sock.on('error', () => { try { sock.destroy(); } catch {} cleanup(); });
}

// ----- 대용량 파일 메시 전송 -----
const fileReqs = new Map(); // reqId -> { onChunk, onEnd, onMiss }
function serveFileOverMesh(sock, fileId, reqId, peerId) {
  if (typeof fileId !== 'string' || typeof reqId !== 'string' || !isUuid(fileId)) { send(sock, { t: 'filemiss', reqId }); return; }
  // 권한: 이 파일을 참조하는 메시지의 수신 대상에 요청자가 포함되어야(공개 메시지면 누구나)
  const fmsg = findFileMsg(fileId);
  if (fmsg) { const aud = audienceOf(fmsg); if (aud && aud.indexOf(peerId) === -1) { send(sock, { t: 'filemiss', reqId }); return; } }
  const p = path.join(FILES_DIR, fileId);
  if (!fs.existsSync(p)) { send(sock, { t: 'filemiss', reqId }); return; }
  const rs = fs.createReadStream(p, { highWaterMark: CHUNK });
  rs.on('data', (chunk) => {
    const okw = sock.write(frame({ t: 'filechunk', reqId, data: chunk.toString('base64') }));
    if (!okw) { rs.pause(); sock.once('drain', () => rs.resume()); }
  });
  rs.on('end', () => send(sock, { t: 'fileend', reqId }));
  rs.on('error', () => send(sock, { t: 'filemiss', reqId }));
}
function fetchFromOrigin(fileId, originId, destPath) {
  return new Promise((resolve, reject) => {
    const sock = conns.get(originId);
    if (!sock) { reject(new Error('origin offline')); return; }
    const reqId = crypto.randomUUID();
    const tmp = destPath + '.' + reqId + '.part';
    const ws = fs.createWriteStream(tmp);
    const finish = (fn) => { clearTimeout(timer); fileReqs.delete(reqId); fn(); };
    const timer = setTimeout(() => { try { ws.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} finish(() => reject(new Error('timeout'))); }, 120000);
    fileReqs.set(reqId, {
      onChunk: (b64) => { try { ws.write(Buffer.from(b64, 'base64')); } catch {} },
      onEnd: () => { ws.end(() => { try { fs.renameSync(tmp, destPath); } catch {} finish(resolve); }); },
      onMiss: () => { try { ws.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} finish(() => reject(new Error('not found at origin'))); },
    });
    send(sock, { t: 'getfile', fileId, reqId });
  });
}

const tcpServer = net.createServer((sock) => handleSocket(sock, null));
tcpServer.on('error', (e) => console.warn('메시 서버 오류:', e.message));

function maybeConnect(peer) {
  if (conns.has(peer.id)) return;
  if (myId >= peer.id) return; // 규칙: id 가 작은 쪽이 연결을 건다(중복 방지)
  const sock = net.connect(peer.tcpPort, peer.ip);
  sock.setNoDelay(true);
  sock.on('connect', () => handleSocket(sock, peer.id));
  sock.on('error', () => { try { sock.destroy(); } catch {} });
}

// ===================================================================
// UDP 멀티캐스트 발견(discovery)
// ===================================================================
const disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
disco.on('error', (e) => console.warn('발견 소켓 오류:', e.message));

function sendHello(t) {
  const pkt = Buffer.from(JSON.stringify({
    t: t || 'hello', id: myId, name: identity.name, color: identity.color,
    tcpPort: myTcpPort, ts: Date.now(),
  }));
  try { disco.send(pkt, 0, pkt.length, DISCOVERY_PORT, DISCOVERY_ADDR); } catch {}
}

disco.on('message', (buf, rinfo) => {
  let m; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
  if (!m || m.id === myId) return; // 내 패킷 무시
  if (m.t === 'bye') {
    peers.delete(m.id);
    const s = conns.get(m.id); if (s) { try { s.destroy(); } catch {} conns.delete(m.id); }
    uiBroadcastPeers();
    return;
  }
  const existed = peers.get(m.id);
  const peer = { id: m.id, name: m.name, color: m.color, ip: rinfo.address, tcpPort: m.tcpPort, lastSeen: Date.now() };
  peers.set(m.id, peer);
  if (m.tcpPort) maybeConnect(peer);
  if (!existed || existed.name !== m.name || existed.color !== m.color) uiBroadcastPeers();
});

function onlinePeers() {
  const now = Date.now();
  const list = [];
  for (const p of peers.values()) {
    if (now - p.lastSeen < PEER_TIMEOUT && p.name) list.push({ id: p.id, name: p.name, color: p.color });
  }
  return list;
}

// 주기적으로: hello 방송 + 오래된 피어 정리
setInterval(() => {
  sendHello('hello');
  const now = Date.now();
  let changed = false;
  for (const [id, p] of peers) {
    if (now - p.lastSeen >= PEER_TIMEOUT) {
      peers.delete(id);
      const s = conns.get(id); if (s) { try { s.destroy(); } catch {} conns.delete(id); }
      changed = true;
    }
  }
  if (changed) uiBroadcastPeers();
}, HELLO_INTERVAL);

// ===================================================================
// 시작
// ===================================================================
function lanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const k of Object.keys(ifaces)) for (const i of ifaces[k] || []) {
    if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  return ips;
}

function printBanner(actualPort) {
  console.log('');
  console.log('  ===== P2P 사내 메신저 노드 실행됨 =====');
  console.log('');
  console.log('  내 노드 ID : ' + myId.slice(0, 8));
  console.log('  메시 포트  : ' + myTcpPort + '  (같은 망 자동 연결)');
  console.log('  발견 그룹  : ' + DISCOVERY_ADDR + ':' + DISCOVERY_PORT);
  console.log('');
  console.log('  >> 브라우저에서 열기:  http://localhost:' + actualPort);
  console.log('     (브라우저가 자동으로 열립니다)');
  console.log('');
  console.log('  같은 망의 동료도 각자 이 프로그램을 실행하면');
  console.log('  서로 자동으로 발견해 직접 연결됩니다(중앙서버 없음).');
  console.log('  내 랜 주소: ' + (lanIPs().join(', ') || '(없음)'));
  console.log('');
  console.log('  종료: Ctrl+C');
  console.log('');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

web.on('listening', () => {
  web.removeAllListeners('error');
  web.on('error', (e) => console.error('웹 서버 오류:', e.message));
  const actual = web.address().port;
  printBanner(actual);
  if (process.env.OPEN === '1') openBrowser('http://localhost:' + actual);
});

function startWeb(port, attemptsLeft) {
  web.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log('  포트 ' + port + ' 사용 중 -> ' + (port + 1) + ' 시도...');
      startWeb(port + 1, attemptsLeft - 1);
    } else {
      console.error('웹 UI 시작 실패: ' + e.message);
      process.exit(1);
    }
  });
  web.listen(port, '127.0.0.1');
}

tcpServer.listen(0, '0.0.0.0', () => {
  myTcpPort = tcpServer.address().port;
  disco.bind(DISCOVERY_PORT, () => {
    try { disco.addMembership(DISCOVERY_ADDR); } catch (e) { console.warn('멀티캐스트 가입 실패:', e.message); }
    try { disco.setMulticastLoopback(true); } catch {}
    try { disco.setMulticastTTL(2); } catch {}
    sendHello('hello');
  });
  startWeb(WEB_PORT, 10);
});

// 안전 종료
function shutdown() {
  try { sendHello('bye'); } catch {}
  flush();
  setTimeout(() => process.exit(0), 120);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
