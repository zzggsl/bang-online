// 방(로비) 관리: 생성/참가/준비/관전/설정/채팅/재접속, 게임 시작과 종료.
const { Game, GameError } = require('./game/engine');
const { buildView } = require('./game/view');
const { ROLE_TABLE, ROLE_INFO, MIN_PLAYERS, MAX_PLAYERS } = require('./game/roles');
const { botStep, botPending, lowest, BOT_NAMES } = require('./bot');

const BOT_ACTION_DELAY_MS = Number(process.env.BANG_BOT_DELAY || 900); // 봇 행동 간 간격 (사람이 따라볼 수 있도록)
const BOT_RESPONSE_DELAY_MS = Math.round(BOT_ACTION_DELAY_MS * 0.8);
const AUTO_STEP_DELAY_MS = Math.max(300, Math.round(BOT_ACTION_DELAY_MS * 1.4)); // 다이너마이트가 한 사람씩 넘어가는 간격
const TURN_SECONDS_DEFAULT = 60;
const CHOICE_SECONDS_DEFAULT = 15;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
const HOST_GRACE_MS = 30 * 1000; // 방장이 끊긴 뒤 방장 권한을 넘기기까지
const LOBBY_LEAVE_MS = 90 * 1000; // 로비에서 끊긴 사람을 내보내기까지
const ROOM_EMPTY_MS = 10 * 60 * 1000; // 아무도 없는 방을 지우기까지

function makeCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.members = new Map(); // playerId -> member
    this.settings = { maxPlayers: MAX_PLAYERS, allowSpectatorChat: true, turnSeconds: TURN_SECONDS_DEFAULT, choiceSeconds: CHOICE_SECONDS_DEFAULT };
    this.chat = [];
    this.state = 'lobby'; // lobby | playing | ended
    this.game = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.botTimer = null;
    this.deadline = null; // { key, playerId, at, seconds }
    this.deadlineTimer = null;
  }

  addMember(id, nickname, isBot = false) {
    this.members.set(id, {
      id,
      nickname,
      ready: isBot, // 봇은 항상 준비 완료
      spectator: false,
      connected: true,
      disconnectedAt: null,
      joinedAt: Date.now(),
      isBot,
    });
  }

  humans() {
    return [...this.members.values()].filter((m) => !m.isBot);
  }

  bots() {
    return [...this.members.values()].filter((m) => m.isBot);
  }

  seatedPlayers() {
    return [...this.members.values()].filter((m) => !m.spectator);
  }

  canStart() {
    const players = this.seatedPlayers();
    if (players.length < MIN_PLAYERS) return { ok: false, reason: `최소 ${MIN_PLAYERS}명이 필요합니다.` };
    if (players.length > this.settings.maxPlayers) {
      return { ok: false, reason: `최대 인원(${this.settings.maxPlayers}명)을 초과했습니다.` };
    }
    const notReady = players.filter((m) => m.id !== this.hostId && !m.ready);
    if (notReady.length) return { ok: false, reason: '모든 플레이어가 준비되어야 합니다.' };
    if (players.some((m) => !m.connected)) return { ok: false, reason: '접속이 끊긴 플레이어가 있습니다.' };
    return { ok: true };
  }

  addChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > 200) this.chat.shift();
  }

  // 특정 플레이어 시점의 방 상태
  stateFor(viewerId) {
    const me = this.members.get(viewerId) || null;
    const members = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => ({
        id: m.id,
        nickname: m.nickname,
        ready: m.ready,
        spectator: m.spectator,
        connected: m.connected,
        isHost: m.id === this.hostId,
        isBot: !!m.isBot,
      }));

    let game = null;
    if (this.game) {
      const isParticipant = this.game.players.some((p) => p.id === viewerId);
      game = buildView(this.game, isParticipant ? viewerId : null);
    }

    return {
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      myId: viewerId,
      isHost: viewerId === this.hostId,
      me: me
        ? { id: me.id, nickname: me.nickname, ready: me.ready, spectator: me.spectator }
        : null,
      members,
      settings: this.settings,
      deadline: this.deadline ? { playerId: this.deadline.playerId, at: this.deadline.at, seconds: this.deadline.seconds } : null,
      limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
      roleTable: ROLE_TABLE,
      roleInfo: ROLE_INFO,
      canStart: this.canStart(),
      chat: this.chat.slice(-100),
      game,
    };
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> code
    this.sockets = new Map(); // playerId -> Set<socket>
    setInterval(() => this.sweep(), 15 * 1000).unref();
  }

  // ---------- 소켓 연결 관리 ----------
  attachSocket(playerId, socket) {
    if (!this.sockets.has(playerId)) this.sockets.set(playerId, new Set());
    this.sockets.get(playerId).add(socket);
    const code = this.playerRoom.get(playerId);
    if (code && this.rooms.has(code)) {
      const room = this.rooms.get(code);
      const m = room.members.get(playerId);
      if (m) {
        const wasDisconnected = !m.connected;
        m.connected = true;
        m.disconnectedAt = null;
        socket.join(code);
        if (wasDisconnected) this.systemChat(room, `${m.nickname}님이 다시 접속했습니다.`);
        this.broadcast(room);
      }
    }
  }

  detachSocket(playerId, socket) {
    const set = this.sockets.get(playerId);
    if (set) {
      set.delete(socket);
      if (set.size > 0) return; // 다른 탭이 아직 연결돼 있음
      this.sockets.delete(playerId);
    }
    const code = this.playerRoom.get(playerId);
    const room = code && this.rooms.get(code);
    if (!room) return;
    const m = room.members.get(playerId);
    if (!m) return;
    m.connected = false;
    m.disconnectedAt = Date.now();
    this.systemChat(room, `${m.nickname}님의 접속이 끊겼습니다.`);
    this.broadcast(room);
  }

  emitTo(playerId, event, payload) {
    const set = this.sockets.get(playerId);
    if (!set) return;
    for (const s of set) s.emit(event, payload);
  }

  broadcast(room) {
    room.lastActivity = Date.now();
    this.updateDeadline(room);
    for (const m of room.members.values()) {
      if (m.connected && !m.isBot) this.emitTo(m.id, 'room:state', room.stateFor(m.id));
    }
    this.scheduleBots(room);
  }

  // ---------- 제한 시간 ----------
  clearDeadline(room) {
    if (room.deadlineTimer) clearTimeout(room.deadlineTimer);
    room.deadlineTimer = null;
    room.deadline = null;
  }

  /** 지금 행동해야 하는 사람(사람 플레이어)에게 제한 시간을 건다. 같은 상황이 이어지면 시간은 유지된다. */
  updateDeadline(room) {
    const g = room.game;
    if (room.state !== 'playing' || !g || g.winner) return this.clearDeadline(room);
    let key = null;
    let playerId = null;
    let seconds = 0;
    if (g.pending) {
      if (g.pending.auto) return this.clearDeadline(room);
      key = `p${g.pending.id}`;
      playerId = g.pending.playerId;
      seconds = room.settings.choiceSeconds;
    } else if (g.turn && (g.turn.step === 'play' || g.turn.step === 'discard')) {
      key = `t${g.turn.number}`;
      playerId = g.turn.playerId;
      seconds = room.settings.turnSeconds;
    }
    if (!key || !seconds || room.members.get(playerId)?.isBot) return this.clearDeadline(room);
    if (room.deadline && room.deadline.key === key) return; // 같은 상황이면 유지
    this.clearDeadline(room);
    const at = Date.now() + seconds * 1000;
    room.deadline = { key, playerId, at, seconds };
    room.deadlineTimer = setTimeout(() => this.onDeadline(room, key), seconds * 1000 + 50);
  }

  onDeadline(room, key) {
    room.deadlineTimer = null;
    if (!this.rooms.has(room.code) || !room.deadline || room.deadline.key !== key) return;
    const g = room.game;
    if (!g || room.state !== 'playing' || g.winner) return;
    const pid = room.deadline.playerId;
    const me = g.players.find((x) => x.id === pid);
    room.deadline = null;
    try {
      if (g.pending && g.pending.playerId === pid && me) {
        botPending(g, me); // 시간 초과: 봇과 같은 기본 선택
        this.systemChat(room, `${me.nickname}의 선택 시간이 지나 자동으로 처리되었습니다.`);
      } else if (g.turn && g.turn.playerId === pid && !g.pending && me) {
        if (g.turn.step === 'play') g.endTurn(pid);
        let guard = 0;
        while (g.turn && g.turn.playerId === pid && g.turn.step === 'discard' && me.hand.length > me.hp && guard++ < 20) {
          g.discardCard(pid, lowest(me.hand, me, g).id);
        }
        this.systemChat(room, `${me.nickname}의 차례 시간이 지나 자동으로 넘어갔습니다.`);
      }
    } catch (err) {
      console.error('[deadline]', err.message);
    }
    if (g.winner) room.state = 'ended';
    this.broadcast(room);
  }

  // ---------- 봇 ----------
  addBot(playerId) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 봇을 추가할 수 있습니다.');
    if (room.state !== 'lobby') throw new GameError('게임 중에는 봇을 추가할 수 없습니다.');
    if (room.seatedPlayers().length >= room.settings.maxPlayers) throw new GameError('플레이어 자리가 가득 찼습니다.');
    const used = new Set([...room.members.values()].map((m) => m.nickname));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `봇${room.bots().length + 1}`;
    const id = `bot-${Math.random().toString(36).slice(2, 10)}`;
    room.addMember(id, name, true);
    this.systemChat(room, `${name}이(가) 추가되었습니다.`);
    this.broadcast(room);
  }

  removeBot(playerId, botId) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 봇을 제거할 수 있습니다.');
    if (room.state !== 'lobby') throw new GameError('게임 중에는 봇을 제거할 수 없습니다.');
    const b = room.members.get(botId);
    if (!b || !b.isBot) throw new GameError('그 봇은 방에 없습니다.');
    room.members.delete(botId);
    this.systemChat(room, `${b.nickname}이(가) 제거되었습니다.`);
    this.broadcast(room);
  }

  // 상태가 바뀔 때마다 호출 — 지금 봇이 해야 할 일이 있으면 잠시 뒤 한 가지 행동을 한다.
  scheduleBots(room) {
    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
    if (room.state !== 'playing' || !room.game || room.game.winner) return;
    const g = room.game;
    const isBot = (id) => room.members.get(id)?.isBot;
    let actor = null;
    let delay = BOT_ACTION_DELAY_MS;
    let autoStep = false;
    if (g.pending && g.pending.auto) {
      actor = g.pending.playerId; delay = AUTO_STEP_DELAY_MS; autoStep = true;
    } else if (g.pending) {
      if (isBot(g.pending.playerId)) { actor = g.pending.playerId; delay = BOT_RESPONSE_DELAY_MS; }
    } else if (g.turn && isBot(g.turn.playerId)) {
      actor = g.turn.playerId;
    }
    if (!actor) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!this.rooms.has(room.code) || room.state !== 'playing' || !room.game) return;
      try {
        if (autoStep) {
          if (room.game.pending && room.game.pending.auto) room.game.resolveDynamite();
        } else botStep(room.game, actor);
      } catch (err) {
        // 봇 로직 오류로 게임이 멈추지 않도록: 응답이면 피해 받기, 턴이면 강제 종료 시도
        console.error('[bot]', err.message);
        try {
          const g2 = room.game;
          if (g2.pending && g2.pending.playerId === actor) {
            if (g2.pending.type === 'bang') g2.respond(actor, { action: 'take' });
            else if (g2.pending.type === 'dying') g2.respond(actor, { action: 'die' });
            else g2.popPending();
          } else if (g2.turn?.playerId === actor) g2.endTurn(actor);
        } catch (_) { /* 무시 */ }
      }
      if (room.game.winner) room.state = 'ended';
      this.broadcast(room);
    }, delay);
  }

  systemChat(room, text) {
    const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, system: true, text, t: Date.now() };
    room.addChat(entry);
    this.io.to(room.code).emit('chat:message', entry);
  }

  // ---------- 방 생성 / 참가 / 나가기 ----------
  validateNickname(nickname) {
    const n = String(nickname || '').trim();
    if (n.length < 1 || n.length > 12) throw new GameError('닉네임은 1~12자로 입력해주세요.');
    return n;
  }

  createRoom(playerId, nickname) {
    nickname = this.validateNickname(nickname);
    this.leaveRoom(playerId, true);
    let code;
    do code = makeCode();
    while (this.rooms.has(code));
    const room = new Room(code, playerId);
    room.addMember(playerId, nickname);
    this.rooms.set(code, room);
    this.playerRoom.set(playerId, code);
    this.joinSockets(playerId, code);
    this.systemChat(room, `${nickname}님이 방을 만들었습니다. (코드: ${code})`);
    this.broadcast(room);
    return room;
  }

  joinRoom(playerId, nickname, code) {
    nickname = this.validateNickname(nickname);
    code = String(code || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('존재하지 않는 방 코드입니다.');
    if (room.members.has(playerId)) {
      // 이미 멤버 — 재참가 처리
      room.members.get(playerId).nickname = nickname;
      this.playerRoom.set(playerId, code);
      this.joinSockets(playerId, code);
      this.broadcast(room);
      return room;
    }
    if ([...room.members.values()].some((m) => m.nickname === nickname)) {
      throw new GameError('같은 닉네임을 쓰는 사람이 이미 방에 있습니다.');
    }
    this.leaveRoom(playerId, true);
    room.addMember(playerId, nickname);
    const m = room.members.get(playerId);
    if (room.state !== 'lobby') {
      m.spectator = true; // 진행 중인 게임에는 관전자로만 입장
    } else if (room.seatedPlayers().length > room.settings.maxPlayers) {
      m.spectator = true;
    }
    this.playerRoom.set(playerId, code);
    this.joinSockets(playerId, code);
    this.systemChat(room, `${nickname}님이 ${m.spectator ? '관전자로 ' : ''}입장했습니다.`);
    this.broadcast(room);
    return room;
  }

  joinSockets(playerId, code) {
    const set = this.sockets.get(playerId);
    if (set) for (const s of set) s.join(code);
  }

  leaveRoom(playerId, silent = false) {
    const code = this.playerRoom.get(playerId);
    if (!code) return;
    const room = this.rooms.get(code);
    this.playerRoom.delete(playerId);
    const set = this.sockets.get(playerId);
    if (set) for (const s of set) s.leave(code);
    if (!room) return;
    const m = room.members.get(playerId);
    room.members.delete(playerId);
    if (m && !silent) this.systemChat(room, `${m.nickname}님이 나갔습니다.`);

    if (room.humans().length === 0) {
      if (room.botTimer) clearTimeout(room.botTimer);
      this.clearDeadline(room);
      this.rooms.delete(code);
      return;
    }
    if (room.hostId === playerId) this.transferHost(room);
    this.broadcast(room);
  }

  transferHost(room) {
    const candidates = room.humans().sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates.find((m) => m.connected) || candidates[0];
    if (!next) return;
    room.hostId = next.id;
    next.ready = false;
    this.systemChat(room, `${next.nickname}님이 새 방장이 되었습니다.`);
  }

  getRoomOf(playerId) {
    const code = this.playerRoom.get(playerId);
    const room = code && this.rooms.get(code);
    if (!room) throw new GameError('방에 참가하고 있지 않습니다.');
    return room;
  }

  // ---------- 로비 액션 ----------
  setReady(playerId, ready) {
    const room = this.getRoomOf(playerId);
    if (room.state !== 'lobby') throw new GameError('게임 중에는 바꿀 수 없습니다.');
    const m = room.members.get(playerId);
    if (m.spectator) throw new GameError('관전자는 준비할 수 없습니다.');
    m.ready = !!ready;
    this.broadcast(room);
  }

  setSpectator(playerId, spectator) {
    const room = this.getRoomOf(playerId);
    if (room.state !== 'lobby') throw new GameError('게임 중에는 바꿀 수 없습니다.');
    const m = room.members.get(playerId);
    if (m.isBot) throw new GameError('봇은 관전할 수 없습니다.');
    if (!spectator && room.seatedPlayers().length >= room.settings.maxPlayers && m.spectator) {
      throw new GameError('플레이어 자리가 가득 찼습니다.');
    }
    m.spectator = !!spectator;
    if (m.spectator) m.ready = false;
    this.broadcast(room);
  }

  updateSettings(playerId, patch) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 설정을 바꿀 수 있습니다.');
    if (room.state !== 'lobby') throw new GameError('게임 중에는 설정을 바꿀 수 없습니다.');
    if (patch.maxPlayers !== undefined) {
      const n = Number(patch.maxPlayers);
      if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
        throw new GameError(`최대 인원은 ${MIN_PLAYERS}~${MAX_PLAYERS} 사이여야 합니다.`);
      }
      room.settings.maxPlayers = n;
    }
    if (patch.allowSpectatorChat !== undefined) {
      room.settings.allowSpectatorChat = !!patch.allowSpectatorChat;
    }
    if (patch.turnSeconds !== undefined) {
      const n = Number(patch.turnSeconds);
      if (!Number.isInteger(n) || n < 20 || n > 300) throw new GameError('차례 제한 시간은 20~300초 사이여야 합니다.');
      room.settings.turnSeconds = n;
    }
    if (patch.choiceSeconds !== undefined) {
      const n = Number(patch.choiceSeconds);
      if (!Number.isInteger(n) || n < 5 || n > 120) throw new GameError('선택 제한 시간은 5~120초 사이여야 합니다.');
      room.settings.choiceSeconds = n;
    }
    this.systemChat(room, '방장이 설정을 변경했습니다.');
    this.broadcast(room);
  }

  kick(playerId, targetId) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 내보낼 수 있습니다.');
    if (room.state !== 'lobby') throw new GameError('게임 중에는 내보낼 수 없습니다.');
    if (targetId === playerId) throw new GameError('자신을 내보낼 수 없습니다.');
    const t = room.members.get(targetId);
    if (!t) throw new GameError('그 플레이어는 방에 없습니다.');
    if (t.isBot) return this.removeBot(playerId, targetId);
    this.emitTo(targetId, 'room:kicked', { message: '방장에 의해 방에서 나가게 되었습니다.' });
    this.leaveRoom(targetId, true);
    this.systemChat(room, `${t.nickname}님이 방에서 나가게 되었습니다.`);
    this.broadcast(room);
  }

  startGame(playerId) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 게임을 시작할 수 있습니다.');
    if (room.state !== 'lobby') throw new GameError('이미 게임이 진행 중입니다.');
    const check = room.canStart();
    if (!check.ok) throw new GameError(check.reason);
    // 자리는 랜덤으로 섞는다 (실제 테이블에 둘러앉는 것과 같음)
    const seated = shuffle(room.seatedPlayers().map((m) => ({ id: m.id, nickname: m.nickname })));
    // 테스트용: 환경변수 BANG_FORCE_CHAR=kit_carlson 처럼 주면 방장의 캐릭터를 고정한다
    const force = process.env.BANG_FORCE_CHAR ? { [room.hostId]: process.env.BANG_FORCE_CHAR } : {};
    room.game = new Game(seated, { forceCharacters: force });
    room.state = 'playing';
    this.systemChat(room, '게임이 시작되었습니다!');
    this.broadcast(room);
  }

  backToLobby(playerId) {
    const room = this.getRoomOf(playerId);
    if (room.hostId !== playerId) throw new GameError('방장만 로비로 돌아갈 수 있습니다.');
    if (room.state === 'lobby') return;
    if (room.state === 'playing' && !room.game.winner) {
      // 진행 중 강제 종료 — 방장 권한
      this.systemChat(room, '방장이 게임을 종료했습니다.');
    }
    room.game = null;
    room.state = 'lobby';
    for (const m of room.members.values()) m.ready = !!m.isBot;
    this.broadcast(room);
  }

  // ---------- 채팅 ----------
  sendChat(playerId, text) {
    const room = this.getRoomOf(playerId);
    const m = room.members.get(playerId);
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    if (m.spectator && !room.settings.allowSpectatorChat) {
      throw new GameError('이 방에서는 관전자 채팅이 꺼져 있습니다.');
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      from: m.nickname,
      fromId: m.id,
      spectator: m.spectator,
      text,
      t: Date.now(),
    };
    room.addChat(entry);
    room.lastActivity = Date.now();
    this.io.to(room.code).emit('chat:message', entry);
  }

  // ---------- 게임 액션 ----------
  gameAction(playerId, fn) {
    const room = this.getRoomOf(playerId);
    if (room.state !== 'playing' || !room.game) throw new GameError('진행 중인 게임이 없습니다.');
    const result = fn(room.game);
    if (room.game.winner) room.state = 'ended';
    this.broadcast(room);
    return result;
  }

  // ---------- 정리 ----------
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      let changed = false;
      for (const m of [...room.members.values()]) {
        if (m.connected) continue;
        const gone = now - (m.disconnectedAt || now);
        if (room.state === 'lobby' && gone > LOBBY_LEAVE_MS) {
          this.leaveRoom(m.id);
          changed = true;
        } else if (m.id === room.hostId && gone > HOST_GRACE_MS && room.members.size > 1) {
          this.transferHost(room);
          changed = true;
        }
      }
      if (!this.rooms.has(room.code)) continue;
      const anyoneConnected = room.humans().some((m) => m.connected);
      if (!anyoneConnected && now - room.lastActivity > ROOM_EMPTY_MS) {
        if (room.botTimer) clearTimeout(room.botTimer);
        this.clearDeadline(room);
        for (const m of room.members.values()) this.playerRoom.delete(m.id);
        this.rooms.delete(room.code);
        continue;
      }
      if (changed) this.broadcast(room);
    }
  }
}

module.exports = { RoomManager, GameError };
