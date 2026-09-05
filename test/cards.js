// 게임 카드 단위 테스트 — 엔진을 직접 조작해 각 카드가 스펙대로 동작하는지 확인한다.
// 실행: node test/cards.js
const { Game } = require('../server/game/engine');

let passed = 0;
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); }
function test(name, fn) {
  try { fn(); passed++; console.log('  ✔', name); } catch (e) { console.error('  ✘', name, '—', e.message); process.exitCode = 1; }
}
const card = (id, kind, suit = 'S', rank = '7') => ({ id, kind, suit, rank });
const throws = (fn) => { try { fn(); return false; } catch (e) { return e.message; } };

/** n명 게임: 0번이 보안관, 나머지 무법자. 캐릭터는 능력 없는 것처럼 윌리(뱅 무제한)를 기본으로 두되 필요하면 지정 */
function setup(n, chars = [], roles) {
  const seats = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nickname: `P${i}` }));
  const g = new Game(seats);
  roles = roles || ['sheriff', ...Array(n - 1).fill('outlaw')];
  g.players.forEach((p, i) => {
    p.role = roles[i]; p.revealed = roles[i] === 'sheriff';
    p.characterId = chars[i] || 'bart_cassidy'; // 바트: 체력 잃을 때 카드 1장 (테스트에 영향 적음)
    if (chars[i] === undefined) p.characterId = 'rose_doolan';
    p.maxHp = 4 + (p.role === 'sheriff' ? 1 : 0); p.hp = p.maxHp;
    p.hand = []; p.weapon = null; p.passives = [];
  });
  // 로즈 둘란은 거리에 영향 → 기본은 능력이 거리/카드에 영향 없는 캐릭터로
  g.players.forEach((p, i) => { if (chars[i] === undefined) p.characterId = 'suzy_lafayette'; });
  // 수지도 손이 비면 카드를 뽑아 손패 수 검증이 흔들린다 → 능력이 사실상 안 나오는 엉클 윌로
  g.players.forEach((p, i) => { if (chars[i] === undefined) p.characterId = 'uncle_will'; });
  g.pending = null;
  g.deck = g.deck.concat(g.discard); g.discard = [];
  g.turn = { playerId: 'p0', step: 'play', bangsPlayed: 0, number: 1, abilityUsed: false };
  return g;
}
const P = (g, i) => g.players[i];

console.log('게임 카드 테스트');

test('술통: 공격받으면 카드 펼치기, 하트면 회피 (선택 사항)', () => {
  const g = setup(4);
  P(g, 1).passives = [card('bar', 'barrel')];
  P(g, 0).hand = [card('b1', 'bang'), card('b2', 'bang')];
  g.deck.push(card('h', 'beer', 'H'));
  g.playCard('p0', 'b1', 'p1');
  assert(g.pending.drawSources.includes('barrel'), '술통 펼치기 가능');
  g.respond('p1', { action: 'draw', source: 'barrel' });
  assert(!g.pending && P(g, 1).hp === 4, '하트 → 회피');
  g.turn.bangsPlayed = 0;
  g.playCard('p0', 'b2', 'p1');
  g.respond('p1', { action: 'take' }); // 술통을 안 쓰고 맞을 수도 있음
  assert(P(g, 1).hp === 3, '술통은 강제가 아님');
});

test('주르도네 + 술통 중복 사용', () => {
  const g = setup(4, [undefined, 'jourdonnais']);
  P(g, 1).passives = [card('bar', 'barrel')];
  P(g, 0).hand = [card('b1', 'bang')];
  g.deck.push(card('h', 'beer', 'H'), card('s', 'bang', 'S'));
  g.playCard('p0', 'b1', 'p1');
  assert(g.pending.drawSources.length === 2, '두 가지 수단');
  g.respond('p1', { action: 'draw', source: 'jourdonnais' }); // 스페이드 → 실패
  assert(g.pending && g.pending.drawSources.length === 1, '한 번 더 가능');
  g.respond('p1', { action: 'draw', source: 'barrel' }); // 하트 → 성공
  assert(!g.pending && P(g, 1).hp === 4, '두 번째에 회피');
});

