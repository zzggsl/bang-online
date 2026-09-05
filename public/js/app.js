/* Bang! 온라인 — 클라이언트 */
(() => {
  'use strict';

  // ---------- 식별자 / 저장 ----------
  const store = {
    get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  let playerId = store.get('bang.playerId');
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
    store.set('bang.playerId', playerId);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const TYPE_KO = { action: '일반', weapon: '무기', passive: '패시브' };

  // ---------- 소리 ----------
  // public/sounds/<이름>.mp3 파일이 있으면 그 파일을 쓰고, 없으면 WebAudio로 합성한 소리를 낸다.
  // 이름: bang, missed, hit, heal, death, card, explosion, turn, draw, dynamite, bgm
  const Sound = (() => {
    const prefs = {
      sfx: store.get('bang.sfx', '1') === '1',
      bgm: store.get('bang.bgm', '1') === '1',
      vol: Number(store.get('bang.vol', '60')) / 100,
    };
    let ctx = null;
    let master = null;
    let bgmGain = null;
    let bgmTimer = null;
    let bgmAudio = null;
    let unlocked = false;
    const files = {}; // name -> HTMLAudioElement | false(없음)

    function ensure() {
      if (ctx) return ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = prefs.vol; master.connect(ctx.destination);
        bgmGain = ctx.createGain(); bgmGain.gain.value = 0.35; bgmGain.connect(master);
      } catch { ctx = null; }
      return ctx;
    }
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (prefs.bgm) startBgm();
    }
    // 서버가 알려준 파일만 불러온다 (없는 파일 404 방지)
    fetch('sounds/manifest.json').then((r) => r.json()).then((m) => {
      for (const f of m.files || []) {
        const name = f.replace(/\.[^.]+$/, '');
        const a = new Audio(`sounds/${f}`);
        a.preload = 'auto';
        a.addEventListener('canplaythrough', () => { files[name] = a; }, { once: true });
        a.addEventListener('error', () => { files[name] = false; }, { once: true });
      }
    }).catch(() => {});

    // ---- 합성 효과음 ----
    function noise(dur, { freq = 1000, q = 0.7, gain = 0.6, decay = dur } = {}) {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.5);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + decay);
      src.connect(f); f.connect(g); g.connect(master); src.start();
    }
    function tone(freq, dur, { type = 'triangle', gain = 0.25, slide = null, at = 0 } = {}) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime + at);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, ctx.currentTime + at + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      o.connect(g); g.connect(master); o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + dur + 0.05);
    }
    const synth = {
      bang() { noise(0.25, { freq: 1800, q: 0.5, gain: 0.9, decay: 0.18 }); tone(140, 0.25, { type: 'sine', gain: 0.5, slide: 40 }); },
      missed() { noise(0.35, { freq: 2500, q: 2, gain: 0.35, decay: 0.3 }); tone(900, 0.25, { type: 'sine', gain: 0.12, slide: 1600 }); },
      hit() { tone(90, 0.3, { type: 'sine', gain: 0.6, slide: 35 }); noise(0.12, { freq: 400, q: 1, gain: 0.4 }); },
      heal() { tone(660, 0.18, { gain: 0.22 }); tone(880, 0.22, { gain: 0.22, at: 0.12 }); tone(1320, 0.3, { gain: 0.16, at: 0.24 }); },
      death() { tone(300, 0.5, { type: 'sawtooth', gain: 0.18, slide: 60 }); tone(150, 0.7, { type: 'sine', gain: 0.3, slide: 30, at: 0.1 }); },
      card() { noise(0.08, { freq: 3000, q: 1.5, gain: 0.25, decay: 0.07 }); },
      draw() { noise(0.12, { freq: 2200, q: 1.2, gain: 0.2, decay: 0.1 }); noise(0.1, { freq: 2600, q: 1.2, gain: 0.15, decay: 0.08 }); },
      explosion() { noise(1.1, { freq: 300, q: 0.3, gain: 1.2, decay: 0.9 }); tone(60, 0.9, { type: 'sine', gain: 0.8, slide: 25 }); },
      turn() { tone(880, 0.12, { gain: 0.2 }); tone(1174, 0.2, { gain: 0.2, at: 0.12 }); },
      dynamite() { noise(0.4, { freq: 1200, q: 3, gain: 0.25, decay: 0.35 }); },
    };
    function play(name) {
      if (!prefs.sfx) return;
      if (!ensure()) return;
      if (ctx.state === 'suspended') return;
      const f = files[name];
      if (f) { try { const a = f.cloneNode(); a.volume = prefs.vol; a.play().catch(() => {}); return; } catch { /* fallthrough */ } }
      if (synth[name]) { try { synth[name](); } catch { /* ignore */ } }
    }

    // ---- 배경음악: 파일이 있으면 파일, 없으면 서부풍 느린 아르페지오 루프 ----
    const SCALE = [0, 3, 5, 7, 10]; // 마이너 펜타토닉 (E)
    const BASE = 164.81;
    function startBgm() {
      if (!prefs.bgm || !ensure()) return;
      if (bgmTimer || (bgmAudio && !bgmAudio.paused)) return;
      const f = files.bgm;
      if (f) {
        bgmAudio = f; bgmAudio.loop = true; bgmAudio.volume = prefs.vol * 0.5;
        bgmAudio.play().catch(() => {});
        return;
      }
      let step = 0;
      const pattern = [0, 2, 4, 2, 1, 3, 4, 3, 0, 2, 4, 5, 4, 3, 2, 1];
      bgmTimer = setInterval(() => {
        if (ctx.state === 'suspended') return;
        const i = pattern[step % pattern.length];
        const oct = i >= 5 ? 2 : 1;
        const freq = BASE * oct * Math.pow(2, SCALE[i % 5] / 12);
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = freq;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
        o.connect(g); g.connect(bgmGain); o.start(); o.stop(ctx.currentTime + 0.6);
        if (step % 4 === 0) { // 베이스
          const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = BASE / 2 * (step % 8 === 0 ? 1 : Math.pow(2, 7 / 12));
          const bg = ctx.createGain(); bg.gain.setValueAtTime(0.0001, ctx.currentTime);
          bg.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.03);
          bg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.1);
          b.connect(bg); bg.connect(bgmGain); b.start(); b.stop(ctx.currentTime + 1.2);
        }
        step++;
      }, 600);
    }
    function stopBgm() {
      if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
      if (bgmAudio) { bgmAudio.pause(); }
    }
    function setPrefs(patch) {
      Object.assign(prefs, patch);
      store.set('bang.sfx', prefs.sfx ? '1' : '0');
      store.set('bang.bgm', prefs.bgm ? '1' : '0');
      store.set('bang.vol', String(Math.round(prefs.vol * 100)));
      if (master) master.gain.value = prefs.vol;
      if (bgmAudio) bgmAudio.volume = prefs.vol * 0.5;
      if (prefs.bgm && unlocked) startBgm(); else stopBgm();
    }
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return { play, prefs, setPrefs, startBgm, stopBgm };
  })();

  // ---------- 상태 ----------
  let room = null; // 서버가 내려준 방 상태
  let ui = {
    selectedCardId: null,
    sideTab: 'chat',
    sideOpen: false,
    lastTurnKey: null,
    pickIds: [],        // 선택 모달에서 고른 카드들 (키트 칼슨 등)
    abilityMode: false, // 시드 케첨: 버릴 카드 2장 고르는 중
    abilityIds: [],
    popPlayerId: null,  // 터치로 열어둔 플레이어 정보 팝업
    lastLogId: null,    // 시각 효과를 낸 마지막 기록 id
    revealTimer: null,
  };
  const isTouch = window.matchMedia('(hover: none)').matches;

  // ---------- 소켓 ----------
  const socket = io({ transports: ['websocket', 'polling'] });
  const emit = (event, payload = {}) =>
    new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || { ok: false, error: '응답 없음' })));

  socket.on('connect', async () => {
    $('#conn-banner').hidden = true;
    const res = await emit('hello', { playerId });
    if (res.ok && !res.inRoom) {
      room = null;
      showScreen('main');
    }
  });
  socket.on('disconnect', () => { $('#conn-banner').hidden = false; });
  socket.io.on('reconnect_attempt', () => { $('#conn-banner').hidden = false; });

  socket.on('room:state', (state) => {
    room = state;
    window.__bangRoom = state; // 디버그용
    render();
  });
  socket.on('room:left', () => { room = null; showScreen('main'); });
  socket.on('room:kicked', ({ message }) => { room = null; showScreen('main'); toast(message); });
  socket.on('chat:message', (msg) => {
    if (!room) return;
    room.chat = room.chat || [];
    if (!room.chat.some((m) => m.id === msg.id)) room.chat.push(msg);
    renderChats();
  });

  // ---------- 화면 전환 ----------
  function showScreen(name) {
    for (const s of ['main', 'lobby', 'game']) $(`#screen-${s}`).hidden = s !== name;
    if (name === 'main') $('#nickname').value = store.get('bang.nickname', '');
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- 메인 화면 ----------
  function nicknameOrWarn() {
    const n = $('#nickname').value.trim();
    if (!n) { showMainError('닉네임을 먼저 입력해주세요.'); $('#nickname').focus(); return null; }
    store.set('bang.nickname', n);
    return n;
  }
  function showMainError(msg) { const e = $('#main-error'); e.textContent = msg || ''; e.hidden = !msg; }

  $('#btn-create').addEventListener('click', async () => {
    const nickname = nicknameOrWarn();
    if (!nickname) return;
    showMainError('');
    const res = await emit('room:create', { nickname });
    if (!res.ok) showMainError(res.error);
  });
  $('#btn-join-toggle').addEventListener('click', () => {
    const box = $('#join-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#room-code').focus();
  });
  async function joinRoom() {
    const nickname = nicknameOrWarn();
    if (!nickname) return;
    const code = $('#room-code').value.trim().toUpperCase();
    if (code.length !== 4) { showMainError('방 코드는 4자리입니다.'); return; }
    showMainError('');
    const res = await emit('room:join', { nickname, code });
    if (!res.ok) showMainError(res.error);
  }
  $('#btn-join').addEventListener('click', joinRoom);
  $('#room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#room-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });

  // ---------- 렌더 진입 ----------
  function render() {
    if (!room) { showScreen('main'); return; }
    if (room.state === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame();
    }
    renderChats();
  }

  // ---------- 로비 ----------
  function renderLobby() {
    $('#lobby-code').textContent = room.code;
    const players = room.members.filter((m) => !m.spectator);
    const specs = room.members.filter((m) => m.spectator);
    $('#lobby-count').textContent = `플레이어 ${players.length}/${room.settings.maxPlayers}` + (specs.length ? ` · 관전 ${specs.length}` : '');

    const list = $('#member-list');
    list.innerHTML = '';
    for (const m of room.members) {
      const li = el('li');
      if (!m.connected) li.classList.add('offline');
      li.appendChild(el('span', 'name', m.nickname));
      if (m.id === room.myId) li.appendChild(el('span', 'badge me', '나'));
      if (m.isHost) li.appendChild(el('span', 'badge host', '방장'));
      if (m.isBot) li.appendChild(el('span', 'badge bot', '봇'));
      if (m.spectator) li.appendChild(el('span', 'badge spectator', '관전'));
      else if (m.ready) li.appendChild(el('span', 'badge ready', '준비 완료'));
      else if (!m.isHost) li.appendChild(el('span', 'badge', '대기 중'));
      if (room.isHost && m.id !== room.myId) {
        const k = el('button', 'btn btn-ghost btn-sm', m.isBot ? '제거' : '내보내기');
        k.addEventListener('click', async () => {
          const res = await emit(m.isBot ? 'room:remove-bot' : 'room:kick', m.isBot ? { botId: m.id } : { targetId: m.id });
          if (!res.ok) toast(res.error);
        });
        li.appendChild(k);
      }
      list.appendChild(li);
    }

    // 컨트롤
    const c = $('#lobby-controls');
    c.innerHTML = '';
    const me = room.me;
    if (room.isHost) {
      const start = el('button', 'btn btn-primary', '게임 시작');
      start.disabled = !room.canStart.ok;
      start.addEventListener('click', async () => {
        const res = await emit('room:start');
        if (!res.ok) toast(res.error);
      });
      c.appendChild(start);
      const addBot = el('button', 'btn btn-secondary', '🤖 봇 추가');
      addBot.disabled = players.length >= room.settings.maxPlayers;
      addBot.title = '혼자 테스트할 때 자동으로 플레이하는 봇을 추가합니다.';
      addBot.addEventListener('click', async () => {
        const res = await emit('room:add-bot');
        if (!res.ok) toast(res.error);
      });
      c.appendChild(addBot);
    } else if (!me.spectator) {
      const ready = el('button', me.ready ? 'btn btn-secondary' : 'btn btn-success', me.ready ? '준비 취소' : '준비 완료');
      ready.addEventListener('click', async () => {
        const res = await emit('room:ready', { ready: !me.ready });
        if (!res.ok) toast(res.error);
      });
      c.appendChild(ready);
    }
    const spec = el('button', 'btn btn-ghost', me.spectator ? '플레이어로 참가' : '관전하기');
    spec.addEventListener('click', async () => {
      const res = await emit('room:spectate', { spectator: !me.spectator });
      if (!res.ok) toast(res.error);
    });
    c.appendChild(spec);

    $('#lobby-hint').textContent = room.isHost
      ? (room.canStart.ok ? '모두 준비되었습니다. 게임을 시작할 수 있어요!' : room.canStart.reason)
      : (me.spectator ? '관전자로 참가 중입니다.' : '준비가 끝나면 준비 완료를 눌러주세요. 방장이 게임을 시작합니다.');

    // 직업 배치 표
    const t = $('#role-table');
    t.innerHTML = '';
    const head = el('tr');
    for (const h of ['인원', '보안관', '부관', '무법자', '배신자']) head.appendChild(el('th', null, h));
    t.appendChild(head);
    for (const [n, row] of Object.entries(room.roleTable)) {
      const tr = el('tr');
      if (Number(n) === players.length) tr.classList.add('current');
      tr.appendChild(el('td', null, `${n}인`));
      for (const k of ['sheriff', 'deputy', 'outlaw', 'renegade']) tr.appendChild(el('td', null, row[k] ? String(row[k]) : '-'));
      t.appendChild(tr);
    }
  }

  $('#btn-copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(room.code); toast('방 코드를 복사했습니다.'); }
    catch { toast(`방 코드: ${room.code}`); }
  });
  $('#btn-leave').addEventListener('click', async () => { await emit('room:leave'); });

  // 설정 모달
  $('#btn-settings').addEventListener('click', () => {
    const sel = $('#set-max-players');
    sel.innerHTML = '';
    for (let n = room.limits.min; n <= room.limits.max; n++) {
      const o = el('option', null, `${n}명`);
      o.value = n;
      if (n === room.settings.maxPlayers) o.selected = true;
      sel.appendChild(o);
    }
    $('#set-spectator-chat').checked = !!room.settings.allowSpectatorChat;
    $('#set-turn-seconds').value = room.settings.turnSeconds ?? 60;
    $('#set-choice-seconds').value = room.settings.choiceSeconds ?? 15;
    const editable = room.isHost;
    sel.disabled = !editable;
    $('#set-spectator-chat').disabled = !editable;
    $('#set-turn-seconds').disabled = !editable;
    $('#set-choice-seconds').disabled = !editable;
    $('#btn-settings-save').hidden = !editable;
    $('#settings-note').textContent = editable ? '방장만 설정을 변경할 수 있습니다.' : '설정은 방장만 변경할 수 있습니다. (보기 전용)';
    $('#settings-modal').hidden = false;
  });
  $('#btn-settings-close').addEventListener('click', () => { $('#settings-modal').hidden = true; });
  $('#btn-settings-save').addEventListener('click', async () => {
    const res = await emit('room:settings', {
      maxPlayers: Number($('#set-max-players').value),
      allowSpectatorChat: $('#set-spectator-chat').checked,
      turnSeconds: Number($('#set-turn-seconds').value),
      choiceSeconds: Number($('#set-choice-seconds').value),
    });
    if (!res.ok) toast(res.error); else $('#settings-modal').hidden = true;
  });

  // ---------- 채팅 (로비/게임 공용) ----------
  function ensureChat(slot) {
    if (slot.querySelector('.chat')) return slot.querySelector('.chat');
    const node = $('#tpl-chat').content.firstElementChild.cloneNode(true);
    slot.appendChild(node);
    node.querySelector('.chat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = node.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const res = await emit('chat:send', { text });
      if (!res.ok) toast(res.error);
      input.focus();
    });
    return node;
  }

  function renderChats() {
    if (!room) return;
    const slots = room.state === 'lobby' ? [$('#lobby-chat-slot')] : [$('#side-chat')];
    for (const slot of slots) {
      const chat = ensureChat(slot);
      const box = chat.querySelector('.chat-messages');
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = '';
      for (const m of room.chat || []) {
        const d = el('div', 'msg' + (m.system ? ' system' : ''));
        if (m.system) d.textContent = m.text;
        else {
          d.appendChild(el('span', 'from' + (m.spectator ? ' spec' : ''), m.from + (m.spectator ? ' (관전)' : '')));
          d.appendChild(document.createTextNode(m.text));
        }
        box.appendChild(d);
      }
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  }

  // ---------- 게임 화면 ----------
  $('#btn-toggle-side').addEventListener('click', () => {
    ui.sideOpen = !ui.sideOpen;
    $('#side-panel').classList.toggle('open', ui.sideOpen);
  });
  $('#btn-side-close').addEventListener('click', () => { ui.sideOpen = false; $('#side-panel').classList.remove('open'); });
  $('#table').addEventListener('click', (e) => { if (ui.sideOpen && e.target === e.currentTarget) { ui.sideOpen = false; $('#side-panel').classList.remove('open'); } });
  $$('.side-tabs .tab').forEach((b) =>
    b.addEventListener('click', () => {
      ui.sideTab = b.dataset.tab;
      $$('.side-tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
      $('#side-chat').hidden = ui.sideTab !== 'chat';
      $('#side-log').hidden = ui.sideTab !== 'log';
    }));

  function cardNode(card, { mini = false } = {}) {
    const c = el('div', `card ${card.type}` + (mini ? ' card-mini' : ''));
    c.dataset.cardId = card.id;
    const corner = el('span', 'c-corner' + (card.suit === 'H' || card.suit === 'D' ? ' red' : ''), `${card.rank}${SUIT[card.suit]}`);
    c.appendChild(corner);
    const nm = el('div', 'c-name', card.name);
    if (card.name.length >= 6) nm.style.fontSize = '0.66rem';
    c.appendChild(nm);
    if (card.type === 'weapon') c.appendChild(el('div', 'c-range', `사거리 ${card.range}`));
    if (!mini) c.appendChild(el('div', 'c-desc', card.implemented ? card.desc : '(아직 구현되지 않은 카드)'));
    c.appendChild(el('span', 'c-type', TYPE_KO[card.type]));
    c.title = `${card.name}${card.en ? ` (${card.en})` : ''} — ${card.desc}`;
    return c;
  }

  function bullets(hp, maxHp) {
    const w = el('div', 'bullets');
    for (let i = 0; i < maxHp; i++) w.appendChild(el('span', 'bullet' + (i < hp ? '' : ' lost')));
    return w;
  }

  function renderGame() {
    const g = room.game;
    if (!g) return;
    $('#game-code').textContent = room.code;
    const meP = g.players.find((p) => p.isMe) || null;
    const isMyTurn = !!(g.turn && g.turn.isMine);
    const turnP = g.turn ? g.players.find((p) => p.id === g.turn.playerId) : null;

    // 턴이 바뀌면 선택 해제
    const turnKey = g.turn ? `${g.turn.number}-${g.turn.step}` : 'none';
    if (turnKey !== ui.lastTurnKey) { ui.selectedCardId = null; ui.lastTurnKey = turnKey; }
    if (ui.selectedCardId && meP && !(meP.hand || []).some((c) => c.id === ui.selectedCardId)) ui.selectedCardId = null;

    // 상단 배너
    const banner = $('#turn-banner');
    if (g.winner) banner.textContent = g.winner.message;
    else if (turnP && g.turn.step === 'start') banner.textContent = `${isMyTurn ? '당신' : turnP.nickname}의 차례 — 시작 판정 중…`;
    else if (turnP) banner.textContent = isMyTurn ? '당신의 차례입니다!' : `${turnP.nickname}의 차례`;
    banner.classList.toggle('mine', isMyTurn && !g.winner);

    if (!g.pending) ui.pickIds = [];
    if (ui.abilityMode && !(g.me && g.me.canSidKetchum)) { ui.abilityMode = false; ui.abilityIds = []; }
    renderSeats(g, meP, isMyTurn);
    renderCenter(g);
    renderMyPanel(g, meP, isMyTurn);
    renderPending(g, meP);
    renderLog(g);
    renderEnd(g);
    renderInfoPop(g);
    processEvents(g);
    renderTimer();
  }

  function selectedCard(meP) {
    if (!meP || !meP.hand || !ui.selectedCardId) return null;
    return meP.hand.find((c) => c.id === ui.selectedCardId) || null;
  }

  // 선택한 카드가 대상을 필요로 하고, 그 대상이 유효한지
  function targetableIds(g, meP) {
    const card = selectedCard(meP);
    if (!card || !g.turn?.isMine || g.turn.step !== 'play' || g.pending) return new Set();
    let target = card.target;
    if (card.kind === 'missed' && meP.character.id === 'calamity_janet') target = 'other';
    if (target === 'none') return new Set();
    const range = card.kind === 'panic' ? 1 : (meP.range || 1);
    const ids = new Set();
    for (const p of g.players) {
      if (!p.alive) continue;
      if (p.isMe) {
        // 감옥: 셀프 감옥 가능 / 강탈!: 내 앞에 놓인 카드 회수
        if (card.kind === 'jail') ids.add(p.id);
        if (card.kind === 'panic' && (p.weapon || p.passives.length)) ids.add(p.id);
        continue;
      }
      if (target === 'other-any' || target === 'any') ids.add(p.id);
      else if ((g.me.distances[p.id] ?? Infinity) <= range) ids.add(p.id);
    }
    return ids;
  }

  function renderSeats(g, meP, isMyTurn) {
    const wrap = $('#seats');
    wrap.innerHTML = '';
    const n = g.players.length;
    // 나(또는 관전자는 0번 자리)를 아래쪽에 두고 시계 방향으로 배치
    const startSeat = meP ? meP.seat : 0;
    const ordered = [...g.players].sort((a, b) => a.seat - b.seat);
    const targets = targetableIds(g, meP);
    const wantsTarget = targets.size > 0 || (selectedCard(meP) && selectedCard(meP).target !== 'none');

    for (let k = 0; k < n; k++) {
      const p = ordered[(startSeat + k) % n];
      const angle = Math.PI / 2 + (k * 2 * Math.PI) / n; // 아래(90°)부터 시계 방향
      const x = 50 + 41 * Math.cos(angle);
      const y = 50 + 38 * Math.sin(angle);
      const seat = el('div', 'seat');
      seat.style.left = `${x}%`;
      seat.style.top = `${y}%`;
      if (p.isMe) seat.classList.add('me');
      if (g.turn && g.turn.playerId === p.id && !g.winner) seat.classList.add('turn');
      if (!p.alive) seat.classList.add('dead');
      const member = room.members.find((m) => m.id === p.id);
      if (member && !member.connected) seat.classList.add('offline');
      seat.dataset.playerId = p.id;
      let isTargetable = false;
      if (wantsTarget && p.alive && (!p.isMe || targets.has(p.id))) {
        if (targets.has(p.id)) {
          isTargetable = true;
          seat.classList.add('targetable');
          seat.addEventListener('click', () => playSelected(p.id));
        } else seat.classList.add('untargetable');
      }
      // 플레이어 정보 팝업: PC는 마우스 올리기, 터치 기기는 탭
      if (!isTouch) {
        seat.addEventListener('mouseenter', () => { ui.popPlayerId = p.id; renderInfoPop(g); });
        seat.addEventListener('mouseleave', () => { if (ui.popPlayerId === p.id) { ui.popPlayerId = null; renderInfoPop(g); } });
      } else if (!isTargetable) {
        seat.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ui.popPlayerId = ui.popPlayerId === p.id ? null : p.id;
          renderInfoPop(g);
        });
      }

      const head = el('div', 'seat-head');
      head.appendChild(el('span', 'seat-name', p.nickname + (p.isMe ? ' (나)' : '')));
      seat.appendChild(head);
      seat.appendChild(el('div', 'seat-char', p.character.name));
      const row = el('div', 'seat-row');
      row.appendChild(bullets(p.hp, p.maxHp));
      const hc = el('span', 'seat-hand'); hc.appendChild(el('i')); hc.appendChild(document.createTextNode(String(p.handCount))); row.appendChild(hc);
      seat.appendChild(row);
      if (p.weapon || p.passives.length) {
        const eq = el('div', 'seat-equip');
        if (p.weapon) eq.appendChild(el('span', 'chip', `${p.weapon.name} ${p.weapon.range}`));
        for (const c of p.passives) eq.appendChild(el('span', 'chip passive', c.name));
        seat.appendChild(eq);
      }
      if (meP && !p.isMe && p.alive && meP.alive && g.me.distances[p.id] !== undefined) {
        seat.appendChild(el('span', 'dist', `거리 ${g.me.distances[p.id]}`));
      }
      if (p.roleName) seat.appendChild(el('span', `role ${p.role}`, p.roleName));
      if (!p.alive) seat.appendChild(el('div', 'dead-tag', '탈락'));
      if (room.deadline && room.deadline.playerId === p.id && !g.winner) {
        const t = el('span', 'seat-timer');
        t.dataset.timer = '1';
        seat.appendChild(t);
      }
      wrap.appendChild(seat);
    }

    // 대기 배너
    const pb = $('#pending-banner');
    if (g.pending && !g.winner) {
      pb.textContent = pendingText(g);
      pb.hidden = false;
    } else pb.hidden = true;
  }

  const REVEAL_MS = 4500;
  function flipCardNode(card) {
    const c = el('div', `card ${card.type} card-flip`);
    c.appendChild(el('div', 'c-name', card.name));
    c.appendChild(el('div', 'c-big' + (card.suit === 'H' || card.suit === 'D' ? ' red' : ''), `${card.rank}${SUIT[card.suit]}`));
    c.appendChild(el('span', 'c-type', TYPE_KO[card.type]));
    c.title = `${card.name} ${card.rank}${SUIT[card.suit]}`;
    return c;
  }
  function renderCenter(g) {
    const ra = $('#reveal-area');
    const keepWhilePending = g.pending && ['lucky_duke', 'general_store', 'dynamite'].includes(g.pending.type);
    const fresh = g.reveal && (Date.now() - (g.reveal.at || 0) < REVEAL_MS);
    const hideForMyModal = g.pending && g.pending.isMine && ['lucky_duke', 'general_store'].includes(g.pending.type);
    clearTimeout(ui.revealTimer);
    if (g.reveal && (fresh || keepWhilePending) && !hideForMyModal) {
      $('#reveal-label').textContent = g.reveal.label;
      const box = $('#reveal-cards');
      box.innerHTML = '';
      box.classList.toggle('many', g.reveal.cards.length > 3);
      for (const c of g.reveal.cards) box.appendChild(flipCardNode(c));
      ra.hidden = false;
      if (!keepWhilePending) ui.revealTimer = setTimeout(() => { ra.hidden = true; }, Math.max(200, REVEAL_MS - (Date.now() - g.reveal.at)));
    } else ra.hidden = true;
    $('#deck-count').textContent = g.deckCount;
    $('#discard-count').textContent = g.discardCount;
    const top = $('#discard-top');
    if (g.discardTop) {
      const node = cardNode(g.discardTop, { mini: true });
      node.id = 'discard-top';
      top.replaceWith(node);
    } else {
      const empty = el('div', 'card card-mini empty');
      empty.id = 'discard-top';
      top.replaceWith(empty);
    }
  }

  function renderMyPanel(g, meP, isMyTurn) {
    const roleBox = $('#my-role');
    const charBox = $('#my-character');
    const hand = $('#hand');
    const bar = $('#action-bar');
    hand.innerHTML = '';
    bar.innerHTML = '';

    if (!meP) {
      roleBox.className = 'my-role spectator';
      roleBox.innerHTML = '<b>관전 중</b>다른 플레이어의 손패와 직업은 보이지 않습니다.';
      charBox.textContent = '';
      return;
    }
    roleBox.className = `my-role ${g.me.role}`;
    roleBox.innerHTML = '';
    roleBox.appendChild(el('b', null, g.me.roleName));
    roleBox.appendChild(document.createTextNode(g.me.roleGoal));
    charBox.innerHTML = '';
    charBox.appendChild(el('b', null, meP.character.name));
    charBox.appendChild(document.createTextNode(` (체력 ${meP.character.hp}) — ${meP.character.ability}`));

    if (!meP.alive) {
      bar.appendChild(el('span', 'msg', '탈락했습니다. 남은 게임을 관전합니다.'));
      return;
    }

    const step = g.turn?.step;
    const discardMode = isMyTurn && step === 'discard' && !g.pending;
    const uncleWill = !!g.me.canUncleWill;
    for (const c of meP.hand || []) {
      const node = cardNode(c);
      if (c.id === ui.selectedCardId) node.classList.add('selected');
      if (discardMode) node.classList.add('discard-mode');
      if (ui.abilityMode && ui.abilityIds.includes(c.id)) node.classList.add('ability-pick');
      const usable = isMyTurn && step === 'play' && !g.pending &&
        ((c.implemented && !(c.kind === 'missed' && meP.character.id !== 'calamity_janet')) || uncleWill);
      if (!discardMode && !usable && !ui.abilityMode) node.classList.add('disabled');
      node.addEventListener('click', async () => {
        if (ui.abilityMode) {
          ui.abilityIds = ui.abilityIds.includes(c.id) ? ui.abilityIds.filter((x) => x !== c.id) : [...ui.abilityIds, c.id].slice(-2);
          renderGame();
          return;
        }
        if (discardMode) {
          const res = await emit('game:discard', { cardId: c.id });
          if (!res.ok) toast(res.error);
          return;
        }
        if (!usable) {
          if (!isMyTurn) toast('내 차례가 아닙니다.');
          else if (g.pending) toast('진행 중인 선택이 끝날 때까지 기다려주세요.');
          else if (!c.implemented) toast(`<${c.name}>은(는) 아직 구현되지 않았습니다.`);
          else if (c.kind === 'missed') toast('<빗나감!>은 공격을 받았을 때 사용합니다.');
          return;
        }
        ui.selectedCardId = ui.selectedCardId === c.id ? null : c.id;
        renderGame();
      });
      hand.appendChild(node);
    }

    // 액션 바
    if (g.winner) return;
    // 시드 케첨: 언제든지 카드 2장 → 체력 1
    if (g.me.canSidKetchum) {
      if (ui.abilityMode) {
        bar.appendChild(el('span', 'msg warn', `버릴 카드 2장을 고르세요. (${ui.abilityIds.length}/2)`));
        const ok = el('button', 'btn btn-ability', '버리고 회복');
        ok.disabled = ui.abilityIds.length !== 2;
        ok.addEventListener('click', async () => {
          const res = await emit('game:ability', { cardIds: ui.abilityIds });
          if (!res.ok) toast(res.error);
          ui.abilityMode = false; ui.abilityIds = [];
        });
        bar.appendChild(ok);
        const cancel = el('button', 'btn btn-ghost btn-sm', '취소');
        cancel.addEventListener('click', () => { ui.abilityMode = false; ui.abilityIds = []; renderGame(); });
        bar.appendChild(cancel);
        return;
      }
      const ab = el('button', 'btn btn-ability btn-sm', '💊 카드 2장 버리고 체력 회복');
      ab.title = '시드 케첨 능력';
      ab.addEventListener('click', () => { ui.abilityMode = true; ui.abilityIds = []; ui.selectedCardId = null; renderGame(); });
      bar.appendChild(ab);
    }
    if (!isMyTurn) {
      const turnP = g.players.find((p) => p.id === g.turn?.playerId);
      bar.appendChild(el('span', 'msg', turnP ? `${turnP.nickname}의 차례를 기다리는 중…` : ''));
      return;
    }
    if (g.pending) {
      bar.appendChild(el('span', 'msg', g.pending.isMine ? '선택해주세요.' : '다른 플레이어의 응답을 기다리는 중…'));
      return;
    }
    if (discardMode) {
      const over = meP.hand.length - meP.hp;
      bar.appendChild(el('span', 'msg warn', `손패가 체력(${meP.hp})보다 많습니다. 카드 ${over}장을 골라 버려주세요.`));
      const back = el('button', 'btn btn-secondary btn-sm', '↩ 카드 사용으로 돌아가기');
      back.style.marginLeft = 'auto';
      back.addEventListener('click', async () => { const r = await emit('game:back-to-play'); if (!r.ok) toast(r.error); });
      bar.appendChild(back);
      return;
    }
    const sel = selectedCard(meP);
    if (sel) {
      const needsTarget = sel.target !== 'none' || (sel.kind === 'missed' && meP.character.id === 'calamity_janet');
      const normallyUsable = sel.implemented && !(sel.kind === 'missed' && meP.character.id !== 'calamity_janet');
      if (needsTarget && normallyUsable) {
        bar.appendChild(el('span', 'msg warn', `<${sel.name}> — 대상을 테이블에서 선택하세요.`));
      } else if (normallyUsable) {
        const use = el('button', 'btn btn-primary', `<${sel.name}> 사용`);
        use.addEventListener('click', () => playSelected(null));
        bar.appendChild(use);
      }
      if (g.me.canUncleWill) {
        const uw = el('button', 'btn btn-ability', '🏪 잡화점으로 사용');
        uw.title = '엉클 윌: 이 카드를 <잡화점>으로 사용합니다 (턴당 1회)';
        uw.addEventListener('click', async () => {
          const res = await emit('game:play', { cardId: sel.id, as: 'general_store' });
          if (!res.ok) toast(res.error); else ui.selectedCardId = null;
        });
        bar.appendChild(uw);
      }
      const cancel = el('button', 'btn btn-ghost btn-sm', '선택 해제');
      cancel.addEventListener('click', () => { ui.selectedCardId = null; renderGame(); });
      bar.appendChild(cancel);
    } else {
      bar.appendChild(el('span', 'msg', `카드를 선택해 사용하세요. (사거리 ${meP.range}${g.me.canPlayBang ? '' : ' · 이번 턴 뱅! 사용 완료'})`));
    }
    const end = el('button', 'btn btn-secondary', '턴 종료');
    end.style.marginLeft = 'auto';
    end.addEventListener('click', async () => {
      ui.selectedCardId = null;
      const res = await emit('game:end-turn');
      if (!res.ok) toast(res.error);
      else if (res.needDiscard > 0) toast(`카드 ${res.needDiscard}장을 버려야 턴을 넘길 수 있습니다.`);
    });
    bar.appendChild(end);
  }

  async function playSelected(targetId) {
    if (!ui.selectedCardId) return;
    const cardId = ui.selectedCardId;
    const res = await emit('game:play', { cardId, targetId });
    if (!res.ok) toast(res.error);
    else ui.selectedCardId = null;
  }

  // ---------- 대기 상황(pending) UI ----------
  function pname(g, id) { return g.players.find((p) => p.id === id)?.nickname || '?'; }

  function pendingText(g) {
    const p = g.pending;
    const who = pname(g, p.playerId);
    switch (p.type) {
      case 'bang': {
        const extra = p.needed > 1 ? ` (빗나감! ${p.needed - p.used}장 필요)` : '';
        const nm = p.subtype === 'gatling' ? '기관총' : '뱅!';
        return `${pname(g, p.attackerId)} → ${who} <${nm}>${extra} — ${p.isMine ? '응답해주세요!' : '응답 대기 중…'}`;
      }
      case 'duel': return `결투! ${pname(g, p.challengerId)} vs ${pname(g, p.targetId)} — ${who}이(가) <뱅!>을 낼 차례${p.isMine ? '입니다!' : '…'}`;
      case 'indians': return `인디언 습격! ${who}이(가) <뱅!>을 버릴지 결정 중${p.isMine ? ' — 응답해주세요!' : '…'}`;
      case 'pick_card': return `${who}이(가) ${pname(g, p.targetId)}의 카드를 고르는 중… (${p.cardName})`;
      case 'dynamite': return `🧨 다이너마이트가 ${who} 앞에… 카드 펼치기!`;
      case 'dying': return `${who}이(가) 쓰러지기 직전! ${p.isMine ? '맥주를 마실지 선택하세요.' : '맥주를 마실지 결정 중…'}`;
      case 'kit_carlson': return `${who}이(가) 카드 세 장 중 두 장을 고르는 중… (키트 칼슨)`;
      case 'jesse_jones': return `${who}이(가) 첫 카드를 어디서 가져올지 고르는 중… (제시 존스)`;
      case 'lucky_duke': return `${who}이(가) 펼친 두 장 중 한 장을 고르는 중… (럭키 듀크)`;
      case 'claus_the_saint': return `${who}이(가) ${pname(g, p.recipientId)}에게 줄 카드를 고르는 중… (클라우스)`;
      case 'general_store': return `잡화점 — ${who}이(가) 카드를 고르는 중…`;
      default: return `${who}의 선택을 기다리는 중…`;
    }
  }

  function renderPending(g, meP) {
    const respond = $('#respond-modal');
    const choose = $('#choose-modal');
    const p = g.pending;
    if (!p || !p.isMine || g.winner || !meP) { respond.hidden = true; choose.hidden = true; return; }

    if (p.type === 'bang') {
      choose.hidden = true;
      const attacker = pname(g, p.attackerId);
      $('#respond-title').textContent = p.subtype === 'gatling'
        ? `${attacker}이(가) <기관총>을 난사했습니다!`
        : `${attacker}이(가) 당신에게 <뱅!>을 사용했습니다!`;
      const usable = (meP.hand || []).filter((c) => p.missedKinds.includes(c.kind));
      const still = p.needed - p.used;
      let desc = still > 1 ? `슬랩 더 킬러의 공격! 피하려면 <빗나감!> ${still}장이 필요합니다. ` : '';
      if (p.drawSources.length) desc += `"카드 펼치기"로 하트가 나오면 피할 수 있습니다 (${p.drawSources.map((x) => x === 'jourdonnais' ? '주르도네' : '술통').join(', ')}). `;
      desc += usable.length ? '아래 카드를 사용해 피하거나, 피해를 받을 수 있습니다.' : (p.drawSources.length ? '' : '피할 수 있는 카드가 없습니다. 피해를 받습니다.');
      $('#respond-desc').textContent = desc;
      const box = $('#respond-cards');
      box.innerHTML = '';
      for (const c of usable) {
        const node = cardNode(c);
        node.title = '이 카드로 피하기';
        node.addEventListener('click', async () => {
          const res = await emit('game:respond', { action: 'missed', cardId: c.id });
          if (!res.ok) toast(res.error);
        });
        box.appendChild(node);
      }
      const dc = $('#btn-draw-check');
      dc.hidden = !p.drawSources.length;
      dc.textContent = `🎴 카드 펼치기 (${p.drawSources.map((x) => x === 'jourdonnais' ? '주르도네' : '술통').join('/')})`;
      $('#btn-take-hit').textContent = '피해 받기 (체력 -1)';
      respond.hidden = false;
      return;
    }
    respond.hidden = true;

    // 선택 모달
    const title = $('#choose-title');
    const desc = $('#choose-desc');
    const box = $('#choose-cards');
    const acts = $('#choose-actions');
    box.innerHTML = '';
    acts.innerHTML = '';
    const send = async (payload) => {
      const res = await emit('game:choose', payload);
      if (!res.ok) toast(res.error); else ui.pickIds = [];
    };
    const pickOne = (cards, onPick) => {
      for (const c of cards) {
        const node = cardNode(c);
        node.addEventListener('click', () => onPick(c));
        box.appendChild(node);
      }
    };

    switch (p.type) {
      case 'dying': {
        title.textContent = '쓰러지기 직전입니다!';
        const beers = (meP.hand || []).filter((c) => c.kind === 'beer');
        desc.textContent = `체력이 0이 되었습니다. <맥주>를 ${p.needed}장 마시면 살아남을 수 있습니다. (남은 맥주 ${beers.length}장)`;
        pickOne(beers, async (c) => {
          const res = await emit('game:respond', { action: 'beer', cardId: c.id });
          if (!res.ok) toast(res.error);
        });
        const die = el('button', 'btn btn-danger', '그대로 쓰러지기');
        die.addEventListener('click', async () => { const r = await emit('game:respond', { action: 'die' }); if (!r.ok) toast(r.error); });
        acts.appendChild(die);
        break;
      }
      case 'duel': {
        const other = pname(g, p.playerId === p.challengerId ? p.targetId : p.challengerId);
        title.textContent = `결투! ${other}과(와) 맞서는 중`;
        const kinds = meP.character.id === 'calamity_janet' ? ['bang', 'missed'] : ['bang'];
        const bangs = (meP.hand || []).filter((c) => kinds.includes(c.kind));
        desc.textContent = bangs.length
          ? '<뱅!>을 한 장 버려 맞서거나, 물러나 생명력 1을 잃을 수 있습니다. (결투의 <뱅!>은 사용 횟수에 포함되지 않습니다)'
          : '<뱅!>이 없습니다. 생명력 1을 잃습니다.';
        pickOne(bangs, async (c) => { const r = await emit('game:respond', { action: 'bang', cardId: c.id }); if (!r.ok) toast(r.error); });
        const take = el('button', 'btn btn-danger', '물러나기 (체력 -1)');
        take.addEventListener('click', async () => { const r = await emit('game:respond', { action: 'take' }); if (!r.ok) toast(r.error); });
        acts.appendChild(take);
        break;
      }
      case 'indians': {
        title.textContent = `${pname(g, p.attackerId)}이(가) <인디언>을 사용했습니다!`;
        const bangs = (meP.hand || []).filter((c) => p.bangKinds.includes(c.kind));
        desc.textContent = bangs.length ? '<뱅!>을 한 장 버려 물리치거나, 생명력 1을 잃을 수 있습니다.' : '<뱅!>이 없습니다. 생명력 1을 잃습니다.';
        pickOne(bangs, async (c) => { const r = await emit('game:respond', { action: 'bang', cardId: c.id }); if (!r.ok) toast(r.error); });
        const take = el('button', 'btn btn-danger', '피해 받기 (체력 -1)');
        take.addEventListener('click', async () => { const r = await emit('game:respond', { action: 'take' }); if (!r.ok) toast(r.error); });
        acts.appendChild(take);
        break;
      }
      case 'pick_card': {
        const tn = pname(g, p.targetId);
        title.textContent = `<${p.cardName}> — ${tn}의 어떤 카드를 ${p.mode === 'steal' ? '가져올까요' : '버리게 할까요'}?`;
        desc.textContent = p.tableCards.length ? '앞에 놓인 카드를 고르거나, 손에서 무작위로 한 장을 고를 수 있습니다.' : '';
        pickOne(p.tableCards, (c) => send({ from: 'table', cardId: c.id }));
        if (p.handCount > 0) {
          const hb = el('button', 'btn btn-secondary', `손에서 무작위로 한 장 (${p.handCount}장 중)`);
          hb.addEventListener('click', () => send({ from: 'hand' }));
          acts.appendChild(hb);
        }
        break;
      }
      case 'kit_carlson': {
        title.textContent = '키트 칼슨 — 가져갈 카드 두 장을 고르세요';
        desc.textContent = '카드 더미 맨 위 세 장입니다. 고르지 않은 한 장은 더미 맨 위로 돌아갑니다.';
        for (const c of p.cards) {
          const node = cardNode(c);
          if (ui.pickIds.includes(c.id)) node.classList.add('pick');
          node.addEventListener('click', () => {
            ui.pickIds = ui.pickIds.includes(c.id) ? ui.pickIds.filter((x) => x !== c.id) : [...ui.pickIds, c.id].slice(-p.count);
            renderGame();
          });
          box.appendChild(node);
        }
        const ok = el('button', 'btn btn-primary', `가져오기 (${ui.pickIds.length}/${p.count})`);
        ok.disabled = ui.pickIds.length !== p.count;
        ok.addEventListener('click', () => send({ cardIds: ui.pickIds }));
        acts.appendChild(ok);
        break;
      }
      case 'jesse_jones': {
        title.textContent = '제시 존스 — 첫 번째 카드를 어디서 가져올까요?';
        desc.textContent = '다른 사람의 손에서 무작위로 한 장을 가져오거나(거리 무관), 평소처럼 카드 더미에서 가져올 수 있습니다. 나머지 한 장은 더미에서 가져옵니다.';
        for (const id of p.targetIds) {
          const pl = g.players.find((x) => x.id === id);
          const b = el('button', 'btn btn-secondary', `${pl.nickname}의 손에서 (${pl.handCount}장)`);
          b.addEventListener('click', () => send({ from: 'player', targetId: id }));
          acts.appendChild(b);
        }
        const deck = el('button', 'btn btn-primary', '카드 더미에서 두 장');
        deck.addEventListener('click', () => send({ from: 'deck' }));
        acts.appendChild(deck);
        break;
      }
      case 'lucky_duke': {
        title.textContent = `럭키 듀크 — 카드 펼치기 (${p.label})`;
        desc.textContent = '두 장 중 판정에 사용할 카드 한 장을 고르세요. 두 장 모두 버려집니다.';
        pickOne(p.cards, (c) => send({ cardId: c.id }));
        break;
      }
      case 'claus_the_saint': {
        title.textContent = `클라우스 — ${pname(g, p.recipientId)}에게 줄 카드를 고르세요`;
        desc.textContent = `남은 사람 ${p.remaining}명에게 한 장씩 나눠주고, 마지막 두 장은 내가 가집니다.`;
        pickOne(p.cards, (c) => send({ cardId: c.id }));
        break;
      }
      case 'general_store': {
        title.textContent = '잡화점 — 가져갈 카드를 고르세요';
        const after = p.orderIds.slice(p.index + 1).map((id) => pname(g, id));
        desc.textContent = after.length ? `다음 순서: ${after.join(' → ')}` : '마지막 순서입니다.';
        pickOne(p.cards, (c) => send({ cardId: c.id }));
        break;
      }
      default:
        title.textContent = '선택';
        desc.textContent = '';
    }
    choose.hidden = false;
  }
  $('#btn-take-hit').addEventListener('click', async () => {
    const res = await emit('game:respond', { action: 'take' });
    if (!res.ok) toast(res.error);
  });
  $('#btn-draw-check').addEventListener('click', async () => {
    const src = room?.game?.pending?.drawSources?.[0];
    const res = await emit('game:respond', { action: 'draw', source: src });
    if (!res.ok) toast(res.error);
  });

  // ---------- 플레이어 정보 팝업 ----------
  function renderInfoPop(g) {
    const pop = $('#info-pop');
    const p = ui.popPlayerId && g.players.find((x) => x.id === ui.popPlayerId);
    const seat = p && $(`#seats .seat[data-player-id="${p.id}"]`);
    const modalOpen = ['#respond-modal', '#choose-modal', '#end-modal'].some((sel) => !$(sel).hidden);
    if (!p || !seat || modalOpen) { pop.hidden = true; return; }
    pop.innerHTML = '';
    pop.appendChild(el('b', null, p.nickname + (p.roleName ? ` · ${p.roleName}` : '') + (p.alive ? '' : ' · 탈락')));
    pop.appendChild(el('div', 'ip-char', `${p.character.name} (체력 ${p.character.hp})`));
    pop.appendChild(el('div', 'ip-ability', p.character.ability));
    const items = [];
    if (p.weapon) items.push(p.weapon);
    items.push(...p.passives);
    if (items.length) {
      for (const c of items) {
        const d = el('div', 'ip-item');
        d.appendChild(el('b', null, `${c.name}${c.type === 'weapon' ? ` (사거리 ${c.range})` : ''}: `));
        d.appendChild(document.createTextNode(c.desc));
        pop.appendChild(d);
      }
    } else {
      pop.appendChild(el('div', 'ip-item ip-none', '장착한 카드 없음 (기본 사거리 1)'));
    }
    pop.hidden = false;
    // 자리 옆에 위치 (테이블 밖으로 나가지 않게)
    const table = $('#table');
    const tr = table.getBoundingClientRect();
    const sr = seat.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = sr.left - tr.left + sr.width + 8;
    if (left + pw > tr.width - 4) left = sr.left - tr.left - pw - 8;
    if (left < 4) left = 4;
    let top = sr.top - tr.top;
    if (top + ph > tr.height - 4) top = tr.height - ph - 4;
    if (top < 4) top = 4;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  // 터치: 빈 곳을 누르면 팝업 닫기
  document.addEventListener('click', (ev) => {
    if (!ui.popPlayerId) return;
    if (ev.target.closest('.seat')) return;
    ui.popPlayerId = null;
    if (room?.game) renderInfoPop(room.game);
  });

  // ---------- 시각 효과 / 이벤트 피드 ----------
  const FEED_TYPES = new Set(['attack', 'heal', 'dodge', 'damage', 'death', 'equip', 'penalty', 'reward', 'end']);
  function seatCenter(playerId) {
    const seat = $(`#seats .seat[data-player-id="${playerId}"]`);
    if (!seat) return null;
    const tr = $('#table').getBoundingClientRect();
    const r = seat.getBoundingClientRect();
    return { x: r.left - tr.left + r.width / 2, y: r.top - tr.top + r.height / 2, seat };
  }
  function feed(text, type) {
    const box = $('#event-feed');
    const item = el('div', `event-item ${type}`, text);
    box.appendChild(item);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { item.classList.add('out'); setTimeout(() => item.remove(), 400); }, 3000);
  }
  function fxLabel(playerId, text, cls) {
    const c = seatCenter(playerId);
    if (!c) return;
    const l = el('div', `fx-label ${cls}`, text);
    l.style.left = `${c.x}px`; l.style.top = `${c.y}px`;
    $('#fx-layer').appendChild(l);
    setTimeout(() => l.remove(), 1300);
  }
  function fxSeat(playerId, cls, ms = 900) {
    const c = seatCenter(playerId);
    if (!c) return;
    c.seat.classList.remove(cls); void c.seat.offsetWidth; c.seat.classList.add(cls);
    setTimeout(() => c.seat.classList.remove(cls), ms);
  }
  function fxBullet(fromId, toId, delay = 0) {
    const a = seatCenter(fromId); const b = seatCenter(toId);
    if (!a || !b) return;
    setTimeout(() => {
      const d = el('div', 'fx-bullet');
      d.style.left = `${a.x}px`; d.style.top = `${a.y}px`;
      $('#fx-layer').appendChild(d);
      requestAnimationFrame(() => { d.style.left = `${b.x}px`; d.style.top = `${b.y}px`; });
      setTimeout(() => d.remove(), 450);
    }, delay);
  }
  function processEvents(g) {
    const log = g.log || [];
    if (!log.length) return;
    if (ui.lastLogId === null) { ui.lastLogId = log[log.length - 1].id; return; } // 첫 진입: 효과 없이 동기화
    const fresh = log.filter((l) => l.id > ui.lastLogId);
    ui.lastLogId = log[log.length - 1].id;
    if (fresh.length > 12) return; // 재접속 등으로 한꺼번에 오면 생략
    let delay = 0;
    for (const l of fresh) {
      const t = l.type;
      if (FEED_TYPES.has(t) || l.announce || l.kind === 'dynamite') feed(l.text, t);
      switch (t) {
        case 'attack':
          if (l.kind === 'bang' || l.kind === 'duel_bang') { fxBullet(l.actor, l.target); Sound.play('bang'); }
          else if (l.kind === 'gatling') { (l.targets || []).forEach((id, i) => fxBullet(l.actor, id, i * 90)); Sound.play('bang'); setTimeout(() => Sound.play('bang'), 120); setTimeout(() => Sound.play('bang'), 240); }
          else if (l.kind === 'dynamite') { Sound.play('dynamite'); fxSeat(l.actor, 'fx-glow'); }
          else if (l.kind === 'indians') { Sound.play('draw'); (l.targets || []).forEach((id) => fxSeat(id, 'fx-glow')); }
          else { Sound.play('card'); if (l.target) fxSeat(l.target, 'fx-glow'); }
          break;
        case 'dodge':
          if (l.final || l.kind === 'barrel' || l.kind === 'bang') { fxLabel(l.target, l.kind === 'barrel' ? '술통!' : '빗나감!', 'dodge'); Sound.play('missed'); }
          else if (l.partial) { fxLabel(l.target, '빗나감! (1/2)', 'dodge'); Sound.play('missed'); }
          break;
        case 'damage':
          if (l.kind === 'dynamite') { Sound.play('explosion'); $('#table').classList.remove('fx-shake'); void $('#table').offsetWidth; $('#table').classList.add('fx-shake'); fxLabel(l.target, '💥 폭발!', 'damage'); }
          else if (l.target) { fxSeat(l.target, 'fx-hit', 600); fxLabel(l.target, `-${l.amount || 1}`, 'damage'); Sound.play('hit'); }
          break;
        case 'heal':
          if (l.targets) l.targets.forEach((id) => { fxSeat(id, 'fx-heal'); fxLabel(id, '+1', 'heal'); });
          else if (l.target) { fxSeat(l.target, 'fx-heal'); fxLabel(l.target, '+1', 'heal'); }
          Sound.play('heal');
          break;
        case 'death':
          fxLabel(l.target, '💀', 'death'); Sound.play('death');
          break;
        case 'equip':
          fxSeat(l.actor, 'fx-glow'); Sound.play('card');
          break;
        case 'draw':
          if (l.announce) Sound.play('draw');
          break;
        case 'info':
          if (l.kind === 'dynamite' && l.target) { fxBullet(l.actor, l.target); Sound.play('dynamite'); }
          break;
        case 'turn':
          if (g.turn && g.turn.isMine && /차례입니다/.test(l.text)) Sound.play('turn');
          break;
        default:
          break;
      }
      delay += 1;
    }
  }

  // ---------- 제한 시간 표시 ----------
  let timerInterval = null;
  function renderTimer() {
    const wrap = $('#timer-wrap');
    const d = room && room.deadline;
    if (!d || !room.game || room.game.winner || room.state !== 'playing') {
      wrap.hidden = true;
      $$('.seat-timer').forEach((e) => e.remove());
      $$('.modal-timer').forEach((e) => e.remove());
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      return;
    }
    wrap.hidden = false;
    const tick = () => {
      if (!room || !room.deadline) return;
      const left = Math.max(0, room.deadline.at - Date.now());
      const secs = Math.ceil(left / 1000);
      const ratio = Math.max(0, Math.min(1, left / (room.deadline.seconds * 1000)));
      const bar = $('#timer-bar');
      bar.style.width = `${ratio * 100}%`;
      bar.classList.toggle('warn', secs <= 10);
      const who = room.game.players.find((p) => p.id === room.deadline.playerId);
      $('#timer-text').textContent = `${who && who.isMe ? '내' : (who?.nickname || '')} 제한 시간 ${secs}초`;
      for (const e of $$('.seat-timer')) { e.textContent = `⏱ ${secs}`; e.classList.toggle('warn', secs <= 10); }
      // 열려 있는 모달 제목에 남은 시간
      for (const sel of ['#respond-title', '#choose-title']) {
        const h = $(sel);
        const modal = h.closest('.modal');
        let mt = h.querySelector('.modal-timer');
        if (modal.hidden || !who || !who.isMe) { if (mt) mt.remove(); continue; }
        if (!mt) { mt = el('span', 'modal-timer'); h.appendChild(mt); }
        mt.textContent = `⏱ ${secs}초`;
        mt.classList.toggle('warn', secs <= 5);
      }
    };
    tick();
    if (!timerInterval) timerInterval = setInterval(tick, 250);
  }

  // ---------- 소리 패널 ----------
  $('#btn-sound').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const panel = $('#sound-panel');
    panel.hidden = !panel.hidden;
    $('#snd-sfx').checked = Sound.prefs.sfx;
    $('#snd-bgm').checked = Sound.prefs.bgm;
    $('#snd-vol').value = Math.round(Sound.prefs.vol * 100);
    $('#btn-sound').textContent = Sound.prefs.sfx || Sound.prefs.bgm ? '🔊' : '🔇';
  });
  $('#sound-panel').addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', () => { $('#sound-panel').hidden = true; });
  $('#snd-sfx').addEventListener('change', (e) => { Sound.setPrefs({ sfx: e.target.checked }); if (e.target.checked) Sound.play('card'); $('#btn-sound').textContent = Sound.prefs.sfx || Sound.prefs.bgm ? '🔊' : '🔇'; });
  $('#snd-bgm').addEventListener('change', (e) => { Sound.setPrefs({ bgm: e.target.checked }); $('#btn-sound').textContent = Sound.prefs.sfx || Sound.prefs.bgm ? '🔊' : '🔇'; });
  $('#snd-vol').addEventListener('input', (e) => Sound.setPrefs({ vol: Number(e.target.value) / 100 }));

  function renderLog(g) {
    const box = $('#side-log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    for (const l of g.log) box.appendChild(el('div', `log ${l.type}`, l.text));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderEnd(g) {
    const modal = $('#end-modal');
    if (!g.winner) { modal.hidden = true; return; }
    $('#end-title').textContent = g.winner.message;
    const roles = $('#end-roles');
    roles.innerHTML = '';
    for (const p of [...g.players].sort((a, b) => a.seat - b.seat)) {
      const d = el('div');
      d.appendChild(el('span', p.alive ? '' : 'dead-name', `${p.nickname} · ${p.character.name}`));
      d.appendChild(el('span', `role ${p.role}`, p.roleName || '?'));
      roles.appendChild(d);
    }
    const acts = $('#end-actions');
    acts.innerHTML = '';
    if (room.isHost) {
      const b = el('button', 'btn btn-primary', '로비로 돌아가기');
      b.addEventListener('click', async () => { const r = await emit('room:lobby'); if (!r.ok) toast(r.error); });
      acts.appendChild(b);
    } else {
      acts.appendChild(el('span', 'muted', '방장이 로비로 돌아가길 기다리는 중…'));
    }
    modal.hidden = false;
  }

  // 초기 화면
  showScreen('main');
})();
