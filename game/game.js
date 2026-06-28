/* ============================================================
   🤠 로프 카우보이 — 납치 & 구출 2D 팀전
   순수 HTML5 Canvas / 빌드 불필요. index.html 을 브라우저로 열면 끝.
   ============================================================ */
(() => {
  'use strict';

  // ---------- 캔버스 ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // ---------- 작은 수학 도우미 ----------
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  function angLerp(a, b, t) { // 최단 회전 보간
    let d = ((b - a + Math.PI) % TAU) - Math.PI;
    if (d < -Math.PI) d += TAU;
    return a + d * t;
  }

  // ---------- 난이도 ----------
  const DIFF = {
    easy:   { aiSpeed: 1.55, range: 200, accuracy: 0.45, cooldown: 1.7, react: 0.55 },
    normal: { aiSpeed: 1.95, range: 250, accuracy: 0.72, cooldown: 1.1, react: 0.32 },
    hard:   { aiSpeed: 2.35, range: 300, accuracy: 0.9,  cooldown: 0.75, react: 0.18 },
  };
  let diff = DIFF.normal;

  // ---------- 팀 색 ----------
  const COL = {
    red:  { body: '#e25a4a', dark: '#a93c30', hat: '#7a2a1f', sash: '#ffd27a' },
    blue: { body: '#4a86e2', dark: '#305fa6', hat: '#22386b', sash: '#bfe0ff' },
  };

  // ---------- 월드 / 장애물 ----------
  // 감옥: 레드 감옥(좌)에는 잡힌 '블루'가 갇힘 / 블루 감옥(우)에는 잡힌 '레드'가 갇힘
  const JAIL = {
    red:  { x: 26,  y: 180, w: 96, h: 240, slots: [] }, // 좌측 (블루 포로 수감)
    blue: { x: 838, y: 180, w: 96, h: 240, slots: [] }, // 우측 (레드 포로 수감)
  };
  function buildJailSlots(j) {
    j.slots = [];
    for (let i = 0; i < 3; i++) {
      j.slots.push({ x: j.x + j.w / 2, y: j.y + 44 + i * 76, taken: null });
    }
  }
  buildJailSlots(JAIL.red); buildJailSlots(JAIL.blue);

  // 장애물: wall(고정 벽+그래플 고리로 넘기), crate(끌어당겨 이동), rock(고정)
  let obstacles = [];
  function buildObstacles() {
    obstacles = [
      { type: 'wall', x: 300, y: 90,  w: 30, h: 170 },
      { type: 'wall', x: 300, y: 350, w: 30, h: 170 },
      { type: 'wall', x: 630, y: 90,  w: 30, h: 170 },
      { type: 'wall', x: 630, y: 350, w: 30, h: 170 },
      { type: 'rock', x: 455, y: 270, w: 50, h: 60 },
      { type: 'crate', x: 200, y: 290, w: 44, h: 44, vx: 0, vy: 0 },
      { type: 'crate', x: 716, y: 290, w: 44, h: 44, vx: 0, vy: 0 },
      { type: 'crate', x: 460, y: 120, w: 44, h: 44, vx: 0, vy: 0 },
      { type: 'crate', x: 460, y: 430, w: 44, h: 44, vx: 0, vy: 0 },
    ];
    // 벽마다 그래플 고리(넘어가는 지점) 부여 — 벽 중앙
    for (const o of obstacles) {
      if (o.type === 'wall') {
        o.anchor = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
      }
    }
  }

  // ---------- 엔티티 ----------
  const R = 15;            // 카우보이 반지름
  function makeCowboy(team, x, y, isHuman) {
    return {
      team, x, y, vx: 0, vy: 0, r: R,
      face: team === 'red' ? 0 : Math.PI, // 바라보는 방향
      aim: team === 'red' ? 0 : Math.PI,
      isHuman: !!isHuman,
      ai: !isHuman,
      state: 'active',     // active | bound | jailed | vault
      z: 0, zv: 0,         // 점프(넘기) 높이
      vaultT: 0, vaultFrom: null, vaultTo: null,
      jailSlot: null,
      bindTimer: 0,        // 포박 남은 시간(초)
      captorTeam: null,    // 나를 포박/수감한 팀
      reelT: null, reelFrom: null, reelTo: null, // 끌려오기 트윈
      cool: 0,             // 올가미 쿨다운
      dashCool: 0,
      stepPhase: 0,
      lasso: makeLasso(),
      aiTimer: rand(0, 0.4),
      aiTarget: null,
    };
  }
  function makeLasso() {
    return {
      state: 'idle',       // idle | charge | throw | retract
      tx: 0, ty: 0,        // 올가미 끝 위치
      vx: 0, vy: 0,
      len: 0, maxLen: 0,
      charge: 0,
      holdTime: 0,         // 버튼 누른 시간(초) — 5초↑ 필살
      ult: false,          // 필살 올가미 여부
      spin: 0,             // 머리 위 회전 각
      hooked: null,        // {kind:'enemy'|'ally'|'crate'|'anchor', ref}
    };
  }

  // ---------- 게임 상태 ----------
  let cowboys = [];
  let player = null;
  let particles = [];
  let floaters = [];       // 떠오르는 텍스트
  let timeLeft = 120;      // 초
  let running = false;
  let gameOver = false;
  let screenShake = 0;

  function resetGame() {
    buildObstacles();
    buildJailSlots(JAIL.red); buildJailSlots(JAIL.blue);
    cowboys = [];
    particles = []; floaters = [];
    timeLeft = 120; gameOver = false; screenShake = 0;

    // 레드 3 (인간 1 + AI 2) — 좌측에서 스폰
    const redSpawn = [[170, 200], [150, 300], [170, 400]];
    const blueSpawn = [[790, 200], [810, 300], [790, 400]];
    for (let i = 0; i < 3; i++) {
      cowboys.push(makeCowboy('red', redSpawn[i][0], redSpawn[i][1], i === 0));
      cowboys.push(makeCowboy('blue', blueSpawn[i][0], blueSpawn[i][1], false));
    }
    player = cowboys[0];
    running = true;
  }

  // ---------- 입력 ----------
  const keys = {};
  const mouse = { x: W / 2, y: H / 2, down: false };
  addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  function canvasPos(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) * (W / r.width),
      y: (clientY - r.top) * (H / r.height),
    };
  }
  canvas.addEventListener('mousemove', e => { const p = canvasPos(e.clientX, e.clientY); mouse.x = p.x; mouse.y = p.y; });
  canvas.addEventListener('mousedown', e => { if (e.button === 0) mouse.down = true; });
  addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });

  // 모바일 터치 조이스틱
  const touchUI = document.getElementById('touch');
  const stick = document.getElementById('stick');
  const nub = stick.querySelector('.nub');
  const fireBtn = document.getElementById('fireBtn');
  const tstick = { active: false, dx: 0, dy: 0, id: null };   // 왼쪽: 이동
  const astick = { active: false, dx: 1, dy: 0, id: null };   // 오른쪽: 조준(자유 360°)
  let touchFire = false;
  const aimNub = fireBtn.querySelector('.aimnub');
  function isTouch() { return ('ontouchstart' in window) || navigator.maxTouchPoints > 0; }
  function setStick(t) {
    const r = stick.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy), max = r.width / 2 || 1;
    if (m > max) { dx = dx / m * max; dy = dy / m * max; }
    tstick.dx = dx / max; tstick.dy = dy / max; tstick.active = true;
    nub.style.transform = `translate(${dx}px,${dy}px)`;
  }
  function setAim(t) {
    const r = fireBtn.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy);
    if (m > 7) { // 살짝만 끌어도 방향 갱신 → 360° 자유 조준
      astick.dx = dx / m; astick.dy = dy / m; astick.active = true;
      if (aimNub) { const k = Math.min(m, (r.width / 2) || 40); aimNub.style.transform = `translate(${astick.dx * k}px,${astick.dy * k}px)`; }
    }
  }
  if (isTouch()) {
    stick.addEventListener('touchstart', e => { const t = e.changedTouches[0]; if (tstick.id === null) { tstick.id = t.identifier; setStick(t); } e.preventDefault(); }, { passive: false });
    fireBtn.addEventListener('touchstart', e => { const t = e.changedTouches[0]; if (astick.id === null) { astick.id = t.identifier; touchFire = true; setAim(t); } e.preventDefault(); }, { passive: false });
    window.addEventListener('touchmove', e => {
      let used = false;
      for (const t of e.changedTouches) {
        if (t.identifier === tstick.id) { setStick(t); used = true; }
        else if (t.identifier === astick.id) { setAim(t); used = true; }
      }
      if (used) e.preventDefault();
    }, { passive: false });
    const endTouch = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === tstick.id) { tstick.id = null; tstick.active = false; tstick.dx = tstick.dy = 0; nub.style.transform = ''; }
        else if (t.identifier === astick.id) { astick.id = null; astick.active = false; touchFire = false; if (aimNub) aimNub.style.transform = ''; }
      }
    };
    window.addEventListener('touchend', endTouch); window.addEventListener('touchcancel', endTouch);
  }

  // ---------- 충돌: 원 vs 사각형 ----------
  function collideCircleRect(cx, cy, cr, rx, ry, rw, rh) {
    const nx = clamp(cx, rx, rx + rw);
    const ny = clamp(cy, ry, ry + rh);
    const dx = cx - nx, dy = cy - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 > cr * cr) return null;
    const d = Math.sqrt(d2) || 0.0001;
    return { nx: dx / d, ny: dy / d, depth: cr - d, cornerX: nx, cornerY: ny };
  }
  function solidObstacles() { return obstacles; } // 벽/바위/상자 모두 솔리드

  // ---------- 올가미 발사 ----------
  const LASSO_REACH = 240;           // 기본 사거리(충전해도 늘지 않음)
  function throwLasso(c) {
    const L = c.lasso;
    if (c.state !== 'active' || c.cool > 0) return;
    if (L.state !== 'idle' && L.state !== 'charge') return;
    const ULT = L.holdTime >= 5;      // 5초↑ 충전 = 필살(사거리 1.2배)
    L.maxLen = ULT ? LASSO_REACH * 1.2 : LASSO_REACH;
    L.ult = ULT;
    const sp = 14;                    // 발사 속도(고정)
    L.state = 'throw';
    L.tx = c.x + Math.cos(c.aim) * c.r;
    L.ty = c.y + Math.sin(c.aim) * c.r;
    L.vx = Math.cos(c.aim) * sp;
    L.vy = Math.sin(c.aim) * sp;
    L.len = 0;
    L.hooked = null;
    L.charge = 0;
    L.holdTime = 0;
    c.cool = 0.45;
    puff(c.x + Math.cos(c.aim) * 18, c.y + Math.sin(c.aim) * 18, 4, ULT ? '#ffd24a' : '#fff6d8');
    if (ULT) { spark(c.x, c.y, '#ffd24a'); floater(c.x, c.y - 28, '필살 올가미!', '#ffd24a'); }
  }

  function freeJailSlot(jail) {
    for (const s of jail.slots) if (!s.taken) return s;
    return null;
  }

  // team 의 감옥 내부인지
  function insideJail(team, x, y) {
    const j = JAIL[team];
    return x > j.x - 8 && x < j.x + j.w + 8 && y > j.y - 8 && y < j.y + j.h + 8;
  }
  // 끌려오기 트윈 시작 (대상이 던진 사람 위치로 빨려옴)
  function reelTo(target, x, y) {
    target.reelFrom = { x: target.x, y: target.y };
    target.reelTo = { x: clamp(x, target.r, W - target.r), y: clamp(y, target.r, H - target.r) };
    target.reelT = 0;
    target.vx = target.vy = 0;
    target.lasso.state = 'idle';
  }

  // ① 적 포박: 던진 사람 위치로 끌어와 그 자리에서 포박(10초). 이동·올가미 불가
  function captureTarget(thrower, target) {
    target.state = 'bound';
    target.bindTimer = 10;
    target.captorTeam = thrower.team;
    if (target.jailSlot) { target.jailSlot.taken = null; target.jailSlot = null; }
    reelTo(target, thrower.x + Math.cos(thrower.aim) * 28, thrower.y + Math.sin(thrower.aim) * 28);
    floater(target.x, target.y - 24, '포박!', '#ffd27a');
    spark(target.x, target.y, COL[thrower.team].body);
    screenShake = Math.min(screenShake + 6, 12);
  }

  // ② 아군 구출: 던진 사람 위치로 이동, 포박은 3초 뒤 풀림
  function rescueTarget(rescuer, ally) {
    ally.bindTimer = 3;
    ally.captorTeam = null;
    reelTo(ally, rescuer.x + Math.cos(rescuer.aim) * 28, rescuer.y + Math.sin(rescuer.aim) * 28);
    floater(ally.x, ally.y - 24, '구출! 3초', '#9fffa0');
    for (let i = 0; i < 14; i++) {
      const a = rand(0, TAU);
      particles.push({ x: ally.x, y: ally.y, vx: Math.cos(a) * rand(1, 4), vy: Math.sin(a) * rand(1, 4), life: 1, col: '#9fffa0', r: rand(2, 4) });
    }
    screenShake = Math.min(screenShake + 5, 12);
  }

  // ③ 포박한 적 재포획: 던진 사람 위치로 끌고 옴 → 내 감옥 안이면 영구 수감(탈옥 불가)
  function regrabTarget(thrower, target) {
    const tx = thrower.x + Math.cos(thrower.aim) * 28, ty = thrower.y + Math.sin(thrower.aim) * 28;
    if (insideJail(thrower.team, thrower.x, thrower.y)) {
      const slot = freeJailSlot(JAIL[thrower.team]);
      if (slot) { slot.taken = target; target.jailSlot = slot; reelTo(target, slot.x, slot.y); }
      else reelTo(target, thrower.x, thrower.y);
      target.state = 'jailed';
      target.bindTimer = 0;
      target.captorTeam = thrower.team;
      floater(target.x, target.y - 26, '수감!', '#ff8a7a');
      spark(target.x, target.y, '#ff8a7a');
      screenShake = Math.min(screenShake + 7, 12);
    } else {
      target.bindTimer = 10;            // 다시 10초 포박
      reelTo(target, tx, ty);
      floater(target.x, target.y - 24, '끌려감', '#ffd27a');
    }
  }

  // 벽 그래플(넘기) 시작
  function startVault(c, anchor, wall) {
    // 벽 반대편으로 착지점 계산
    const cx = wall.x + wall.w / 2, cy = wall.y + wall.h / 2;
    let dx = cx - c.x, dy = cy - c.y;
    const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    const over = Math.max(wall.w, wall.h) * 0.5 + 34;
    c.state = 'vault';
    c.vaultT = 0;
    c.vaultFrom = { x: c.x, y: c.y };
    c.vaultTo = {
      x: clamp(cx + dx * over, 24, W - 24),
      y: clamp(cy + dy * over, 24, H - 24),
    };
    c.lasso.state = 'idle';
    c.lasso.hooked = null;
    floater(c.x, c.y - 22, '점프!', '#ffe9b0');
  }

  // ---------- 올가미 업데이트 ----------
  function updateLasso(c, dt) {
    const L = c.lasso;
    L.spin += dt * (L.state === 'charge' ? 16 : 9);

    if (L.state === 'throw') {
      const steps = 3; // 빠른 끝 보간으로 관통 방지
      for (let s = 0; s < steps; s++) {
        L.tx += L.vx / steps; L.ty += L.vy / steps;
        L.len = dist(c.x, c.y, L.tx, L.ty);
        if (resolveLassoHit(c)) return;
        if (L.len >= L.maxLen) { L.state = 'retract'; break; }
        if (L.tx < 0 || L.tx > W || L.ty < 0 || L.ty > H) { L.state = 'retract'; break; }
      }
    } else if (L.state === 'retract') {
      const dx = c.x - L.tx, dy = c.y - L.ty, d = Math.hypot(dx, dy);
      if (d < 16) { L.state = 'idle'; }
      else { L.tx += dx / d * 22; L.ty += dy / d * 22; }
    }
  }

  // 올가미 끝 충돌 판정
  function resolveLassoHit(c) {
    const L = c.lasso;
    // 1) 적/아군 카우보이
    for (const o of cowboys) {
      if (o === c) continue;
      const near = dist2(L.tx, L.ty, o.x, o.y) < (o.r + 8) * (o.r + 8);
      if (!near) continue;
      if (o.state === 'jailed') continue;            // 수감자는 손댈 수 없음(탈옥 불가)
      if (o.team !== c.team && o.state === 'active') { // 적 포박
        captureTarget(c, o); L.state = 'idle'; return true;
      }
      if (o.team === c.team && o.state === 'bound') {  // 포박된 아군 구출
        rescueTarget(c, o); L.state = 'idle'; return true;
      }
      if (o.team !== c.team && o.state === 'bound') {  // 포박한 적 재포획→감옥으로
        regrabTarget(c, o); L.state = 'idle'; return true;
      }
    }
    // 2) 벽 그래플 고리(넘기)
    for (const w of obstacles) {
      if (w.type !== 'wall') continue;
      if (dist2(L.tx, L.ty, w.anchor.x, w.anchor.y) < 26 * 26) {
        startVault(c, w.anchor, w); return true;
      }
    }
    // 3) 상자 끌어당기기
    for (const o of obstacles) {
      if (o.type !== 'crate') continue;
      if (collideCircleRect(L.tx, L.ty, 6, o.x, o.y, o.w, o.h)) {
        let dx = c.x - (o.x + o.w / 2), dy = c.y - (o.y + o.h / 2);
        const m = Math.hypot(dx, dy) || 1;
        o.vx += dx / m * 4.2; o.vy += dy / m * 4.2;
        puff(o.x + o.w / 2, o.y + o.h / 2, 5, '#caa36a');
        L.state = 'retract'; return true;
      }
    }
    // 4) 벽/바위에 막힘 — 로프가 뚫지 못함 (고리 조준 시 넘기는 위 2)에서 처리)
    for (const o of obstacles) {
      if (o.type === 'crate') continue;
      if (collideCircleRect(L.tx, L.ty, 4, o.x, o.y, o.w, o.h)) {
        puff(L.tx, L.ty, 4, 'rgba(120,90,50,.8)');
        L.state = 'retract'; return true;
      }
    }
    return false;
  }

  // ---------- 카우보이 이동 / 상태 ----------
  function moveCowboy(c, ax, ay, speed, dt) {
    // ax,ay: 입력 방향(정규화 전)
    const m = Math.hypot(ax, ay);
    if (m > 0.01) {
      ax /= m; ay /= m;
      c.vx = lerp(c.vx, ax * speed, 0.25);
      c.vy = lerp(c.vy, ay * speed, 0.25);
      c.face = Math.atan2(c.vy, c.vx);
      c.stepPhase += dt * 14;
      if (Math.random() < 0.25) puff(c.x - c.vx * 2, c.y + c.r - 2, 1, 'rgba(180,150,100,.6)');
    } else {
      c.vx *= 0.78; c.vy *= 0.78;
    }
    c.x += c.vx; c.y += c.vy;

    // 경계
    c.x = clamp(c.x, c.r, W - c.r);
    c.y = clamp(c.y, c.r, H - c.r);

    // 장애물 충돌 (점프 중엔 무시)
    if (c.z < 6) {
      for (const o of solidObstacles()) {
        const hit = collideCircleRect(c.x, c.y, c.r, o.x, o.y, o.w, o.h);
        if (hit) {
          c.x += hit.nx * hit.depth;
          c.y += hit.ny * hit.depth;
          c.vx *= 0.5; c.vy *= 0.5;
        }
      }
    }
  }

  function updateCrates() {
    for (const o of obstacles) {
      if (o.type !== 'crate') continue;
      o.x += o.vx; o.y += o.vy;
      o.vx *= 0.86; o.vy *= 0.86;
      o.x = clamp(o.x, 4, W - o.w - 4);
      o.y = clamp(o.y, 4, H - o.h - 4);
      // 상자끼리/벽과 단순 반발
      for (const p of obstacles) {
        if (p === o || p.type === 'crate') continue;
        const hit = collideCircleRect(o.x + o.w / 2, o.y + o.h / 2, o.w / 2 + 2, p.x, p.y, p.w, p.h);
        if (hit) { o.x += hit.nx * hit.depth; o.y += hit.ny * hit.depth; o.vx *= -0.3; o.vy *= -0.3; }
      }
    }
  }

  // ---------- 인간 플레이어 ----------
  function updatePlayer(c, dt) {
    if (c.state !== 'active') return;
    let ax = 0, ay = 0;
    if (keys['w'] || keys['arrowup']) ay -= 1;
    if (keys['s'] || keys['arrowdown']) ay += 1;
    if (keys['a'] || keys['arrowleft']) ax -= 1;
    if (keys['d'] || keys['arrowright']) ax += 1;
    if (tstick.active) { ax += tstick.dx; ay += tstick.dy; }

    const firing = mouse.down || touchFire || keys[' '];
    const L = c.lasso;
    const charging = firing && (L.state === 'idle' || L.state === 'charge') && c.cool <= 0;

    // 조준: 터치는 오른쪽 올가미 스틱(자유 360°), PC는 마우스. 이동(왼쪽)과 독립 → 동시 조작
    if (isTouch()) {
      c.aim = Math.atan2(astick.dy, astick.dx);
    } else {
      c.aim = Math.atan2(mouse.y - c.y, mouse.x - c.x);
    }

    let mvx = ax, mvy = ay;
    let speed = 3.0;
    // 조준(충전) 중 감속: 누르면 절반, 5초↑(필살)이면 다시 절반(=1/4)
    if (charging) {
      speed *= 0.5;
      if (L.holdTime >= 5) speed *= 0.5;
    }
    // 대시 (조준 중에는 불가)
    if ((keys['shift']) && !charging && c.dashCool <= 0 && (ax || ay)) {
      const m = Math.hypot(ax, ay) || 1;
      c.vx += ax / m * 9; c.vy += ay / m * 9;
      c.dashCool = 0.9;
      for (let i = 0; i < 8; i++) puff(c.x, c.y, 2, 'rgba(255,240,200,.7)');
    }
    moveCowboy(c, mvx, mvy, speed, dt);

    // 올가미: 누르고 있으면 충전(시간 누적), 떼면 발사
    if (charging) {
      L.state = 'charge';
      L.holdTime += dt;
      L.charge = clamp(L.holdTime / 0.6, 0, 1); // 시각용
    } else if (!firing && L.state === 'charge') {
      throwLasso(c);
    }
  }

  // ---------- 간단 AI ----------
  function nearest(c, pred) {
    let best = null, bd = Infinity;
    for (const o of cowboys) {
      if (o === c || !pred(o)) continue;
      const d = dist2(c.x, c.y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function blockedTowards(c, tx, ty) {
    // 목표 방향 약간 앞에 솔리드가 있는지
    const a = Math.atan2(ty - c.y, tx - c.x);
    const px = c.x + Math.cos(a) * (c.r + 14), py = c.y + Math.sin(a) * (c.r + 14);
    for (const o of solidObstacles()) {
      if (collideCircleRect(px, py, c.r, o.x, o.y, o.w, o.h)) return o;
    }
    return null;
  }

  function closestAllyTo(c, x, y) {
    // c 가 (x,y) 대상에 가장 가까운 '활동중' 아군인가
    for (const o of cowboys) {
      if (o === c || o.team !== c.team || o.state !== 'active') continue;
      if (dist2(o.x, o.y, x, y) < dist2(c.x, c.y, x, y)) return false;
    }
    return true;
  }
  function wander(c, dt) {
    const cx = c.team === 'red' ? W * 0.42 : W * 0.58;
    moveCowboy(c, cx - c.x, H / 2 - c.y, diff.aiSpeed * 0.5, dt);
  }

  function updateAI(c, dt) {
    if (c.state !== 'active') return;
    c.aiTimer -= dt;
    const L = c.lasso;

    // 후보 탐색
    let boundEnemy = nearest(c, o => o.team !== c.team && o.state === 'bound' && o.captorTeam === c.team);
    const captiveAlly = nearest(c, o => o.team === c.team && o.state === 'bound');
    const enemy = nearest(c, o => o.team !== c.team && o.state === 'active');

    // 포박한 적은 가장 가까운 한 명만 감옥으로 호송(나머지는 계속 사냥)
    if (boundEnemy && !closestAllyTo(c, boundEnemy.x, boundEnemy.y)) boundEnemy = null;

    let target = null, mode = 'hunt';
    if (boundEnemy) { target = boundEnemy; mode = 'jail'; }
    else if (captiveAlly && (!enemy || dist2(c.x, c.y, captiveAlly.x, captiveAlly.y) < dist2(c.x, c.y, enemy.x, enemy.y) * 0.8)) {
      target = captiveAlly; mode = 'rescue';
    } else if (enemy) { target = enemy; mode = 'hunt'; }

    if (!target) { wander(c, dt); return; }
    c.aiTarget = target;

    const d = dist(c.x, c.y, target.x, target.y);
    const toAng = Math.atan2(target.y - c.y, target.x - c.x);

    // 조준 빠르게 정렬 (대치에서 머뭇거리지 않도록)
    const jitter = (1 - diff.accuracy) * 0.45;
    c.aim = angLerp(c.aim, toAng + rand(-jitter, jitter), 0.3);

    // 호송(jail) 모드는 '내 감옥'으로 이동하며 포박한 적을 끌어당겨 점점 감옥으로
    const jailC = JAIL[c.team];
    const moveX = mode === 'jail' ? (jailC.x + jailC.w / 2) : target.x;
    const moveY = mode === 'jail' ? (jailC.y + jailC.h / 2) : target.y;
    const mvAng = Math.atan2(moveY - c.y, moveX - c.x);

    let ax = Math.cos(mvAng), ay = Math.sin(mvAng);
    const blocker = blockedTowards(c, moveX, moveY);
    if (blocker) {
      // 벽 옆으로 우회 (수직 방향, 위치에 따라 좌/우)
      ax = -Math.sin(mvAng); ay = Math.cos(mvAng);
      if (((c.y | 0) % 130) < 65) { ax = -ax; ay = -ay; }
      if (blocker.type === 'wall' && L.state === 'idle' && c.cool <= 0 && Math.random() < 0.05) {
        c.aim = Math.atan2(blocker.anchor.y - c.y, blocker.anchor.x - c.x);
        L.charge = 0.6; throwLasso(c);
      }
    } else if (mode === 'hunt' && d < diff.range * 0.6) {
      ax = 0; ay = 0;            // 사거리 안 → 멈춰서 조준·발사 (우왕좌왕 방지)
    } else if (mode === 'jail' && insideJail(c.team, c.x, c.y) && d < diff.range) {
      ax = 0; ay = 0;            // 감옥 안에서 끌어당기는 중
    }
    moveCowboy(c, ax, ay, diff.aiSpeed, dt);

    // 발사 판단
    const aimErr = Math.abs(((toAng - c.aim + Math.PI) % TAU) - Math.PI);
    const losBlocker = blockedTowards(c, target.x, target.y); // 표적까지 시야가 막혔나
    if (L.state === 'idle' && c.cool <= 0 && c.aiTimer <= 0 && !losBlocker && d < LASSO_REACH - 12 && aimErr < 0.3) {
      throwLasso(c);
      c.aiTimer = diff.cooldown + rand(0, diff.react);
    }
  }

  // ---------- 포박 / 수감 ----------
  function updateBound(c, dt) {
    // 끌려오기 트윈 (활동 상태가 아닐 때만)
    if (c.state !== 'active' && c.reelT != null && c.reelT < 1) {
      c.reelT = Math.min(1, c.reelT + dt * 4); // ~0.25초
      const t = c.reelT;
      c.x = lerp(c.reelFrom.x, c.reelTo.x, t);
      c.y = lerp(c.reelFrom.y, c.reelTo.y, t);
    }
    if (c.state === 'bound') {
      c.bindTimer -= dt;
      if (c.bindTimer <= 0) {            // ④/⑤ 시간 경과 시 포박 해제
        c.state = 'active'; c.captorTeam = null; c.bindTimer = 0;
        floater(c.x, c.y - 22, '해제!', '#cfe9ff');
      }
    } else if (c.state === 'jailed' && c.jailSlot && c.reelT >= 1) {
      c.x = c.jailSlot.x; c.y = c.jailSlot.y; // 감옥 슬롯 고정 (탈옥 불가)
    }
  }

  // ---------- 적 감옥 침투 → 갇힌 우리 팀 전원 탈옥 ----------
  function otherTeam(team) { return team === 'red' ? 'blue' : 'red'; }
  function checkJailbreak() {
    for (const c of cowboys) {
      if (c.state !== 'active') continue;
      // 우리 팀 포로는 '적 팀의 감옥(JAIL[적팀])'에 갇혀 있음 → 거기 침투하면 해방
      const enemy = otherTeam(c.team);
      if (!insideJail(enemy, c.x, c.y)) continue;
      for (const p of cowboys) {
        if (p.team !== c.team || p.state !== 'jailed') continue;
        if (p.jailSlot) { p.jailSlot.taken = null; p.jailSlot = null; }
        p.state = 'active'; p.bindTimer = 0; p.captorTeam = null; p.reelT = 1;
        p.x = clamp(c.x + rand(-26, 26), p.r, W - p.r);
        p.y = clamp(c.y + rand(-26, 26), p.r, H - p.r);
        p.vx = p.vy = 0; p.cool = 0.4;
        floater(p.x, p.y - 24, '탈옥!', '#9fffa0');
        spark(p.x, p.y, '#9fffa0');
      }
    }
  }

  // ---------- 넘기(점프 아크) ----------
  function updateVault(c, dt) {
    if (c.state !== 'vault') return;
    c.vaultT += dt * 1.7;
    const t = clamp(c.vaultT, 0, 1);
    c.x = lerp(c.vaultFrom.x, c.vaultTo.x, t);
    c.y = lerp(c.vaultFrom.y, c.vaultTo.y, t);
    c.z = Math.sin(t * Math.PI) * 46; // 포물선 높이
    if (t >= 1) { c.state = 'active'; c.z = 0; puff(c.x, c.y + c.r, 6, 'rgba(200,170,110,.7)'); }
  }

  // ---------- 파티클 ----------
  function puff(x, y, n, col) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      particles.push({ x, y, vx: Math.cos(a) * rand(.3, 1.6), vy: Math.sin(a) * rand(.3, 1.6) - .4, life: 1, col, r: rand(2, 5) });
    }
  }
  function spark(x, y, col) {
    for (let i = 0; i < 16; i++) {
      const a = rand(0, TAU), sp = rand(2, 6);
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col, r: rand(2, 4) });
    }
  }
  function floater(x, y, text, col) { floaters.push({ x, y, text, col, life: 1 }); }
  function updateParticles(dt) {
    for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life -= dt * 1.6; p.vx *= .96; p.vy *= .96; }
    particles = particles.filter(p => p.life > 0);
    for (const f of floaters) { f.y -= 0.6; f.life -= dt * 0.9; }
    floaters = floaters.filter(f => f.life > 0);
  }

  // ---------- 승패 판정 ----------
  function imprisoned(team) { return cowboys.filter(c => c.team === team && (c.state === 'jailed' || c.state === 'bound')).length; }
  function checkWin() {
    if (gameOver) return;
    const blueOut = imprisoned('blue'), redOut = imprisoned('red');
    if (blueOut >= 3) endGame(true, '적 카우보이 3명을 동시에 잡았다! 🤠');
    else if (redOut >= 3) endGame(false, '우리 팀이 모두 잡혔다… 🪢');
    else if (timeLeft <= 0) {
      if (blueOut > redOut) endGame(true, `시간 종료 — 더 많이 가둠 (${blueOut} : ${redOut})`);
      else if (redOut > blueOut) endGame(false, `시간 종료 — 더 많이 잡힘 (${blueOut} : ${redOut})`);
      else endGame(null, `무승부 (${blueOut} : ${redOut})`);
    }
  }
  function endGame(win, text) {
    gameOver = true; running = false;
    const r = document.getElementById('result');
    document.getElementById('resultTitle').textContent = win === null ? '무승부' : win ? '🏆 승리!' : '💀 패배';
    document.getElementById('resultText').textContent = text;
    r.classList.remove('hidden');
  }

  // ============================================================
  //  렌더링
  // ============================================================
  function drawGround() {
    // 모래 바닥 + 격자/질감
    ctx.fillStyle = '#d9b87f';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(160,130,80,.18)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // 중앙 라인
    ctx.strokeStyle = 'rgba(120,90,50,.35)';
    ctx.setLineDash([10, 10]);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawJail(j, prisonerTeam, label) {
    ctx.save();
    // 바닥 음영
    ctx.fillStyle = 'rgba(60,40,20,.18)';
    ctx.fillRect(j.x, j.y, j.w, j.h);
    // 창살
    ctx.strokeStyle = '#6b4a26';
    ctx.lineWidth = 5;
    ctx.strokeRect(j.x, j.y, j.w, j.h);
    ctx.lineWidth = 3;
    for (let x = j.x + 16; x < j.x + j.w; x += 16) {
      ctx.beginPath(); ctx.moveTo(x, j.y); ctx.lineTo(x, j.y + j.h); ctx.stroke();
    }
    // 라벨
    ctx.fillStyle = 'rgba(40,25,12,.7)';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, j.x + j.w / 2, j.y - 8);
    ctx.restore();
  }

  function drawObstacle(o) {
    ctx.save();
    if (o.type === 'wall') {
      // 돌담 + 그래플 고리
      ctx.fillStyle = '#8a6a45'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = '#9c7b52';
      for (let y = o.y; y < o.y + o.h; y += 18) {
        for (let x = o.x; x < o.x + o.w; x += 16) ctx.fillRect(x + 1, y + 1, 14, 16);
      }
      ctx.strokeStyle = '#5a4127'; ctx.lineWidth = 2; ctx.strokeRect(o.x, o.y, o.w, o.h);
      // 그래플 고리 (노란 링)
      const a = o.anchor;
      ctx.beginPath(); ctx.arc(a.x, a.y, 9, 0, TAU);
      ctx.lineWidth = 4; ctx.strokeStyle = '#ffd24a'; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = '#a07a18'; ctx.stroke();
    } else if (o.type === 'rock') {
      ctx.fillStyle = '#8d8577';
      ctx.beginPath(); ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#a39c8e';
      ctx.beginPath(); ctx.ellipse(o.x + o.w / 2 - 4, o.y + o.h / 2 - 6, o.w / 3, o.h / 4, 0, 0, TAU); ctx.fill();
    } else if (o.type === 'crate') {
      ctx.fillStyle = '#b9824a'; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeStyle = '#7a4f25'; ctx.lineWidth = 3; ctx.strokeRect(o.x, o.y, o.w, o.h);
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + o.w, o.y + o.h);
      ctx.moveTo(o.x + o.w, o.y); ctx.lineTo(o.x, o.y + o.h); ctx.stroke();
    }
    ctx.restore();
  }

  function drawCowboy(c) {
    const col = COL[c.team];
    const sx = c.x, sy = c.y;
    // 그림자 (점프 높이 반영)
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.ellipse(sx, sy + c.r - 2, c.r * (1 - c.z / 160), c.r * 0.5 * (1 - c.z / 200), 0, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.translate(sx, sy - c.z);

    // 다리(걷기 흔들)
    const sw = Math.sin(c.stepPhase) * 4;
    ctx.strokeStyle = col.dark; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-4, 6); ctx.lineTo(-5 + sw, 14); ctx.moveTo(4, 6); ctx.lineTo(5 - sw, 14); ctx.stroke();

    // 몸통
    ctx.fillStyle = col.body;
    ctx.beginPath(); ctx.arc(0, 0, c.r - 2, 0, TAU); ctx.fill();
    ctx.strokeStyle = col.dark; ctx.lineWidth = 2; ctx.stroke();
    // 어깨띠
    ctx.strokeStyle = col.sash; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-8, -6); ctx.lineTo(8, 8); ctx.stroke();

    // 모자
    ctx.fillStyle = col.hat;
    ctx.beginPath(); ctx.ellipse(0, -10, 13, 5, 0, 0, TAU); ctx.fill();     // 챙
    ctx.beginPath(); ctx.ellipse(0, -13, 7, 6, 0, 0, TAU); ctx.fill();      // 윗부분

    // 조준 방향 표시(총잡이 손/팔)
    ctx.strokeStyle = col.dark; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(c.aim) * 16, Math.sin(c.aim) * 16); ctx.stroke();

    ctx.restore();

    // 인간 플레이어 표식
    if (c.isHuman) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('YOU', sx, sy - c.z - 26);
      ctx.beginPath(); ctx.moveTo(sx, sy - c.z - 22); ctx.lineTo(sx - 4, sy - c.z - 18); ctx.lineTo(sx + 4, sy - c.z - 18); ctx.closePath();
      ctx.fill();
    }
    // 포박/수감 표시
    if (c.state === 'bound') {
      // 밧줄 감김
      ctx.strokeStyle = 'rgba(120,80,40,.9)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(sx, sy, c.r - 1, c.r * 0.55, 0, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
      const t = '🔒' + Math.ceil(c.bindTimer) + 's';
      ctx.strokeText(t, sx, sy - c.z - 22); ctx.fillText(t, sx, sy - c.z - 22);
    } else if (c.state === 'jailed') {
      ctx.fillStyle = 'rgba(255,190,190,.95)'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
      ctx.strokeText('⛓ 수감', sx, sy - c.z - 22); ctx.fillText('⛓ 수감', sx, sy - c.z - 22);
    }
  }

  function drawLasso(c) {
    const L = c.lasso;
    const col = c.team === 'red' ? '#fff2cf' : '#e9f1ff';
    if (L.state === 'idle') {
      // 머리 위 돌리는 올가미 루프 (대기)
      if (c.state === 'active') {
        ctx.save();
        ctx.translate(c.x, c.y - c.z - 22);
        ctx.rotate(L.spin);
        ctx.strokeStyle = 'rgba(120,80,40,.5)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(6, 0, 10, 5, 0, 0, TAU); ctx.stroke();
        ctx.restore();
      }
      return;
    }
    if (L.state === 'charge') {
      const ultReady = L.holdTime >= 5;
      const ratio = clamp(L.holdTime / 5, 0, 1); // 5초까지 차오름
      // 충전: 회전 올가미 (필살 차오를수록 커지고 금색)
      ctx.save();
      ctx.translate(c.x, c.y - c.z - 24);
      ctx.rotate(L.spin);
      const rr = 9 + ratio * 15;
      ctx.strokeStyle = ultReady ? '#ffd24a' : '#caa05a';
      ctx.lineWidth = ultReady ? 4 : 3;
      ctx.beginPath(); ctx.ellipse(rr * 0.6, 0, rr, rr * 0.55, 0, 0, TAU); ctx.stroke();
      ctx.restore();
      // 조준 가이드 (사거리 고정, 필살이면 1.2배·금색)
      const gl = ultReady ? LASSO_REACH * 1.2 : LASSO_REACH;
      ctx.strokeStyle = ultReady ? 'rgba(255,210,74,.6)' : 'rgba(255,255,255,.28)';
      ctx.setLineDash([6, 8]); ctx.lineWidth = ultReady ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(c.x, c.y - c.z);
      ctx.lineTo(c.x + Math.cos(c.aim) * gl, c.y + Math.sin(c.aim) * gl);
      ctx.stroke(); ctx.setLineDash([]);
      // 필살 충전 표시
      if (c.isHuman && !ultReady && L.holdTime > 0.4) {
        ctx.fillStyle = '#ffe9b0'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('필살 충전 ' + Math.ceil(5 - L.holdTime) + 's', c.x, c.y - c.z - 40);
      } else if (c.isHuman && ultReady) {
        ctx.fillStyle = '#ffd24a'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('⚡필살 준비!', c.x, c.y - c.z - 40);
      }
      return;
    }
    // throw / retract : 밧줄 + 끝 올가미 루프
    ctx.strokeStyle = '#9c6b35'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath();
    // 살짝 늘어진 곡선
    const mx = (c.x + L.tx) / 2 + Math.cos(L.spin) * 3;
    const my = (c.y + L.ty) / 2 + Math.sin(L.spin) * 3;
    ctx.moveTo(c.x, c.y - c.z); ctx.quadraticCurveTo(mx, my, L.tx, L.ty);
    ctx.stroke();
    // 끝 올가미 고리
    ctx.save(); ctx.translate(L.tx, L.ty); ctx.rotate(L.spin * 2);
    ctx.strokeStyle = '#b9824a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, 11, 7, 0, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const f of floaters) {
      ctx.globalAlpha = clamp(f.life, 0, 1);
      ctx.fillStyle = f.col; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
      ctx.strokeText(f.text, f.x, f.y); ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.save();
    if (screenShake > 0.2) ctx.translate(rand(-screenShake, screenShake), rand(-screenShake, screenShake));
    drawGround();
    drawJail(JAIL.red, 'blue', '레드 감옥');
    drawJail(JAIL.blue, 'red', '블루 감옥');
    for (const o of obstacles) drawObstacle(o);
    // 카우보이를 y순으로 정렬해 겹침 자연스럽게
    const sorted = [...cowboys].sort((a, b) => a.y - b.y);
    for (const c of sorted) { drawLasso(c); drawCowboy(c); }
    drawParticles();
    ctx.restore();
    if (running) drawHUD();   // 게임판을 가리지 않게 캔버스 상단 얇은 띠에 표시
  }

  // ---------- HUD (캔버스 내, 상단 빈 영역) ----------
  function fmtTime(s) {
    s = Math.max(0, Math.ceil(s));
    const m = Math.floor(s / 60), ss = s % 60;
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  function pill(x, y, w, h) {
    const r = h / 2;
    ctx.fillStyle = 'rgba(20,12,6,.5)';
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }
  function drawHUD() {
    const rc = imprisoned('red'), bc = imprisoned('blue');
    ctx.save();
    ctx.textBaseline = 'middle';
    const y = 7, h = 24, cy = y + h / 2;
    // 좌: 레드 갇힘
    pill(8, y, 138, h);
    ctx.fillStyle = COL.red.body; ctx.beginPath(); ctx.arc(22, cy, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`레드 갇힘 ${rc}/3`, 34, cy + 1);
    // 우: 블루 갇힘
    pill(W - 146, y, 138, h);
    ctx.fillStyle = COL.blue.body; ctx.beginPath(); ctx.arc(W - 22, cy, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'right';
    ctx.fillText(`블루 갇힘 ${bc}/3`, W - 34, cy + 1);
    // 중앙: 타이머
    pill(W / 2 - 44, y, 88, h);
    ctx.fillStyle = '#ffe9b0'; ctx.font = 'bold 17px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(fmtTime(timeLeft), W / 2, cy + 1);
    ctx.restore();
  }

  // ============================================================
  //  메인 루프 (고정 timestep)
  // ============================================================
  let last = 0, acc = 0;
  const STEP = 1 / 60;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!last) last = ts;
    let dt = (ts - last) / 1000; last = ts;
    if (dt > 0.1) dt = 0.1;

    if (running) {
      acc += dt;
      while (acc >= STEP) { step(STEP); acc -= STEP; }
      timeLeft -= dt;
    }
    render();
  }

  function step(dt) {
    screenShake *= 0.86;
    for (const c of cowboys) {
      c.cool = Math.max(0, c.cool - dt);
      c.dashCool = Math.max(0, c.dashCool - dt);
      if (c.isHuman) updatePlayer(c, dt);
      else updateAI(c, dt);
      updateBound(c, dt);
      updateVault(c, dt);
      updateLasso(c, dt);
    }
    updateCrates();
    checkJailbreak();
    updateParticles(dt);
    checkWin();
  }

  // ============================================================
  //  UI 연결
  // ============================================================
  const menu = document.getElementById('menu');
  const result = document.getElementById('result');
  const hud = document.getElementById('hud');

  document.querySelectorAll('.diff').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.diff').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      diff = DIFF[b.dataset.diff];
    });
  });

  function startGame() {
    diff = DIFF[document.querySelector('.diff.active').dataset.diff] || DIFF.normal;
    menu.classList.add('hidden');
    result.classList.add('hidden');
    if (isTouch()) touchUI.classList.remove('hidden');
    resetGame();
  }
  document.getElementById('startBtn').addEventListener('click', startGame);
  document.getElementById('againBtn').addEventListener('click', startGame);

  requestAnimationFrame(frame);
})();