test('다이너마이트(즉시 발동): 사용자부터 차례로 펼치고, 스페이드 2~9면 그 사람이 체력 2를 잃고 끝', () => {
  const g = setup(4);
  P(g, 0).hand = [card('dyn', 'dynamite', 'H', '2'), card('b', 'bang')];
  // 더미 맨 위부터: p0 클로버(통과) → p1 하트(통과) → p2 스페이드 5(폭발)
  g.deck.push(card('x3', 'bang', 'S', '5'), card('x2', 'beer', 'H', '6'), card('x1', 'bang', 'C', '5'));
  g.playCard('p0', 'dyn');
  assert(g.pending && g.pending.type === 'dynamite' && g.pending.manual && g.pending.playerId === 'p0', '사용자부터 펼치기 대기');
  assert(throws(() => g.manualDraw('p1')), '다른 사람은 못 펼침');
  g.resolveDynamite();
  assert(g.pending.type === 'dynamite' && g.pending.playerId === 'p1', '안 터지면 다음 사람');
  g.resolveDynamite();
  assert(g.pending.playerId === 'p2', '또 다음');
  g.resolveDynamite();
  assert(!g.pending, '터지면 끝');
  assert(P(g, 2).hp === 2 && P(g, 0).hp === 5 && P(g, 1).hp === 4, 'p2만 체력 2 잃음');
  assert(g.discard.some((c) => c.id === 'dyn'), '다이너마이트 버려짐');
  assert(g.turn.playerId === 'p0' && g.turn.step === 'play', '사용자의 차례가 이어짐');
  g.playCard('p0', 'b', 'p1'); // 차례 계속 진행 가능
  assert(g.pending.type === 'bang', '뱅 사용 가능');
});

test('다이너마이트 폭발로 체력 0 → 맥주로 생존', () => {
  const g = setup(4);
  P(g, 1).hp = 2; P(g, 1).hand = [card('beer', 'beer', 'H')];
  P(g, 0).hand = [card('dyn', 'dynamite', 'H', '2')];
  g.deck.push(card('x2', 'bang', 'S', '2'), card('x1', 'bang', 'C', '5'));
  g.playCard('p0', 'dyn');
  g.resolveDynamite(); // p0 통과
  g.resolveDynamite(); // p1 폭발 → 체력 0
  assert(g.pending && g.pending.type === 'dying' && g.pending.playerId === 'p1', '죽어가는 중');
  g.respond('p1', { action: 'beer', cardId: 'beer' });
  assert(P(g, 1).alive && P(g, 1).hp === 1 && !g.pending, '생존, 대기 없음');
  assert(g.turn.playerId === 'p0' && g.turn.step === 'play', 'p0 차례 계속');
});

test('다이너마이트: 럭키 듀크가 받으면 두 장 중 선택', () => {
  const g = setup(4, [undefined, 'lucky_duke']);
  P(g, 0).hand = [card('dyn', 'dynamite', 'H', '2')];
  g.deck.push(card('l2', 'bang', 'S', '3'), card('l1', 'beer', 'H', '6'), card('x1', 'bang', 'C', '5'));
  g.playCard('p0', 'dyn');
  g.resolveDynamite(); // p0 통과
  g.resolveDynamite(); // p1 = 럭키 듀크 → 선택 대기
  assert(g.pending.type === 'lucky_duke' && g.pending.playerId === 'p1', '럭키 듀크 선택');
  g.choose('p1', { cardId: 'l1' }); // 하트 선택 → 통과
  assert(g.pending.type === 'dynamite' && g.pending.playerId === 'p2', '통과 후 다음 사람');
});

