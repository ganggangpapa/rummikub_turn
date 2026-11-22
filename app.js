/* 루미큐브 턴 매니저 — 의존성 없는 순수 JS PWA */
(() => {
  'use strict';

  const STORAGE_KEY = 'rummikub-turn-v1';
  const TOTAL_TILES = 106;
  const COLORS = ['#d23b3b', '#2f5fa8', '#e0a019', '#222222', '#2e9a5a', '#8e44ad'];
  const DEFAULT_NAMES = ['플레이어 1', '플레이어 2', '플레이어 3', '플레이어 4', '플레이어 5', '플레이어 6'];

  const $ = (s) => document.querySelector(s);
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  };
  const uid = () => Math.random().toString(36).slice(2, 9);

  // ---------- 상태 ----------
  const defaultState = () => ({
    view: 'setup',
    settings: { turnSeconds: 60, warnSeconds: 10, penaltyDraw: 3, startHand: 14, autoStart: true, sound: true, vibrate: true, tableMode: 'manual', autoCapture: true },
    players: [
      { id: uid(), name: DEFAULT_NAMES[0], color: COLORS[0] },
      { id: uid(), name: DEFAULT_NAMES[1], color: COLORS[1] },
      { id: uid(), name: DEFAULT_NAMES[2], color: COLORS[2] },
      { id: uid(), name: DEFAULT_NAMES[3], color: COLORS[3] },
    ],
    game: null,
    rounds: [],
    placeCount: 3,
  });

  let state;
  try {
    state = Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || {});
  } catch { state = defaultState(); }
  // 새 버전에서 추가된 설정값도 채워 넣음
  state.settings = { ...defaultState().settings, ...state.settings };
  // 새로고침 후에는 항상 일시정지 상태로 복원
  if (state.game && state.game.running) {
    state.game.remaining = Math.max(0, (state.game.endsAt - Date.now()) / 1000);
    state.game.running = false;
  }

  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 저장 불가 환경 */ } };
  const player = (id) => state.players.find((p) => p.id === id) || { name: '?', color: '#999' };

  // ---------- 사운드 / 진동 ----------
  let audioCtx;
  const beep = (freq = 880, dur = 0.12, vol = 0.15) => {
    if (!state.settings.sound) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(vol, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch { /* 무시 */ }
  };
  const buzz = (p) => { if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(p); };

  // ---------- 화면 꺼짐 방지 ----------
  let wakeLock = null;
  const keepAwake = async (on) => {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { /* 미지원 */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.game?.running) keepAwake(true);
  });

  // ---------- 토스트 ----------
  let toastTimer;
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  };

  // ---------- 탭 이동 ----------
  const show = (view) => {
    if (view !== 'game') stopCam();
    state.view = view; save();
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    render();
  };
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // =========================================================
  // 1. 플레이어 설정
  // =========================================================
  const renderSetup = () => {
    const list = $('#playerList');
    list.replaceChildren();
    const locked = !!state.game;
    state.players.forEach((p, i) => {
      list.append(el('li', {},
        el('button', {
          class: 'swatch', style: `background:${p.color}`, title: '색 바꾸기', 'aria-label': '색 바꾸기',
          onclick: () => { p.color = COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length]; save(); renderSetup(); },
        }),
        el('input', {
          type: 'text', value: p.name, maxLength: 12, 'aria-label': `플레이어 ${i + 1} 이름`,
          oninput: (e) => { p.name = e.target.value || DEFAULT_NAMES[i]; save(); },
        }),
        el('button', { class: 'mini', textContent: '▲', disabled: i === 0 || locked, onclick: () => movePlayer(i, -1) }),
        el('button', { class: 'mini', textContent: '▼', disabled: i === state.players.length - 1 || locked, onclick: () => movePlayer(i, 1) }),
        el('button', {
          class: 'mini', textContent: '✕', disabled: state.players.length <= 2 || locked,
          onclick: () => { state.players.splice(i, 1); save(); renderSetup(); },
        }),
      ));
    });
    $('#addPlayerBtn').disabled = state.players.length >= 6 || locked;
    $('#shuffleBtn').disabled = locked;

    const s = state.settings;
    for (const k of ['turnSeconds', 'warnSeconds', 'penaltyDraw', 'startHand']) $('#' + k).value = s[k];
    for (const k of ['autoStart', 'sound', 'vibrate']) $('#' + k).checked = s[k];
    document.querySelectorAll('#timeChips button').forEach((b) => b.classList.toggle('on', +b.dataset.sec === s.turnSeconds));
    document.querySelectorAll('#tableModeChips button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (s.tableMode || 'manual')));
    $('#startGameBtn').textContent = state.game ? '진행 중인 게임으로 ▶' : '게임 시작 ▶';
  };

  const movePlayer = (i, d) => {
    const j = i + d;
    [state.players[i], state.players[j]] = [state.players[j], state.players[i]];
    save(); renderSetup();
  };

  $('#addPlayerBtn').addEventListener('click', () => {
    const used = new Set(state.players.map((p) => p.color));
    const n = state.players.length;
    state.players.push({ id: uid(), name: DEFAULT_NAMES[n], color: COLORS.find((c) => !used.has(c)) || COLORS[n % COLORS.length] });
    save(); renderSetup();
  });
  $('#shuffleBtn').addEventListener('click', () => {
    const a = state.players;
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    save(); renderSetup(); toast(`선 플레이어: ${a[0].name}`);
  });
  const clampNum = (v, min, max, fallback) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback; };

  // 턴 시간 변경 — 게임 중에도 가능. 진행 중인 턴은 이미 쓴 시간을 유지한 채 새 시간으로 바뀜
  const setTurnSeconds = (sec) => {
    sec = clampNum(sec, 10, 600, state.settings.turnSeconds);
    const old = state.settings.turnSeconds;
    if (sec === old) return;
    const g = state.game;
    const elapsed = g ? Math.max(0, old - remainingNow()) : 0;
    state.settings.turnSeconds = sec;
    if (g) {
      if (g.timedOut || remainingNow() <= 0) g.remaining = sec;
      else {
        const left = Math.max(1, sec - elapsed);
        if (g.running) g.endsAt = Date.now() + left * 1000;
        else g.remaining = left;
      }
      lastWholeSec = null;
    }
    save(); render();
    if (g) toast(`턴 시간 ${sec}초로 변경`);
  };

  document.querySelectorAll('#timeChips button, #gameTimeChips button').forEach((b) => b.addEventListener('click', () => setTurnSeconds(+b.dataset.sec)));
  $('#ttMinus').addEventListener('click', () => setTurnSeconds(state.settings.turnSeconds - 10));
  $('#ttPlus').addEventListener('click', () => setTurnSeconds(state.settings.turnSeconds + 10));
  $('#turnSeconds').addEventListener('change', (e) => { setTurnSeconds(e.target.value); renderSetup(); });
  [['warnSeconds', 0, 60], ['penaltyDraw', 0, 5], ['startHand', 1, 20]].forEach(([k, min, max]) => {
    $('#' + k).addEventListener('change', (e) => {
      state.settings[k] = clampNum(e.target.value, min, max, state.settings[k]);
      save(); renderSetup();
    });
  });
  ['autoStart', 'sound', 'vibrate'].forEach((k) => $('#' + k).addEventListener('change', (e) => { state.settings[k] = e.target.checked; save(); }));

  $('#startGameBtn').addEventListener('click', () => {
    if (!state.game) newRound();
    show('game');
  });

  const newRound = () => {
    const hands = {}, melded = {};
    state.players.forEach((p) => { hands[p.id] = state.settings.startHand; melded[p.id] = false; });
    const prevLog = state.game?.log || [];
    clearPhotos(); // 새 라운드는 빈 테이블에서 시작하므로 지난 사진 정리
    const roundNo = state.rounds.length + 1;
    // 라운드마다 선 플레이어를 한 칸씩 돌림
    const startIdx = (roundNo - 1) % state.players.length;
    state.game = {
      round: roundNo,
      order: state.players.map((p) => p.id),
      current: startIdx,
      turnNo: 1,
      remaining: state.settings.turnSeconds,
      running: false,
      endsAt: 0,
      turnStartedAt: null,
      hands, melded,
      pool: TOTAL_TILES - state.settings.startHand * state.players.length,
      log: prevLog,
      history: [],
      timedOut: false,
      table: [],            // 테이블 위 세트들: [[{c, n}, ...], ...]
      tableAtTurnStart: [], // 이번 턴이 시작될 때의 테이블 (되돌리기 기준)
    };
    save();
  };

  // =========================================================
  // 2. 모래시계 타이머
  // =========================================================
  let rafId = null, lastWholeSec = null;

  const remainingNow = () => {
    const g = state.game;
    if (!g) return 0;
    return g.running ? Math.max(0, (g.endsAt - Date.now()) / 1000) : g.remaining;
  };

  const startTimer = () => {
    const g = state.game; if (!g || g.running) return;
    if (g.remaining <= 0) g.remaining = state.settings.turnSeconds;
    g.running = true;
    g.endsAt = Date.now() + g.remaining * 1000;
    g.turnStartedAt ||= Date.now();
    g.timedOut = false;
    save(); keepAwake(true); tick(); renderGame();
  };
  const pauseTimer = () => {
    const g = state.game; if (!g || !g.running) return;
    g.remaining = remainingNow(); g.running = false;
    save(); cancelAnimationFrame(rafId); keepAwake(false); drawHourglass(); renderGame();
  };
  const resetTimer = (autostart) => {
    const g = state.game; if (!g) return;
    g.running = false; g.remaining = state.settings.turnSeconds; g.timedOut = false;
    cancelAnimationFrame(rafId);
    const hg = $('#hourglass'); hg.classList.add('flip'); setTimeout(() => hg.classList.remove('flip'), 50);
    lastWholeSec = null;
    if (autostart) startTimer(); else { save(); drawHourglass(); renderGame(); }
  };

  const tick = () => {
    const g = state.game; if (!g || !g.running) return;
    const r = remainingNow();
    const whole = Math.ceil(r);
    if (whole !== lastWholeSec) {
      lastWholeSec = whole;
      if (whole <= state.settings.warnSeconds && whole > 0) { beep(whole <= 3 ? 1200 : 880, 0.08, 0.12); if (whole <= 3) buzz(60); }
    }
    drawHourglass();
    if (r <= 0) { onTimeout(); return; }
    rafId = requestAnimationFrame(tick);
  };

  const drawHourglass = () => {
    const g = state.game; if (!g) return;
    const total = state.settings.turnSeconds;
    const r = remainingNow();
    const f = Math.max(0, Math.min(1, r / total)); // 위쪽에 남은 모래 비율
    // 위쪽: 모래 표면이 아래로 내려감 (y 12 → 96)
    const topY = 12 + (1 - f) * 84;
    $('#sandTop').setAttribute('y', topY.toFixed(2));
    $('#sandTop').setAttribute('height', (96 - topY).toFixed(2));
    // 아래쪽: 모래가 쌓임 (y 188 → 104)
    const botH = (1 - f) * 84;
    $('#sandBot').setAttribute('y', (188 - botH).toFixed(2));
    $('#sandBot').setAttribute('height', botH.toFixed(2));
    $('#sandStream').setAttribute('y2', (188 - botH).toFixed(2));

    const wrap = $('#hourglassWrap');
    wrap.classList.toggle('running', g.running && r > 0);
    wrap.classList.toggle('warn', r > 0 && r <= state.settings.warnSeconds);
    wrap.classList.toggle('timeout', r <= 0);
    $('#timeText').textContent = r <= 0 ? '0' : (r >= 60 ? `${Math.floor(Math.ceil(r) / 60)}:${String(Math.ceil(r) % 60).padStart(2, '0')}` : String(Math.ceil(r)));
  };

  const onTimeout = () => {
    const g = state.game;
    g.running = false; g.remaining = 0; g.timedOut = true;
    keepAwake(false);
    beep(440, 0.5, 0.2); setTimeout(() => beep(330, 0.6, 0.2), 250);
    buzz([200, 100, 300]);
    const p = player(g.order[g.current]);
    const pen = state.settings.penaltyDraw;
    // 공식 규칙: 시간 초과 시 테이블을 턴 시작 상태로 돌려놓고 패널티
    const restored = tableChangedThisTurn();
    if (restored) restoreTable();
    endTurn('timeout', pen);
    toast(`⏰ ${p.name} 시간 초과! 패널티 ${pen}장` + (restored ? ' · 테이블 되돌림' : ''));
  };

  $('#hourglassWrap').addEventListener('click', () => {
    if (!state.game) return;
    state.game.running ? pauseTimer() : startTimer();
  });
  $('#pauseBtn').addEventListener('click', () => (state.game?.running ? pauseTimer() : startTimer()));
  $('#resetTimerBtn').addEventListener('click', () => resetTimer(state.game?.running));

  // =========================================================
  // 턴 종료 / 큐브 표시판
  // =========================================================
  const snapshot = () => {
    const { history, log, ...rest } = state.game;
    return JSON.stringify({ ...rest, logLen: log.length });
  };

  const endTurn = (action, tiles) => {
    const g = state.game; if (!g) return;
    const pid = g.order[g.current];
    g.history.push(snapshot());
    if (g.history.length > 100) g.history.shift();

    const elapsed = action === 'timeout'
      ? state.settings.turnSeconds
      : Math.round(state.settings.turnSeconds - remainingNow());

    if (action === 'place') {
      g.hands[pid] = Math.max(0, g.hands[pid] - tiles);
      g.melded[pid] = true;
    } else {
      const n = Math.min(tiles, g.pool);
      g.hands[pid] += n; g.pool -= n;
      tiles = n;
    }
    g.log.push({ round: g.round, turn: g.turnNo, pid, action, tiles, elapsed, hand: g.hands[pid], at: Date.now() });

    // 촬영 모드: 내려놓고 턴을 끝낼 때 테이블을 자동으로 찍어 다음 턴의 기준 사진으로 남김
    if (action === 'place' && state.settings.tableMode === 'photo' && state.settings.autoCapture && camReady()) {
      captureFromCamera({ round: g.round, turn: g.turnNo, pid, kind: 'auto' });
    }

    // 턴이 끝나면 지금 테이블이 다음 턴의 기준(되돌리기 지점)이 됨
    ensureTable(g);
    g.tableAtTurnStart = clone(g.table);
    resetTableUi();

    if (action === 'place' && g.hands[pid] === 0) {
      g.running = false; cancelAnimationFrame(rafId); keepAwake(false);
      save(); render();
      beep(660, 0.15); setTimeout(() => beep(880, 0.15), 150); setTimeout(() => beep(1320, 0.3), 300);
      toast(`🎉 ${player(pid).name} 루미큐브! 점수를 입력하세요`);
      openScoreEntry(pid);
      return;
    }

    g.current = (g.current + 1) % g.order.length;
    g.turnNo += 1;
    g.turnStartedAt = null;
    // 시간 초과 후에는 다음 사람이 준비되도록 자동 시작하지 않음
    resetTimer(action === 'timeout' ? false : state.settings.autoStart);
    save(); render();
  };

  const undo = () => {
    const g = state.game; if (!g || !g.history.length) return;
    const prev = JSON.parse(g.history.pop());
    const log = g.log.slice(0, prev.logLen); delete prev.logLen;
    Object.assign(g, prev, { log, history: g.history, running: false, remaining: state.settings.turnSeconds, turnStartedAt: null });
    resetTableUi();
    cancelAnimationFrame(rafId); keepAwake(false);
    save(); render(); toast('이전 턴으로 되돌렸어요');
  };

  // 드로우: 이번 턴에 테이블을 건드렸다면 턴 시작 상태로 되돌린 뒤 드로우
  const drawAction = () => {
    if (tableChangedThisTurn()) {
      if (!confirm('이번 턴에 테이블이 바뀌었어요.\n턴 시작 상태로 되돌리고 드로우할까요?')) return;
      restoreTable();
    }
    endTurn('draw', 1);
  };
  // 내려놓기: 테이블에 잘못된 세트가 있으면 한 번 더 확인
  const placeAction = () => {
    const g = state.game; if (!g) return;
    ensureTable(g);
    const bad = g.table.map((s, i) => [i + 1, classify(s)]).filter(([, c]) => !c.ok);
    if (bad.length && !confirm(`세트 ${bad.map(([i]) => i).join(', ')}이(가) 올바르지 않아요.\n그래도 턴을 끝낼까요?`)) return;
    endTurn('place', state.placeCount);
  };
  $('#drawBtn').addEventListener('click', drawAction);
  $('#placeBtn').addEventListener('click', placeAction);
  $('#placeMinus').addEventListener('click', () => { state.placeCount = Math.max(1, state.placeCount - 1); save(); renderGame(); });
  $('#placePlus').addEventListener('click', () => { state.placeCount = Math.min(30, state.placeCount + 1); save(); renderGame(); });
  $('#undoBtn').addEventListener('click', undo);
  $('#endRoundBtn').addEventListener('click', () => { pauseTimer(); openScoreEntry(null); });

  const renderGame = () => {
    const g = state.game;
    $('#noGame').hidden = !!g;
    $('#gameArea').hidden = !g;
    if (!g) return;
    const cur = player(g.order[g.current]);
    const nxt = player(g.order[(g.current + 1) % g.order.length]);
    $('#roundTag').textContent = `라운드 ${g.round} · 턴 ${g.turnNo}`;
    $('#currentName').replaceChildren(el('span', { class: 'dot', style: `background:${cur.color}` }), cur.name);
    $('#nextName').textContent = `다음: ${nxt.name}`;
    $('#pauseBtn').textContent = g.running ? '⏸ 멈춤' : (g.remaining < state.settings.turnSeconds && g.remaining > 0 ? '▶ 재개' : '▶ 시작');
    const ts = state.settings.turnSeconds;
    $('#ttValue').textContent = `${ts}초`;
    $('#ttMinus').disabled = ts <= 10;
    $('#ttPlus').disabled = ts >= 600;
    document.querySelectorAll('#gameTimeChips button').forEach((b) => b.classList.toggle('on', +b.dataset.sec === ts));
    $('#undoBtn').disabled = !g.history.length;
    $('#placeCount').textContent = state.placeCount;
    $('#drawBtn').textContent = g.pool > 0 ? '드로우 후 턴 종료 (+1)' : '풀이 비었어요 — 패스';
    $('#poolCount').textContent = g.pool;

    const board = $('#cubeBoard');
    board.replaceChildren();
    g.order.forEach((pid, idx) => {
      const p = player(pid);
      const n = g.hands[pid];
      const cubes = el('div', { class: 'cubes', 'aria-label': `${n}장` });
      for (let i = 0; i < n; i++) cubes.append(el('span', { class: 'cube c', style: `--pc:${p.color}` }));
      board.append(el('li', { class: idx === g.current ? 'current' : '' },
        el('div', { class: 'pname' }, p.name,
          el('span', { class: 'badge' + (g.melded[pid] ? ' meld' : ''), textContent: g.melded[pid] ? '✔ 등록 완료' : '등록 전 (30점↑)' })),
        cubes,
        el('div', { style: 'display:flex;align-items:center;gap:6px' },
          el('span', { class: 'count', textContent: n }),
          el('div', { class: 'adj' },
            el('button', { textContent: '−', title: '손패 보정 -1', onclick: () => { g.hands[pid] = Math.max(0, n - 1); save(); renderGame(); } }),
            el('button', { textContent: '+', title: '손패 보정 +1', onclick: () => { g.hands[pid] = n + 1; save(); renderGame(); } }),
          )),
      ));
    });
    renderTableMode();
    drawHourglass();
  };

  // =========================================================
  // 테이블 기록 (내려놓은 큐브 체크)
  // =========================================================
  const TILE_COLORS = [
    { c: 'r', name: '빨강', hex: '#d23b3b' },
    { c: 'b', name: '파랑', hex: '#2f5fa8' },
    { c: 'y', name: '주황', hex: '#e08a00' },
    { c: 'k', name: '검정', hex: '#222222' },
  ];
  const TILE_HEX = Object.fromEntries(TILE_COLORS.map((t) => [t.c, t.hex]));
  const TILE_NAME = Object.fromEntries(TILE_COLORS.map((t) => [t.c, t.name]));
  const COLOR_ORDER = { r: 0, b: 1, y: 2, k: 3 };
  const isJoker = (t) => t.c === 'j';
  const tileKey = (t) => (isJoker(t) ? 'j' : t.c + t.n);
  const countTiles = (sets) => sets.reduce((a, s) => a + s.length, 0);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let tableSel = [];     // 선택한 큐브 [{ s: 세트 번호, i: 큐브 번호 }]
  let activeSet = -1;    // 큐브를 추가할 세트 (-1 = 새 세트)
  let pickerOpen = false;
  let prevOpen = false;

  const ensureTable = (g) => { g.table ||= []; g.tableAtTurnStart ||= []; };
  const resetTableUi = () => { tableSel = []; activeSet = -1; pickerOpen = false; prevOpen = false; };
  const tableChangedThisTurn = () => {
    const g = state.game; if (!g) return false;
    ensureTable(g);
    return JSON.stringify(g.table) !== JSON.stringify(g.tableAtTurnStart);
  };
  const restoreTable = () => {
    const g = state.game;
    g.table = clone(g.tableAtTurnStart);
    resetTableUi();
  };

  // 세트 검사: 그룹(같은 숫자·다른 색 3~4장) 또는 런(같은 색 연속 숫자 3장 이상), 조커는 아무 큐브나 대신함
  const classify = (set) => {
    if (set.length < 3) return { ok: false, label: '3장 이상 필요' };
    const real = set.filter((t) => !isJoker(t));
    const jokers = set.length - real.length;
    if (!real.length) return { ok: true, label: '조커' };
    if (real.every((t) => t.n === real[0].n)) {
      if (new Set(real.map((t) => t.c)).size === real.length && set.length <= 4) return { ok: true, label: '그룹' };
      if (!real.every((t) => t.c === real[0].c)) return { ok: false, label: set.length > 4 ? '그룹은 4장까지' : '같은 색 중복' };
    }
    if (real.every((t) => t.c === real[0].c)) {
      const ns = real.map((t) => t.n).sort((a, b) => a - b);
      if (new Set(ns).size !== ns.length) return { ok: false, label: '같은 숫자 중복' };
      const gaps = ns[ns.length - 1] - ns[0] + 1 - ns.length;
      if (gaps <= jokers && set.length <= 13) return { ok: true, label: '런' };
      return { ok: false, label: '숫자가 이어지지 않음' };
    }
    return { ok: false, label: '색·숫자 조합 오류' };
  };

  // 보기 좋게 정렬: 런은 숫자순(빈칸에 조커), 그룹은 색 순서
  const sortSet = (set) => {
    const real = set.filter((t) => !isJoker(t));
    const jokers = set.filter(isJoker);
    const isRun = real.length > 1 && real.every((t) => t.c === real[0].c) && new Set(real.map((t) => t.n)).size === real.length;
    if (!isRun) {
      real.sort((a, b) => a.n - b.n || COLOR_ORDER[a.c] - COLOR_ORDER[b.c]);
      return [...real, ...jokers];
    }
    real.sort((a, b) => a.n - b.n);
    const out = [];
    real.forEach((t, k) => {
      if (k > 0) for (let n = real[k - 1].n + 1; n < t.n && jokers.length; n++) out.push(jokers.pop());
      out.push(t);
    });
    let hi = real[real.length - 1].n;
    while (jokers.length) { if (hi < 13) { out.push(jokers.pop()); hi++; } else out.unshift(jokers.pop()); }
    return out;
  };

  const tileEl = (t, { selected = false, disabled = false, onclick } = {}) => el(onclick ? 'button' : 'span', {
    class: 'tile' + (isJoker(t) ? ' joker' : '') + (selected ? ' sel' : ''),
    style: isJoker(t) ? '' : `--tc:${TILE_HEX[t.c]}`,
    textContent: isJoker(t) ? '☺' : t.n,
    title: isJoker(t) ? '조커' : `${TILE_NAME[t.c]} ${t.n}`,
    'aria-label': isJoker(t) ? '조커' : `${TILE_NAME[t.c]} ${t.n}`,
    disabled, onclick,
  });

  // 테이블이 바뀔 때마다: 빈 세트 정리, 저장, '내려놓기 장수'를 이번 턴에 늘어난 수로 맞춤
  const tableChanged = () => {
    const g = state.game;
    const activeRef = g.table[activeSet];
    g.table = g.table.filter((s) => s.length);
    activeSet = activeRef && activeRef.length ? g.table.indexOf(activeRef) : -1;
    const diff = countTiles(g.table) - countTiles(g.tableAtTurnStart);
    if (diff > 0) state.placeCount = diff;
    save(); renderGame();
  };

  const addTile = (t) => {
    const g = state.game;
    if (activeSet < 0 || !g.table[activeSet]) { g.table.push([]); activeSet = g.table.length - 1; }
    g.table[activeSet] = sortSet([...g.table[activeSet], { ...t }]);
    tableChanged();
  };

  const takeSelected = () => {
    const g = state.game;
    const picked = [...tableSel].sort((a, b) => b.s - a.s || b.i - a.i);
    const tiles = picked.map(({ s, i }) => g.table[s].splice(i, 1)[0]).reverse();
    tableSel = [];
    return tiles;
  };

  const moveSelectedTo = (target) => {
    const g = state.game;
    const targetRef = target >= 0 ? g.table[target] : null;
    const tiles = takeSelected();
    if (targetRef) {
      const idx = g.table.indexOf(targetRef);
      g.table[idx] = sortSet([...targetRef, ...tiles]);
      activeSet = idx;
    } else {
      g.table.push(sortSet(tiles));
      activeSet = g.table.length - 1;
    }
    tableChanged();
  };

  const onTileTap = (s, i) => {
    const k = tableSel.findIndex((x) => x.s === s && x.i === i);
    if (k >= 0) tableSel.splice(k, 1); else tableSel.push({ s, i });
    renderTable();
  };
  const onSetTap = (s) => {
    if (tableSel.length) {
      // 선택한 큐브가 모두 이 세트 안에 있으면 이동하지 않음
      if (tableSel.every((x) => x.s === s)) return;
      moveSelectedTo(s);
    } else if (pickerOpen) { activeSet = s; renderTable(); }
  };

  const renderSets = (box, sets, interactive) => {
    box.replaceChildren();
    if (!sets.length) {
      box.append(el('p', { class: 'hint', textContent: interactive ? '아직 기록된 큐브가 없어요. ＋ 큐브 추가를 눌러 내려놓은 큐브를 체크하세요.' : '비어 있음' }));
      return;
    }
    sets.forEach((set, si) => {
      const c = classify(set);
      const tiles = el('div', { class: 'tiles' });
      set.forEach((t, i) => tiles.append(tileEl(t, interactive ? {
        selected: tableSel.some((x) => x.s === si && x.i === i),
        onclick: (e) => { e.stopPropagation(); onTileTap(si, i); },
      } : {})));
      box.append(el('div', {
        class: 'set' + (interactive && pickerOpen && si === activeSet ? ' active' : '') + (c.ok ? '' : ' invalid') + (interactive && tableSel.length ? ' droppable' : ''),
        onclick: interactive ? () => onSetTap(si) : null,
      },
      el('span', { class: 'set-no', textContent: si + 1 }),
      tiles,
      el('span', { class: 'set-state', textContent: c.ok ? `✔ ${c.label}` : `⚠ ${c.label}` })));
    });
  };

  const renderPicker = () => {
    const g = state.game;
    const used = {};
    g.table.flat().forEach((t) => { used[tileKey(t)] = (used[tileKey(t)] || 0) + 1; });
    $('#pickerTarget').textContent = activeSet >= 0 && g.table[activeSet] ? `세트 ${activeSet + 1}에 추가 중` : '새 세트에 추가 중';
    $('#newSetBtn').disabled = activeSet < 0;
    const grid = $('#pickerGrid');
    grid.replaceChildren();
    TILE_COLORS.forEach((col) => {
      const row = el('div', { class: 'pick-row' });
      for (let n = 1; n <= 13; n++) {
        const t = { c: col.c, n };
        row.append(tileEl(t, { disabled: (used[tileKey(t)] || 0) >= 2, onclick: () => addTile(t) }));
      }
      grid.append(row);
    });
    grid.append(el('div', { class: 'pick-joker' },
      tileEl({ c: 'j', n: 0 }, { disabled: (used.j || 0) >= 2, onclick: () => addTile({ c: 'j', n: 0 }) }),
      el('span', { class: 'hint', textContent: '조커' })));
  };

  const renderTable = () => {
    const g = state.game; if (!g) return;
    ensureTable(g);
    const total = countTiles(g.table);
    const diff = total - countTiles(g.tableAtTurnStart);
    $('#tableSummary').textContent = `(세트 ${g.table.length} · ${total}장${diff ? ` · 이번 턴 ${diff > 0 ? '+' : ''}${diff}` : ''})`;
    renderSets($('#tableSets'), g.table, true);

    $('#selBar').hidden = !tableSel.length;
    $('#selCount').textContent = tableSel.length;

    $('#picker').hidden = !pickerOpen;
    if (pickerOpen) renderPicker();
    $('#addTilesBtn').textContent = pickerOpen ? '✓ 추가 완료' : '＋ 큐브 추가';

    const changed = tableChangedThisTurn();
    $('#revertTableBtn').disabled = !changed;
    $('#prevTableBtn').disabled = !changed && !prevOpen;
    $('#prevTable').hidden = !prevOpen;
    if (prevOpen) {
      $('#prevTable').replaceChildren(el('h4', { textContent: `턴 시작 때 테이블 (${countTiles(g.tableAtTurnStart)}장)` }));
      const box = el('div', { class: 'table-sets' });
      renderSets(box, g.tableAtTurnStart, false);
      $('#prevTable').append(box);
    }
    $('#prevTableBtn').textContent = prevOpen ? '👁 닫기' : '👁 턴 시작 테이블';
  };

  $('#addTilesBtn').addEventListener('click', () => {
    pickerOpen = !pickerOpen;
    if (pickerOpen) { tableSel = []; activeSet = -1; }
    renderTable();
  });
  $('#newSetBtn').addEventListener('click', () => { activeSet = -1; renderTable(); });
  $('#selNewSet').addEventListener('click', () => moveSelectedTo(-1));
  $('#selRemove').addEventListener('click', () => { takeSelected(); tableChanged(); });
  $('#selCancel').addEventListener('click', () => { tableSel = []; renderTable(); });
  $('#revertTableBtn').addEventListener('click', () => {
    if (!confirm('테이블을 이번 턴 시작 상태로 되돌릴까요?')) return;
    restoreTable(); save(); renderGame(); toast('테이블을 턴 시작 상태로 되돌렸어요');
  });
  $('#prevTableBtn').addEventListener('click', () => { prevOpen = !prevOpen; renderTable(); });

  // =========================================================
  // 테이블 촬영 모드 (사진으로 테이블 기록)
  // =========================================================
  // 사진은 용량이 커서 localStorage 대신 IndexedDB에 Blob으로 저장
  const photoDb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('rummikub-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => open().then((db) => new Promise((res, rej) => {
      const t = db.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    }));
    return {
      put: (k, v) => tx('readwrite', (st) => st.put(v, k)),
      get: (k) => tx('readonly', (st) => st.get(k)),
      del: (k) => tx('readwrite', (st) => st.delete(k)),
      clear: () => tx('readwrite', (st) => st.clear()),
    };
  })();
  const MAX_PHOTOS = 40;
  const photoUrls = new Map(); // id -> objectURL
  let camStream = null;
  let viewerIdx = -1;
  let camError = '';

  const camReady = () => !!camStream && $('#camVideo').videoWidth > 0;

  const startCam = async () => {
    if (camStream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      camError = '이 브라우저는 실시간 카메라를 지원하지 않아요. ‘카메라 앱으로 찍기’를 써 주세요.';
      renderPhotoPane(); return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      const v = $('#camVideo');
      v.srcObject = camStream;
      await v.play().catch(() => {});
      camError = '';
      renderPhotoPane();
    } catch (err) {
      camStream = null;
      camError = err && err.name === 'NotAllowedError'
        ? '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라를 허용해 주세요.'
        : '카메라를 켤 수 없어요. ‘카메라 앱으로 찍기’를 써 주세요.';
      renderPhotoPane();
    }
  };
  const stopCam = () => {
    if (!camStream) return;
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    const v = $('#camVideo'); if (v) v.srcObject = null;
    if (state.view === 'game') renderPhotoPane();
  };

  // 큰 사진은 긴 변 1280px로 줄여 JPEG로 저장 (사진 1장 약 100~250KB)
  const toJpeg = (source, w, h) => new Promise((res) => {
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    c.toBlob((b) => res(b), 'image/jpeg', 0.72);
  });

  const addPhoto = async (blob, meta) => {
    const g = state.game; if (!g || !blob) return;
    const id = uid();
    try { await photoDb.put(id, blob); } catch { toast('사진을 저장하지 못했어요 (저장 공간 부족?)'); return; }
    photoUrls.set(id, URL.createObjectURL(blob));
    g.photos ||= [];
    g.photos.push({ id, at: Date.now(), ...meta });
    while (g.photos.length > MAX_PHOTOS) {
      const old = g.photos.shift();
      photoDb.del(old.id).catch(() => {});
      if (photoUrls.has(old.id)) { URL.revokeObjectURL(photoUrls.get(old.id)); photoUrls.delete(old.id); }
    }
    save();
    if (state.view === 'game') renderPhotoPane();
  };

  const captureFromCamera = (meta) => {
    const v = $('#camVideo');
    if (!camReady()) return;
    // 화면을 바로 그려 두고(동기), 압축/저장은 뒤에서 처리
    const flash = $('#tableCard .cam-box');
    flash.classList.add('flash'); setTimeout(() => flash.classList.remove('flash'), 250);
    toJpeg(v, v.videoWidth, v.videoHeight).then((blob) => addPhoto(blob, meta));
  };

  const currentMeta = (kind) => {
    const g = state.game;
    return { round: g.round, turn: g.turnNo, pid: g.order[g.current], kind };
  };

  const clearPhotos = () => {
    photoUrls.forEach((u) => URL.revokeObjectURL(u));
    photoUrls.clear();
    photoDb.clear().catch(() => {});
  };

  const photoUrl = async (id) => {
    if (photoUrls.has(id)) return photoUrls.get(id);
    try {
      const blob = await photoDb.get(id);
      if (!blob) return null;
      const u = URL.createObjectURL(blob); photoUrls.set(id, u); return u;
    } catch { return null; }
  };

  const photoCaption = (ph) => {
    const t = new Date(ph.at);
    const hm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    const what = ph.kind === 'auto' ? '내려놓은 뒤' : '촬영';
    return `턴 ${ph.turn} · ${player(ph.pid).name} ${what} · ${hm}`;
  };

  const roundPhotos = () => {
    const g = state.game;
    return (g?.photos || []).filter((ph) => ph.round === g.round);
  };

  const renderPhotoPane = async () => {
    const g = state.game; if (!g) return;
    const on = !!camStream;
    $('#camOff').hidden = on;
    $('#camVideo').hidden = !on;
    $('#camMsg').textContent = camError || '카메라가 꺼져 있어요';
    $('#snapBtn').disabled = !on;
    $('#camStopBtn').hidden = !on;
    $('#autoCapture').checked = state.settings.autoCapture;

    const list = roundPhotos();
    const last = list[list.length - 1];
    const lastBox = $('#lastPhoto');
    if (!last) {
      lastBox.replaceChildren(el('p', { class: 'hint', textContent: '아직 사진이 없어요. 첫 내려놓기 후 자동으로 찍히거나, ‘지금 촬영’을 누르세요.' }));
    } else {
      const u = await photoUrl(last.id);
      lastBox.replaceChildren(
        u ? el('img', { src: u, alt: '턴 시작 때 테이블', onclick: () => openViewer(list.length - 1) }) : el('p', { class: 'hint', textContent: '사진을 불러오지 못했어요' }),
        el('div', { class: 'photo-cap', textContent: photoCaption(last) }));
    }

    const strip = $('#photoStrip');
    strip.replaceChildren();
    if (!list.length) { strip.append(el('p', { class: 'hint', textContent: '없음' })); return; }
    for (let i = list.length - 1; i >= 0; i--) {
      const ph = list[i];
      const u = await photoUrl(ph.id);
      strip.append(el('button', { class: 'thumb', onclick: () => openViewer(i), title: photoCaption(ph) },
        u ? el('img', { src: u, alt: photoCaption(ph) }) : '?',
        el('span', { textContent: `턴 ${ph.turn}` })));
    }
  };

  const openViewer = async (i) => {
    const list = roundPhotos();
    if (!list[i]) return;
    viewerIdx = i;
    $('#viewerImg').src = (await photoUrl(list[i].id)) || '';
    $('#viewerCap').textContent = `${photoCaption(list[i])} (${i + 1}/${list.length})`;
    $('#viewerPrev').disabled = i <= 0;
    $('#viewerNext').disabled = i >= list.length - 1;
    $('#photoViewer').hidden = false;
  };
  $('#viewerPrev').addEventListener('click', (e) => { e.stopPropagation(); openViewer(viewerIdx - 1); });
  $('#viewerNext').addEventListener('click', (e) => { e.stopPropagation(); openViewer(viewerIdx + 1); });
  $('#viewerClose').addEventListener('click', () => { $('#photoViewer').hidden = true; });
  $('#photoViewer').addEventListener('click', (e) => { if (e.target.id === 'photoViewer' || e.target.id === 'viewerImg') $('#photoViewer').hidden = true; });

  $('#camStartBtn').addEventListener('click', startCam);
  $('#camStopBtn').addEventListener('click', stopCam);
  $('#snapBtn').addEventListener('click', () => captureFromCamera(currentMeta('manual')));
  $('#autoCapture').addEventListener('change', (e) => { state.settings.autoCapture = e.target.checked; save(); });
  $('#photoFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !state.game) return;
    try {
      const bmp = await createImageBitmap(file);
      const blob = await toJpeg(bmp, bmp.width, bmp.height);
      await addPhoto(blob, currentMeta('manual'));
      toast('사진을 저장했어요');
    } catch { toast('사진을 불러오지 못했어요'); }
  });

  // 수동 / 촬영 모드 전환
  const setTableMode = (mode) => {
    state.settings.tableMode = mode;
    if (mode !== 'photo') stopCam();
    save(); render();
  };
  document.querySelectorAll('#gameModeToggle button, #tableModeChips button').forEach((b) =>
    b.addEventListener('click', () => setTableMode(b.dataset.mode)));

  const renderTableMode = () => {
    const mode = state.settings.tableMode === 'photo' ? 'photo' : 'manual';
    document.querySelectorAll('#gameModeToggle button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#manualPane').hidden = mode !== 'manual';
    $('#photoPane').hidden = mode !== 'photo';
    $('#tableSummary').hidden = mode !== 'manual';
    if (mode === 'manual') renderTable(); else renderPhotoPane();
  };

  // =========================================================
  // 3. 턴 기록
  // =========================================================
  const ACTION_LABEL = { draw: '드로우', place: '내려놓음', timeout: '시간 초과' };
  const renderLog = () => {
    const log = state.game?.log || [];
    const body = $('#logBody');
    body.replaceChildren();
    if (!log.length) {
      body.append(el('tr', {}, el('td', { colSpan: 6, style: 'text-align:center;color:var(--muted);padding:20px', textContent: '아직 기록이 없어요' })));
    }
    [...log].reverse().forEach((e) => {
      const p = player(e.pid);
      const label = e.action === 'place' ? `내려놓음 −${e.tiles}` : `${ACTION_LABEL[e.action]} +${e.tiles}`;
      body.append(el('tr', {},
        el('td', { textContent: e.round }),
        el('td', { textContent: e.turn }),
        el('td', {}, el('span', { class: 'pdot', style: `background:${p.color}` }), p.name),
        el('td', { class: `act-${e.action}`, textContent: label }),
        el('td', { class: 'num', textContent: `${e.elapsed}초` }),
        el('td', { class: 'num', textContent: e.hand }),
      ));
    });

    const stats = $('#logStats');
    stats.replaceChildren();
    state.players.forEach((p) => {
      const mine = log.filter((e) => e.pid === p.id);
      if (!mine.length) return;
      const avg = Math.round(mine.reduce((a, e) => a + e.elapsed, 0) / mine.length);
      const placed = mine.filter((e) => e.action === 'place').reduce((a, e) => a + e.tiles, 0);
      const to = mine.filter((e) => e.action === 'timeout').length;
      stats.append(el('div', { class: 'stat' },
        el('b', {}, el('span', { class: 'pdot', style: `background:${p.color}` }), p.name),
        `평균 ${avg}초 · 내려놓은 ${placed}장 · 초과 ${to}회`));
    });
  };

  // =========================================================
  // 4. 점수판
  // =========================================================
  let entry = null; // { winnerId, values: {pid: number} }

  const openScoreEntry = (winnerId) => {
    const g = state.game;
    entry = { winnerId, values: {} };
    state.players.forEach((p) => { entry.values[p.id] = ''; });
    if (!winnerId && g) {
      // 승자 미지정: 손패가 가장 적은 사람을 기본 선택
      entry.winnerId = [...g.order].sort((a, b) => g.hands[a] - g.hands[b])[0];
    }
    show('score');
  };

  const renderScore = () => {
    const box = $('#scoreEntry');
    box.hidden = !entry;
    if (entry) {
      $('#scoreRoundNo').textContent = state.rounds.length + 1;
      const ul = $('#scoreInputs');
      ul.replaceChildren();
      const losersSum = state.players.filter((p) => p.id !== entry.winnerId).reduce((a, p) => a + (Number(entry.values[p.id]) || 0), 0);
      state.players.forEach((p) => {
        const isW = p.id === entry.winnerId;
        const input = el('input', {
          type: 'number', inputMode: 'numeric', min: 0, placeholder: '0',
          value: isW ? losersSum : entry.values[p.id], disabled: isW,
          'aria-label': `${p.name} 남은 타일 합`,
          oninput: (e) => { entry.values[p.id] = e.target.value; updateWinnerPreview(); },
        });
        ul.append(el('li', { class: isW ? 'winner' : '' },
          el('input', { type: 'radio', name: 'winner', checked: isW, 'aria-label': `${p.name} 승자`, onchange: () => { entry.winnerId = p.id; renderScore(); } }),
          el('span', {}, el('span', { class: 'pdot', style: `background:${p.color}` }), p.name, isW ? ' 🏆' : ''),
          input,
          el('button', {
            class: 'joker', textContent: '+조커', disabled: isW,
            onclick: () => { entry.values[p.id] = String((Number(entry.values[p.id]) || 0) + 30); renderScore(); },
          }),
        ));
      });
    }

    // 누적 점수표
    const table = $('#scoreTable');
    table.replaceChildren();
    const thead = el('thead', {}, el('tr', {}, el('th', { textContent: '라운드' }),
      ...state.players.map((p) => el('th', { class: 'num' }, el('span', { class: 'pdot', style: `background:${p.color}` }), p.name))));
    const tbody = el('tbody');
    if (!state.rounds.length) {
      tbody.append(el('tr', {}, el('td', { colSpan: state.players.length + 1, style: 'text-align:center;color:var(--muted);padding:20px', textContent: '라운드를 마치면 점수가 쌓여요' })));
    }
    const totals = Object.fromEntries(state.players.map((p) => [p.id, 0]));
    state.rounds.forEach((r) => {
      tbody.append(el('tr', {}, el('td', { textContent: `${r.no}${r.winnerId ? ' · ' + player(r.winnerId).name + ' 승' : ''}` }),
        ...state.players.map((p) => {
          const v = r.scores[p.id] ?? 0; totals[p.id] += v;
          return el('td', { class: 'num ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : ''), textContent: v > 0 ? `+${v}` : v });
        })));
    });
    const best = Math.max(...Object.values(totals));
    const tfoot = el('tfoot', {}, el('tr', {}, el('td', { textContent: '합계' }),
      ...state.players.map((p) => el('td', {
        class: 'num' + (state.rounds.length && totals[p.id] === best ? ' leader' : ''),
        textContent: (state.rounds.length && totals[p.id] === best ? '👑 ' : '') + totals[p.id],
      }))));
    table.append(thead, tbody, tfoot);
  };

  const updateWinnerPreview = () => {
    const sum = state.players.filter((p) => p.id !== entry.winnerId).reduce((a, p) => a + (Number(entry.values[p.id]) || 0), 0);
    const w = document.querySelector('#scoreInputs li.winner input[type=number]');
    if (w) w.value = sum;
  };

  $('#saveRoundBtn').addEventListener('click', () => {
    if (!entry) return;
    const scores = {};
    let sum = 0;
    state.players.forEach((p) => {
      if (p.id === entry.winnerId) return;
      const v = Math.max(0, Number(entry.values[p.id]) || 0);
      scores[p.id] = -v; sum += v;
    });
    if (entry.winnerId) scores[entry.winnerId] = sum;
    state.rounds.push({ no: state.rounds.length + 1, winnerId: entry.winnerId, scores, at: Date.now() });
    entry = null;
    newRound();
    toast(`라운드 ${state.rounds.length} 저장! 다음 선: ${player(state.game.order[state.game.current]).name}`);
    show('score');
  });
  $('#cancelRoundBtn').addEventListener('click', () => { entry = null; renderScore(); });

  $('#newGameBtn').addEventListener('click', () => {
    if (!confirm('모든 턴 기록과 점수를 지우고 새 게임을 시작할까요? (플레이어 설정은 유지)')) return;
    cancelAnimationFrame(rafId); keepAwake(false);
    state.game = null; state.rounds = []; entry = null;
    clearPhotos();
    save(); show('setup');
  });

  $('#exportBtn').addEventListener('click', async () => {
    const totals = Object.fromEntries(state.players.map((p) => [p.id, 0]));
    state.rounds.forEach((r) => state.players.forEach((p) => { totals[p.id] += r.scores[p.id] ?? 0; }));
    const lines = ['🧩 루미큐브 결과', `라운드 ${state.rounds.length}회`, '',
      ...[...state.players].sort((a, b) => totals[b.id] - totals[a.id]).map((p, i) => `${i + 1}. ${p.name}: ${totals[p.id]}점`)];
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); toast('결과를 복사했어요'); }
    catch { prompt('아래 내용을 복사하세요', text); }
  });

  $('#shareBtn').addEventListener('click', async () => {
    const url = location.href.split('#')[0];
    if (navigator.share) { try { await navigator.share({ title: '루미큐브 턴 매니저', url }); } catch { /* 취소 */ } }
    else { try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요'); } catch { prompt('링크', url); } }
  });

  // 키보드 단축키 (태블릿/PC): Space=일시정지, D=드로우, P=내려놓기
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'game' || !state.game || e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); state.game.running ? pauseTimer() : startTimer(); }
    else if (e.key === 'd' || e.key === 'D') drawAction();
    else if (e.key === 'p' || e.key === 'P') placeAction();
  });

  // ---------- 렌더 ----------
  const render = () => {
    if (state.view === 'setup') renderSetup();
    if (state.view === 'game') renderGame();
    if (state.view === 'log') renderLog();
    if (state.view === 'score') renderScore();
  };

  show(state.view || 'setup');

  // ---------- PWA ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
