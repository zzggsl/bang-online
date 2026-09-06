// 봇 테스트: 사람 1명(자동 조작) + 봇 N명으로 게임이 끝까지 진행되는지 확인한다.
// 실행: node test/bots.js [봇 수]
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const BOTS = Number(process.argv[2] || 4);
const PORT = 3996;
const URL = `http://localhost:${PORT}`;
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); }
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), BANG_BOT_DELAY: process.env.BANG_BOT_DELAY || '40' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.on('data', (d) => { if (String(d).includes('실행 중')) r(); }));

  const socket = io(URL, { transports: ['websocket'] });
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
    await emit('hello', { playerId: 'human-tester-0001' });
    let r = await emit('room:create', { nickname: '나' });
    assert(r.ok, '방 생성');
    for (let i = 0; i < BOTS; i++) { r = await emit('room:add-bot'); assert(r.ok, '봇 추가: ' + r.error); }
    if (BOTS >= 7) { r = await emit('room:add-bot'); assert(!r.ok, '자리 초과 시 봇 추가가 막혀야 함'); }
    await until((s) => s.members.filter((m) => m.isBot).length >= BOTS);
    console.log('참가자:', state.members.map((m) => m.nickname + (m.isBot ? '(봇)' : '')).join(', '));
    assert(state.canStart.ok, '봇은 자동 준비 상태여야 함: ' + state.canStart.reason);

    // 봇 하나 제거 후 다시 추가
    const bot0 = state.members.find((m) => m.isBot);
    r = await emit('room:remove-bot', { botId: bot0.id }); assert(r.ok, '봇 제거');
    r = await emit('room:add-bot'); assert(r.ok, '봇 재추가');
    await until((s) => s.members.filter((m) => m.isBot).length === BOTS);

    r = await emit('room:start'); assert(r.ok, '시작: ' + r.error);
    await until((s) => s.state === 'playing');
    console.log('게임 시작. 내 직업:', state.game.me.roleName, '/ 보안관:', state.game.players.find((p) => p.role === 'sheriff').nickname);

    // 사람 플레이어 자동 조작: 내 턴이면 뱅 한 번 시도 후 턴 종료, 공격받으면 피해 받기
    const t0 = Date.now();
    let humanTurns = 0;
    const handled = {};
    while (!state.game.winner && Date.now() - t0 < 180000) {
      const g = state.game;
      const me = g.players.find((p) => p.isMe);
      if (g.pending && g.pending.isMine) {
        const pv = g.pending;
        if (pv.type === 'bang') {
          const missed = me.hand.find((c) => pv.missedKinds.includes(c.kind));
          if (pv.drawSources.length) r = await emit('game:respond', { action: 'draw', source: pv.drawSources[0] });
          else if (missed) r = await emit('game:respond', { action: 'missed', cardId: missed.id });
          else r = await emit('game:respond', { action: 'take' });
        } else if (pv.type === 'dying') {
          const beer = me.hand.find((c) => c.kind === 'beer');
          r = await emit('game:respond', beer ? { action: 'beer', cardId: beer.id } : { action: 'die' });
        } else if (pv.type === 'dynamite' || pv.type === 'draw_check' || pv.type === 'draw_phase') {
          r = await emit('game:draw-check');
        } else if (pv.type === 'duel' || pv.type === 'indians') {
          const kinds = pv.bangKinds || ['bang'];
          const b = me.hand.find((c) => kinds.includes(c.kind));
          r = await emit('game:respond', b ? { action: 'bang', cardId: b.id } : { action: 'take' });
        } else if (pv.type === 'pick_card') {
          r = await emit('game:choose', pv.tableCards.length ? { from: 'table', cardId: pv.tableCards[0].id } : { from: 'hand' });
        } else if (pv.type === 'kit_carlson') {
          r = await emit('game:choose', { cardIds: pv.cards.slice(0, pv.count).map((c) => c.id) });
        } else if (pv.type === 'jesse_jones') {
          r = await emit('game:choose', { from: 'player', targetId: pv.targetIds[0] });
        } else {
          r = await emit('game:choose', { cardId: pv.cards[0].id });
        }
        assert(r.ok, `${pv.type} 처리: ` + r.error);
        handled[pv.type] = (handled[pv.type] || 0) + 1;
        await wait(50);
        continue;
      }
      if (g.turn && g.turn.isMine && !g.pending && me.alive) {
        if (g.turn.step === 'play') {
          const bang = me.hand.find((c) => c.kind === 'bang');
          if (bang && g.me.canPlayBang) {
            const tid = Object.entries(g.me.distances).find(([, d]) => d <= me.range)?.[0];
            if (tid) { r = await emit('game:play', { cardId: bang.id, targetId: tid }); assert(r.ok, '뱅: ' + r.error); await wait(50); continue; }
          }
          r = await emit('game:end-turn'); assert(r.ok, '턴 종료: ' + r.error);
          humanTurns++;
        } else if (g.turn.step === 'discard') {
          r = await emit('game:discard', { cardId: me.hand[0].id }); assert(r.ok, '버리기: ' + r.error);
        }
        await wait(50);
        continue;
      }
      await wait(100);
    }
    const g = state.game;
    console.log(`결과: ${g.winner ? g.winner.message : '(미종료)'} — 내 턴 ${humanTurns}회, 총 ${g.turn.number}턴, ${Math.round((Date.now() - t0) / 1000)}초`);
    console.log('내가 처리한 대기 상황:', handled);
    console.log('마지막 기록:\n  ' + g.log.slice(-5).map((l) => l.text).join('\n  '));
    if (!g.winner) console.log('멈춘 상태:', JSON.stringify({ turn: g.turn, pending: g.pending }));
    assert(g.winner, '게임이 시간 안에 끝나야 함');
    r = await emit('room:lobby'); assert(r.ok, '로비 복귀');
    await until((s) => s.state === 'lobby');
    assert(state.members.filter((m) => m.isBot).every((m) => m.ready), '로비 복귀 후 봇은 준비 상태 유지');
    console.log('\n✅ 봇 테스트 통과');
  } catch (e) {
    console.error('\n❌ 실패:', e.message);
    process.exitCode = 1;
  } finally {
    socket.close();
    server.kill();
  }
}
main();