test('감옥: 하트면 탈출하고 진행, 아니면 차례 통째로 건너뜀. 보안관에게도 가능, 셀프 가능', () => {
  const g = setup(4);
  P(g, 0).hand = [card('j', 'jail', 'H', '4'), card('j2', 'jail', 'S', '10'), card('j3', 'jail', 'S', 'J')];
  g.playCard('p0', 'j3', 'p0');
  assert(g.hasPassive(P(g, 0), 'jail'), '보안관(셀프)에게도 감옥 가능');
  P(g, 0).passives = [];
  g.playCard('p0', 'j', 'p1');
  assert(g.hasPassive(P(g, 1), 'jail'), 'p1 감옥');
  assert(throws(() => g.playCard('p0', 'j2', 'p1')), '같은 이름 한 장만');
  g.deck.push(card('x', 'bang', 'C', '5')); // p1이 펼칠 카드: 클로버 → 실패
  g.endTurn('p0');
  assert(g.pending && g.pending.type === 'draw_check' && g.pending.playerId === 'p1', 'p1이 직접 펼쳐야 함');
  g.manualDraw('p1');
  assert(g.turn.playerId === 'p2', 'p1 차례를 건너뛰고 p2');
  assert(!g.hasPassive(P(g, 1), 'jail') && P(g, 1).hand.length === 0, '감옥 버려지고 카드도 못 가져옴');
  // 셀프 감옥 + 탈출
  const g2 = setup(4, [], ['outlaw', 'sheriff', 'outlaw', 'outlaw']);
  g2.turn = { playerId: 'p0', step: 'play', bangsPlayed: 0, number: 1, abilityUsed: false };
  P(g2, 0).hand = [card('j', 'jail', 'H', '4')];
  g2.playCard('p0', 'j', 'p0');
  assert(g2.hasPassive(P(g2, 0), 'jail'), '셀프 감옥');
  g2.deck.push(card('x', 'beer', 'H', '6'));
  g2.turn = { playerId: 'p3', step: 'play', bangsPlayed: 0, number: 1, abilityUsed: false };
  g2.endTurn('p3');
  g2.manualDraw('p0');
  assert(g2.turn.playerId === 'p0' && g2.turn.step === 'play' && !g2.hasPassive(P(g2, 0), 'jail'), '하트 → 탈출, 진행');
});

test('야생마/조준경: 거리 계산', () => {
  const g = setup(5);
  P(g, 1).passives = [card('m', 'mustang')];
  assert(g.distance('p0', 'p1') === 2, '야생마: 상대가 볼 때 +1');
  assert(g.distance('p1', 'p0') === 1, '본인이 볼 때는 그대로');
  P(g, 0).passives = [card('s', 'scope')];
  assert(g.distance('p0', 'p1') === 1 && g.distance('p0', 'p2') === 1, '조준경: 본인이 볼 때 -1');
});

test('무기: 한 장만, 새 무기를 놓으면 기존 무기는 버려짐', () => {
  const g = setup(4);
  P(g, 0).hand = [card('w1', 'schofield'), card('w2', 'winchester')];
  g.playCard('p0', 'w1'); g.playCard('p0', 'w2');
  assert(P(g, 0).weapon.id === 'w2' && g.discard.some((c) => c.id === 'w1'), '교체');
  assert(g.weaponRange(P(g, 0)) === 5, '사거리 5');
});

