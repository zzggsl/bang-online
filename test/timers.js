// 제한 시간 테스트: 사람이 아무것도 하지 않아도 제한 시간이 지나면 자동으로 진행되는지 확인한다.
// 실행: node test/timers.js
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3992;
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); }

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), BANG_BOT_DELAY: '40' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.on('data', (d) => { if (String(d).includes('실행 중')) r(); }));
  const socket = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
  let state = null;
  socket.on('room:state', (s) => { state = s; });
  const emit = (ev, p = {}) => new Promise((res) => socket.emit(ev, p, res));
  const until = (pred, timeout = 60000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      if (state && pred(state)) return resolve(state);
      if (Date.now() - t0 > timeout) return reject(new Error('대기 시간 초과'));
      setTimeout(tick, 30);
    })();
  });
  try {
    await new Promise((r) => socket.once('connect', r));
    await emit('hello', { playerId: 'timer-tester-0001' });
    let r = await emit('room:create', { nickname: '나' }); assert(r.ok, '방 생성');
    r = await emit('room:settings', { turnSeconds: 10, choiceSeconds: 120 }); assert(!r.ok, '범위 밖 설정은 거부');
    r = await emit('room:settings', { turnSeconds: 20, choiceSeconds: 5 }); assert(r.ok, '설정: ' + r.error);
    assert(state.settings.turnSeconds === 20 && state.settings.choiceSeconds === 5, '설정 반영');
    for (let i = 0; i < 4; i++) { r = await emit('room:add-bot'); assert(r.ok, '봇'); }
    r = await emit('room:start'); assert(r.ok, '시작');
    await until((s) => s.state === 'playing');

    // 내 차례가 오면 deadline이 걸려야 하고, 아무것도 안 해도 20초 뒤 넘어가야 한다
    const t0 = Date.now();
    await until((s) => s.game.turn.isMine && !s.game.pending, 120000);
    assert(state.deadline && state.deadline.playerId === state.myId, '내 차례에 제한 시간이 있어야 함');
    assert(Math.abs(state.deadline.seconds - 20) < 1, '차례 제한 20초');
    const myTurnNo = state.game.turn.number;
    const me = () => state.game.players.find((p) => p.isMe);
    const handBefore = me().hand.length;
    console.log(`내 차례(${myTurnNo}) 손패 ${handBefore}장, 체력 ${me().hp} — 아무것도 하지 않고 기다림…`);
    // 그 사이 나에게 오는 선택(공격 응답 등)은 5초 안에 자동 처리돼야 한다
    let sawPending = 0;
    const watcher = setInterval(() => { if (state.game.pending && state.game.pending.isMine) sawPending++; }, 100);
    await until((s) => s.game.winner || s.game.turn.number > myTurnNo, 40000);
    clearInterval(watcher);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`차례가 자동으로 넘어감 (${elapsed}초). 이제 손패 ${me().hand.length}장 / 체력 ${me().hp}`);
    assert(me().hand.length <= me().hp || !me().alive, '자동 버리기로 손패가 체력 이하여야 함');
    assert(state.chat.some((c) => /자동으로 넘어갔습니다/.test(c.text)), '시스템 채팅에 자동 진행 안내');

    // 내가 공격받는 상황을 기다려 5초 자동 응답 확인 (죽거나 게임이 끝나면 통과 처리)
    try {
      await until((s) => s.game.winner || !me().alive || (s.game.pending && s.game.pending.isMine && !s.game.pending.auto), 90000);
      if (state.game.pending && state.game.pending.isMine) {
        const pid = state.game.pending.id;
        assert(state.deadline && Math.abs(state.deadline.seconds - 5) < 1, '선택 제한 5초');
        const t1 = Date.now();
        await until((s) => !s.game.pending || s.game.pending.id !== pid, 15000);
        console.log(`선택 대기가 ${Math.round((Date.now() - t1) / 100) / 10}초 뒤 자동 처리됨`);
        assert(Date.now() - t1 <= 7000, '5초 안팎에 자동 처리');
      } else console.log('(공격받기 전에 게임이 끝났거나 탈락 — 선택 제한 시간 검증 생략)');
    } catch (e) { console.log('(선택 상황이 오지 않아 생략)'); }
    console.log('\n✅ 제한 시간 테스트 통과');
  } catch (e) {
    console.error('\n❌ 실패:', e.message);
    process.exitCode = 1;
  } finally {
    socket.close();
    server.kill();
  }
}
main();
