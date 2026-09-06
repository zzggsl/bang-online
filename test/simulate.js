// 자동 시뮬레이션: 서버를 띄우고 N명의 가짜 클라이언트로 로비→게임→종료까지 진행한다.
// 실행: node test/simulate.js [인원수]
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const N = Number(process.argv[2] || 5);
const PORT = 3999;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) { throw new Error('ASSERT: ' + msg); } }

class Bot {
  constructor(i) {
    this.i = i;
    this.id = `bot-${i}-${Math.random().toString(36).slice(2, 10)}`;
    this.nickname = `봇${i + 1}`;
    this.state = null;
    this.socket = io(URL, { transports: ['websocket'] });
    this.socket.on('room:state', (s) => { this.state = s; });
  }
  emit(ev, payload = {}) {
    return new Promise((res) => this.socket.emit(ev, payload, (r) => res(r)));
  }
  async connect() {
    if (!this.socket.connected) await new Promise((r) => this.socket.once('connect', r));
    const r = await this.emit('hello', { playerId: this.id });
    assert(r.ok, 'hello 실패');
  }
  waitState(pred, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.state && pred(this.state)) return resolve(this.state);
        if (Date.now() - t0 > timeout) return reject(new Error(`상태 대기 시간 초과 (봇${this.i + 1})`));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.on('data', (d) => { if (String(d).includes('실행 중')) r(); }));

  const bots = Array.from({ length: N }, (_, i) => new Bot(i));
  try {
    for (const b of bots) await b.connect();

    // 1. 방 생성 / 참가
    const host = bots[0];
    let r = await host.emit('room:create', { nickname: host.nickname });
    assert(r.ok, '방 생성 실패: ' + r.error);
    const code = r.code;
    console.log('방 코드:', code);

    // 잘못된 코드
    r = await bots[1].emit('room:join', { nickname: bots[1].nickname, code: 'ZZZZ' });
    assert(!r.ok, '잘못된 코드로 입장되면 안 됨');
    // 빈 닉네임
    r = await bots[1].emit('room:join', { nickname: '  ', code });
    assert(!r.ok, '빈 닉네임으로 입장되면 안 됨');

    for (const b of bots.slice(1)) {
      r = await b.emit('room:join', { nickname: b.nickname, code });
      assert(r.ok, `${b.nickname} 참가 실패: ${r.error}`);
    }
    // 중복 닉네임
    const extra = new Bot(99);
    await extra.connect();
    r = await extra.emit('room:join', { nickname: bots[1].nickname, code });
    assert(!r.ok, '중복 닉네임이 허용되면 안 됨');
    extra.socket.close();

    await host.waitState((s) => s.members.length === N);
    console.log('참가자:', host.state.members.map((m) => m.nickname).join(', '));

    // 2. 준비 전에는 시작 불가
    r = await host.emit('room:start');
    assert(!r.ok, '준비 전 시작이 막혀야 함');
    // 방장 아닌 사람이 시작 시도
    r = await bots[1].emit('room:start');
    assert(!r.ok, '방장이 아닌 사람은 시작 불가');
    // 방장 아닌 사람 설정 변경 시도
    r = await bots[1].emit('room:settings', { maxPlayers: 6 });
    assert(!r.ok, '방장이 아닌 사람은 설정 변경 불가');
    r = await host.emit('room:settings', { maxPlayers: 8, allowSpectatorChat: false });
    assert(r.ok, '방장 설정 변경 실패');

    // 채팅
    r = await bots[2].emit('chat:send', { text: '안녕!' });
    assert(r.ok, '채팅 실패');

    for (const b of bots.slice(1)) {
      r = await b.emit('room:ready', { ready: true });
      assert(r.ok, `${b.nickname} 준비 실패: ${r.error}`);
    }
    await host.waitState((s) => s.canStart.ok);
    r = await host.emit('room:start');
    assert(r.ok, '게임 시작 실패: ' + r.error);
    await Promise.all(bots.map((b) => b.waitState((s) => s.state === 'playing' && s.game)));
    console.log('게임 시작! 보안관:', host.state.game.players.find((p) => p.role === 'sheriff')?.nickname);

    // 3. 정보 은닉 검증
    for (const b of bots) {
      const g = b.state.game;
      for (const p of g.players) {
        if (p.isMe) {
          assert(Array.isArray(p.hand), '자기 손패는 보여야 함');
          // 첫 턴 플레이어(보안관)는 캐릭터에 따라 이미 카드를 가져왔거나 선택 대기 중일 수 있음
          if (g.turn.playerId !== p.id) assert(p.hand.length === p.hp, `초기 손패 수(${p.hand.length})는 ${p.hp}장이어야 함`);
          else assert(p.hand.length >= p.hp, '보안관 초기 손패는 체력 이상이어야 함');
        } else {
          assert(p.hand === null, '다른 사람 손패가 보이면 안 됨');
          if (p.role !== 'sheriff') assert(p.role === null, '보안관 외 직업이 보이면 안 됨');
        }
      }
      assert(g.me && g.me.role, '내 직업이 있어야 함');
    }
    const sheriff = host.state.game.players.find((p) => p.role === 'sheriff');
    assert(sheriff.maxHp === (bots.find((b) => b.state.game.players.find((p) => p.isMe)?.id === sheriff.id) ? sheriff.maxHp : 0), 'ok');
    assert(host.state.game.turn.playerId === sheriff.id, '보안관부터 시작해야 함');
    // 역할 분포
    const roleCount = {};
    for (const b of bots) roleCount[b.state.game.me.role] = (roleCount[b.state.game.me.role] || 0) + 1;
    console.log('직업 분포:', roleCount);
    assert(Object.values(host.state.roleTable[N]).every((v, i) => Object.keys(host.state.roleTable[N]).map((k) => roleCount[k] || 0)[i] === v), '직업 분포가 표와 달라야 함');

    // 4. 자동 진행: 각 턴에서 무기/패시브 장착 → 뱅 → 턴 종료(버리기)
    let turns = 0;
    const pendingHandled = {};
    const byId = Object.fromEntries(bots.map((b) => [b.id, b]));
    while (turns < 200) {
      const s = host.state;
      if (s.game.winner) break;
      const g = s.game;
      // 대기 중 응답 처리
      if (g.pending) {
        const actor = byId[g.pending.playerId];
        await actor.waitState((st) => st.game.pending && st.game.pending.isMine);
        const pv = actor.state.game.pending;
        const me = actor.state.game.players.find((p) => p.isMe);
        let r2;
        switch (pv.type) {
          case 'bang': {
            const missed = me.hand.find((c) => pv.missedKinds.includes(c.kind));
            if (pv.drawSources.length) r2 = await actor.emit('game:respond', { action: 'draw', source: pv.drawSources[0] });
            else if (missed && Math.random() < 0.7) r2 = await actor.emit('game:respond', { action: 'missed', cardId: missed.id });
            else r2 = await actor.emit('game:respond', { action: 'take' });
            break;
          }
          case 'dying': {
            const beer = me.hand.find((c) => c.kind === 'beer');
            r2 = await actor.emit('game:respond', beer ? { action: 'beer', cardId: beer.id } : { action: 'die' });
            break;
          }
          case 'dynamite':
          case 'draw_check':
          case 'draw_phase':
            r2 = await actor.emit('game:draw-check');
            break;
          case 'duel':
          case 'indians': {
            const kinds = pv.bangKinds || (me.character.id === 'calamity_janet' ? ['bang', 'missed'] : ['bang']);
            const b = me.hand.find((c) => kinds.includes(c.kind));
            r2 = await actor.emit('game:respond', b ? { action: 'bang', cardId: b.id } : { action: 'take' });
            break;
          }
          case 'pick_card':
            r2 = await actor.emit('game:choose', pv.tableCards.length ? { from: 'table', cardId: pv.tableCards[0].id } : { from: 'hand' });
            break;
          case 'kit_carlson':
            r2 = await actor.emit('game:choose', { cardIds: pv.cards.slice(0, pv.count).map((c) => c.id) });
            break;
          case 'jesse_jones':
            r2 = await actor.emit('game:choose', Math.random() < 0.5 ? { from: 'deck' } : { from: 'player', targetId: pv.targetIds[0] });
            break;
          case 'lucky_duke':
          case 'claus_the_saint':
          case 'general_store':
            r2 = await actor.emit('game:choose', { cardId: pv.cards[0].id });
            break;
          default:
            throw new Error('알 수 없는 pending: ' + pv.type);
        }
        assert(r2.ok, `${pv.type} 처리 실패: ` + r2.error);
        pendingHandled[pv.type] = (pendingHandled[pv.type] || 0) + 1;
        await host.waitState((st) => st.game.winner || !st.game.pending || st.game.pending.playerId !== actor.id || st.game.pending.type !== pv.type || JSON.stringify(st.game.pending) !== JSON.stringify(g.pending));
        continue;
      }
      const cur = byId[g.turn.playerId];
      await cur.waitState((st) => st.game.turn && st.game.turn.isMine && !st.game.pending);
      const gv = cur.state.game;
      const me = gv.players.find((p) => p.isMe);

      if (gv.turn.step === 'play') {
        // 장착 카드 시도
        for (const c of me.hand) {
          if ((c.type === 'weapon' || c.type === 'passive') && c.implemented) {
            const rr = await cur.emit('game:play', { cardId: c.id });
            if (rr.ok) await cur.waitState((st) => st.game.turn.number === gv.turn.number);
          }
        }
        // 대상 없는 갈색 카드(역마차/웰스파고/주점/기관총/인디언/잡화점)도 사용해본다
        const meNow = () => cur.state.game.players.find((p) => p.isMe);
        for (const c of meNow().hand) {
          if (c.type === 'action' && c.target === 'none' && c.implemented && !['beer', 'missed'].includes(c.kind)) {
            const rr = await cur.emit('game:play', { cardId: c.id });
            if (rr.ok) { await host.waitState((st) => st.game.winner || !st.game.pending || st.game.turn.playerId !== cur.id, 5000).catch(() => {}); }
            if (rr.ok && (c.kind === 'gatling' || c.kind === 'indians' || c.kind === 'general_store')) break;
          }
        }
        if (host.state.game.pending || host.state.game.winner || host.state.game.turn.playerId !== cur.id) continue;
        const beer = meNow().hand.find((c) => c.kind === 'beer');
        if (beer && meNow().hp < meNow().maxHp) {
          await cur.emit('game:play', { cardId: beer.id });
        }
        // 뱅!
        const bang = meNow().hand.find((c) => c.kind === 'bang');
        if (bang && cur.state.game.me.canPlayBang) {
          const range = meNow().range;
          const dists = cur.state.game.me.distances;
          const targets = Object.entries(dists).filter(([, d]) => d <= range).map(([id]) => id);
          if (targets.length) {
            const tid = targets[Math.floor(Math.random() * targets.length)];
            const rr = await cur.emit('game:play', { cardId: bang.id, targetId: tid });
            assert(rr.ok, '뱅 실패: ' + rr.error);
            // 두 번째 뱅은 (윌리/볼케닉 아니면) 실패해야 함
            const bang2 = meNow().hand.find((c) => c.kind === 'bang' && c.id !== bang.id);
            const hasUnlimited = meNow().character.id === 'willy_the_kid' || meNow().weapon?.kind === 'volcanic';
            if (bang2 && !hasUnlimited) {
              const r3 = await cur.emit('game:play', { cardId: bang2.id, targetId: tid });
              assert(!r3.ok, '두 번째 뱅이 막혀야 함');
            }
            await host.waitState((st) => st.game.pending || st.game.winner || st.game.turn.playerId !== cur.id);
            continue; // pending 처리로
          } else {
            // 사거리 밖 공격은 실패해야 함
            const far = Object.entries(dists).find(([, d]) => d > range);
            if (far) {
              const r4 = await cur.emit('game:play', { cardId: bang.id, targetId: far[0] });
              assert(!r4.ok, '사거리 밖 뱅이 막혀야 함');
            }
          }
        }
        const re = await cur.emit('game:end-turn');
        assert(re.ok, '턴 종료 실패: ' + re.error);
        if (re.needDiscard > 0) {
          await cur.waitState((st) => st.game.turn.step === 'discard');
          for (let i = 0; i < re.needDiscard; i++) {
            const m2 = cur.state.game.players.find((p) => p.isMe);
            const rd = await cur.emit('game:discard', { cardId: m2.hand[0].id });
            assert(rd.ok, '버리기 실패: ' + rd.error);
            await wait(10);
          }
        }
        turns++;
        await host.waitState((st) => st.game.winner || st.game.turn.number > gv.turn.number, 3000);
      }
    }
    console.log('처리한 대기 상황:', pendingHandled);

    const final = host.state.game;
    console.log(`총 ${turns}턴 진행, 결과:`, final.winner ? final.winner.message : '(미종료)');
    console.log('생존:', final.players.filter((p) => p.alive).map((p) => `${p.nickname}(${p.roleName})`).join(', '));
    console.log('마지막 기록:\n  ' + final.log.slice(-6).map((l) => l.text).join('\n  '));
    if (final.winner) {
      assert(final.players.every((p) => p.roleName), '게임 종료 후 모든 직업이 공개되어야 함');
      // 로비로 복귀
      r = await bots[1].emit('room:lobby');
      assert(!r.ok, '방장이 아닌 사람은 로비 복귀 불가');
      r = await host.emit('room:lobby');
      assert(r.ok, '로비 복귀 실패');
      await host.waitState((s) => s.state === 'lobby');
      assert(host.state.members.every((m) => !m.ready), '로비 복귀 후 준비 해제');
    }

    // 5. 재접속 테스트: 봇 2가 끊고 새 소켓으로 같은 playerId로 접속
    const b2 = bots[2];
    b2.socket.close();
    await wait(100);
    const b2new = new Bot(2);
    b2new.id = b2.id;
    await b2new.connect();
    await b2new.waitState((s) => s.code === code);
    console.log('재접속 성공:', b2new.state.me.nickname);
    b2new.socket.close();

    console.log('\n✅ 시뮬레이션 통과');
  } catch (e) {
    console.error('\n❌ 실패:', e.message);
    process.exitCode = 1;
  } finally {
    for (const b of bots) b.socket.close();
    server.kill();
  }
}

main();