test('캣 벌로우: 손(무작위) 또는 앞에 놓인 카드 선택해서 버리기, 거리 무관', () => {
  const g = setup(5);
  P(g, 2).hand = [card('h1', 'bang')]; P(g, 2).weapon = card('w', 'remington'); P(g, 2).passives = [card('m', 'mustang')];
  P(g, 0).hand = [card('c1', 'cat_balou'), card('c2', 'cat_balou'), card('c3', 'cat_balou')];
  g.playCard('p0', 'c1', 'p2');
  assert(g.pending.type === 'pick_card' && g.pending.playerId === 'p0', '선택 대기');
  g.choose('p0', { from: 'table', cardId: 'w' });
  assert(!P(g, 2).weapon && g.discard.some((c) => c.id === 'w'), '무기 버려짐');
  g.playCard('p0', 'c2', 'p2', { pick: { from: 'hand' } });
  assert(P(g, 2).hand.length === 0 && g.discard.some((c) => c.id === 'h1'), '손에서 버림 (바로 지정)');
  g.playCard('p0', 'c3', 'p2'); // 남은 건 야생마 하나뿐 → 자동
  assert(!g.pending && P(g, 2).passives.length === 0, '선택지 하나면 자동 처리');
  P(g, 0).hand = [card('c4', 'cat_balou')];
  assert(throws(() => g.playCard('p0', 'c4', 'p2')), '카드 없는 상대에게는 불가');
});

test('강탈!: 거리 1, 손 또는 앞 카드를 내 손으로. 자기 자신의 앞 카드도 가능', () => {
  const g = setup(5);
  P(g, 1).weapon = card('w', 'schofield'); P(g, 1).hand = [card('h', 'missed')];
  P(g, 0).hand = [card('k1', 'panic'), card('k2', 'panic'), card('k3', 'panic')];
  assert(throws(() => g.playCard('p0', 'k1', 'p2')), '거리 2는 불가');
  g.playCard('p0', 'k1', 'p1', { pick: { from: 'table', cardId: 'w' } });
  assert(!P(g, 1).weapon && P(g, 0).hand.some((c) => c.id === 'w'), '무기를 내 손으로');
  g.playCard('p0', 'k2', 'p1', { pick: { from: 'hand' } });
  assert(P(g, 1).hand.length === 0 && P(g, 0).hand.some((c) => c.id === 'h'), '손에서 무작위로');
  P(g, 0).passives = [card('m', 'mustang')];
  g.playCard('p0', 'k3', 'p0');
  assert(P(g, 0).passives.length === 0 && P(g, 0).hand.some((c) => c.id === 'm'), '셀프 강탈로 내 앞 카드 회수');
});

test('결투: 번갈아 뱅! 버리기, 먼저 못 내는 쪽이 피해. 뱅 제한과 무관, 진 도전자는 보상 없음', () => {
  const g = setup(4, ['slab_the_killer']);
  P(g, 0).hand = [card('d', 'duel'), card('b1', 'bang'), card('b2', 'bang')];
  P(g, 1).hand = [card('x1', 'bang')];
  g.turn.bangsPlayed = 1; // 이미 뱅을 썼어도 결투는 가능
  g.playCard('p0', 'd', 'p1');
  assert(g.pending.type === 'duel' && g.pending.playerId === 'p1', '표적부터');
  g.respond('p1', { action: 'bang', cardId: 'x1' });
  assert(g.pending.playerId === 'p0', '도전자 차례');
  g.respond('p0', { action: 'bang', cardId: 'b1' });
  assert(g.pending.playerId === 'p1', '다시 표적');
  g.respond('p1', { action: 'take' });
  assert(!g.pending && P(g, 1).hp === 3 && P(g, 0).hand.length === 1, '표적 피해 1, 남은 뱅은 손에');
  assert(g.turn.bangsPlayed === 1, '결투의 뱅은 사용 횟수에 안 들어감');
  // 도전자(무법자)가 져서 탈락해도 상대에게 보상 없음
  const g2 = setup(4, [], ['sheriff', 'outlaw', 'outlaw', 'outlaw']);
  g2.turn = { playerId: 'p1', step: 'play', bangsPlayed: 0, number: 1, abilityUsed: false };
  P(g2, 1).hp = 1; P(g2, 1).hand = [card('d', 'duel')];
  P(g2, 0).hand = [card('b', 'bang')];
  g2.playCard('p1', 'd', 'p0');
  g2.respond('p0', { action: 'bang', cardId: 'b' });
  g2.respond('p1', { action: 'take' });
  assert(!P(g2, 1).alive && P(g2, 0).hand.length === 0, '도전자 탈락, 보안관에게 카드 보상 없음');
});

