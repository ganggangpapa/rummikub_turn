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
    settings: { turnSeconds: 60, warnSeconds: 10, penaltyDraw: 3, startHand: 14, autoStart: true, sound: true, vibrate: true },
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
  document.querySelectorAll('#timeChips button').forEach((b) => b.addEventListener('click', () => {
    state.settings.turnSeconds = +b.dataset.sec; save(); renderSetup();
    if (state.game && !state.game.running) { state.game.remaining = state.settings.turnSeconds; save(); }
  }));
  const clampNum = (v, min, max, fallback) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback; };
  [['turnSeconds', 10, 600], ['warnSeconds', 0, 60], ['penaltyDraw', 0, 5], ['startHand', 1, 20]].forEach(([k, min, max]) => {
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
    endTurn('timeout', pen);
    toast(`⏰ ${p.name} 시간 초과! 패널티 ${pen}장`);
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
    cancelAnimationFrame(rafId); keepAwake(false);
    save(); render(); toast('이전 턴으로 되돌렸어요');
  };

  $('#drawBtn').addEventListener('click', () => endTurn('draw', 1));
  $('#placeBtn').addEventListener('click', () => endTurn('place', state.placeCount));
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
    $('#pauseBtn').textContent = g.running ? '⏸ 일시정지' : (g.remaining < state.settings.turnSeconds && g.remaining > 0 ? '▶ 재개' : '▶ 시작');
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
    drawHourglass();
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
    else if (e.key === 'd' || e.key === 'D') endTurn('draw', 1);
    else if (e.key === 'p' || e.key === 'P') endTurn('place', state.placeCount);
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
