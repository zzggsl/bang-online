// Bang! 온라인 — 서버 진입점
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, GameError } = require('./rooms');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
// public/sounds 폴더에 있는 소리 파일 목록 (클라이언트가 있는 파일만 불러오도록)
app.get('/sounds/manifest.json', (_req, res) => {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'public', 'sounds');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f)); } catch (_) { /* 폴더 없음 */ }
  res.json({ files });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  pingInterval: 10000,
  pingTimeout: 20000,
});

const rooms = new RoomManager(io);

// 콜백 기반 핸들러 래퍼: GameError는 사용자 메시지로, 나머지는 로그 후 일반 오류로
function handle(socket, fn) {
  return (payload, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    try {
      const result = fn(payload || {});
      done({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (err) {
      if (err instanceof GameError) {
        done({ ok: false, error: err.message });
      } else {
        console.error(err);
        done({ ok: false, error: '서버 오류가 발생했습니다.' });
      }
    }
  };
}

io.on('connection', (socket) => {
  let playerId = null;

  socket.on('hello', handle(socket, ({ playerId: pid }) => {
    pid = String(pid || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(pid)) throw new GameError('잘못된 플레이어 식별자입니다.');
    playerId = pid;
    rooms.attachSocket(playerId, socket);
    let inRoom = false;
    try {
      const room = rooms.getRoomOf(playerId);
      inRoom = !!room;
      socket.emit('room:state', room.stateFor(playerId));
    } catch (_) {
      /* 방에 없음 */
    }
    return { inRoom };
  }));

  const requireId = () => {
    if (!playerId) throw new GameError('먼저 연결을 초기화해야 합니다.');
    return playerId;
  };

  socket.on('room:create', handle(socket, ({ nickname }) => {
    const room = rooms.createRoom(requireId(), nickname);
    return { code: room.code };
  }));

  socket.on('room:join', handle(socket, ({ nickname, code }) => {
    const room = rooms.joinRoom(requireId(), nickname, code);
    return { code: room.code };
  }));

  socket.on('room:leave', handle(socket, () => {
    rooms.leaveRoom(requireId());
    socket.emit('room:left');
  }));

  socket.on('room:ready', handle(socket, ({ ready }) => rooms.setReady(requireId(), ready)));
  socket.on('room:spectate', handle(socket, ({ spectator }) => rooms.setSpectator(requireId(), spectator)));
  socket.on('room:settings', handle(socket, (patch) => rooms.updateSettings(requireId(), patch)));
  socket.on('room:kick', handle(socket, ({ targetId }) => rooms.kick(requireId(), targetId)));
  socket.on('room:start', handle(socket, () => rooms.startGame(requireId())));
  socket.on('room:add-bot', handle(socket, () => rooms.addBot(requireId())));
  socket.on('room:remove-bot', handle(socket, ({ botId }) => rooms.removeBot(requireId(), botId)));
  socket.on('room:lobby', handle(socket, () => rooms.backToLobby(requireId())));

  socket.on('chat:send', handle(socket, ({ text }) => rooms.sendChat(requireId(), text)));

  socket.on('game:play', handle(socket, ({ cardId, targetId, as, pick }) =>
    rooms.gameAction(requireId(), (g) => g.playCard(playerId, cardId, targetId, { as: as || undefined, pick: pick || undefined }))));
  socket.on('game:back-to-play', handle(socket, () =>
    rooms.gameAction(requireId(), (g) => g.backToPlay(playerId))));
  socket.on('game:choose', handle(socket, (payload) =>
    rooms.gameAction(requireId(), (g) => g.choose(playerId, payload || {}))));
  socket.on('game:ability', handle(socket, (payload) =>
    rooms.gameAction(requireId(), (g) => g.useAbility(playerId, payload || {}))));
  socket.on('game:respond', handle(socket, ({ action, cardId, source }) =>
    rooms.gameAction(requireId(), (g) => g.respond(playerId, { action, cardId, source }))));
  socket.on('game:discard', handle(socket, ({ cardId }) =>
    rooms.gameAction(requireId(), (g) => g.discardCard(playerId, cardId))));
  socket.on('game:end-turn', handle(socket, () =>
    rooms.gameAction(requireId(), (g) => g.endTurn(playerId))));

  socket.on('disconnect', () => {
    if (playerId) rooms.detachSocket(playerId, socket);
  });
});

server.listen(PORT, () => {
  console.log(`Bang! 서버 실행 중: http://localhost:${PORT}`);
});