test('기관총: 다른 모두를 공격, 빗나감/술통으로 회피, 슬랩 능력은 적용 안 됨, 죽어도 연쇄 계속', () => {
  const g = setup(5, ['slab_the_killer']);
  P(g, 0).hand = [card('gat', 'gatling')];
  P(g, 1).hand = [card('m', 'missed')];
  P(g, 2).passives = [card('bar', 'barrel')];
  P(g, 3).hp = 1;
  g.deck.push(card('h', 'beer', 'H'));
  g.playCard('p0', 'gat');
  assert(g.pending.type === 'bang' && g.pending.subtype === 'gatling' && g.pending.playerId === 'p1', 'p1부터');
  assert(g.pending.needed === 1, '슬랩 능력 미적용');
  g.respond('p1', { action: 'missed', cardId: 'm' });
  assert(g.pending.playerId === 'p2', '다음 p2');
  g.respond('p2', { action: 'draw', source: 'barrel' });
  assert(P(g, 2).hp === 4 && g.pending.playerId === 'p3', '술통 회피, 다음 p3');
  g.respond('p3', { action: 'take' });
  assert(!P(g, 3).alive && g.pending && g.pending.playerId === 'p4', 'p3 탈락 후에도 p4로 이어짐');
  g.respond('p4', { action: 'take' });
  assert(!g.pending && P(g, 4).hp === 3, '끝');
  assert(P(g, 0).hand.length === 3, '무법자 제거 보상 3장');
});

test('인디언: 뱅!을 버리거나 피해. 캘러미티 자넷은 빗나감!도 가능', () => {
  const g = setup(4, [undefined, undefined, 'calamity_janet']);
  P(g, 0).hand = [card('ind', 'indians')];
  P(g, 1).hand = [card('b', 'bang')];
  P(g, 2).hand = [card('m', 'missed')];
  g.playCard('p0', 'ind');
  assert(g.pending.type === 'indians' && g.pending.playerId === 'p1', 'p1부터');
  g.respond('p1', { action: 'bang', cardId: 'b' });
  assert(P(g, 1).hp === 4 && g.pending.playerId === 'p2', '뱅 버려 회피');
  assert(g.pending.bangKinds.includes('missed'), '캘러미티: 빗나감 허용');
  g.respond('p2', { action: 'bang', cardId: 'm' });
  g.respond('p3', { action: 'take' });
  assert(!g.pending && P(g, 3).hp === 3, 'p3 피해');
});

test('주점/역마차/웰스 파고 은행', () => {
  const g = setup(4);
  P(g, 0).hp = 3; P(g, 1).hp = 2;
  P(g, 0).hand = [card('s', 'saloon'), card('st', 'stagecoach'), card('wf', 'wells_fargo')];
  g.playCard('p0', 's');
  assert(P(g, 0).hp === 4 && P(g, 1).hp === 3 && P(g, 2).hp === 4, '모두 +1 (최대 초과 없음)');
  g.playCard('p0', 'st');
  assert(P(g, 0).hand.length === 3, '역마차 +2');
  g.playCard('p0', 'wf');
  assert(P(g, 0).hand.length === 5, '웰스 파고 +3');
});

test('빗나감!은 차례에 직접 사용 불가, 파란 카드는 같은 이름 한 장만', () => {
  const g = setup(4);
  P(g, 0).hand = [card('m', 'missed'), card('b1', 'barrel'), card('b2', 'barrel')];
  assert(throws(() => g.playCard('p0', 'm')), '빗나감 직접 사용 불가');
  g.playCard('p0', 'b1');
  assert(throws(() => g.playCard('p0', 'b2')), '술통 두 장 불가');
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
