// 캐릭터 능력 단위 테스트 — 엔진을 직접 조작해 각 능력이 스펙대로 동작하는지 확인한다.
// 실행: node test/characters.js
const { Game } = require('../server/game/engine');

let passed = 0;
function assert(c, m) { if (!c) throw new Error('ASSERT: ' + m); }
function test(name, fn) {
  try { fn(); passed++; console.log('  ✔', name); } catch (e) { console.error('  ✘', name, '—', e.message); process.exitCode = 1; }
}
const card = (id, kind, suit = 'S', rank = '7') => ({ id, kind, suit, rank });

/** n명 게임을 만들고, 지정한 캐릭터를 자리 순서대로 배치한다. 보안관은 0번. */
function setup(n, chars, opts = {}) {
  const seats = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nickname: `P${i}` }));
  const g = new Game(seats);
  // 직업/캐릭터를 고정하고 턴을 다시 시작한다
  const roles = opts.roles || ['sheriff', ...Array(n - 1).fill('outlaw')];
  g.players.forEach((p, i) => {
    p.role = roles[i];
    p.revealed = roles[i] === 'sheriff';
    p.characterId = chars[i] || 'willy_the_kid';
    p.maxHp = 4 + (p.role === 'sheriff' ? 1 : 0);
    p.hp = p.maxHp;
    p.hand = [];
    p.weapon = null;
    p.passives = [];
  });
  g.pending = null;
  g.deck = g.deck.concat(g.discard);
  g.discard = [];
  g.turn = { playerId: 'p0', step: 'play', bangsPlayed: 0, number: 1, abilityUsed: false };
  return g;
}
const P = (g, i) => g.players[i];

console.log('캐릭터 능력 테스트');

test('윌리 더 키드: 뱅! 여러 장', () => {
  const g = setup(4, ['willy_the_kid']);
  P(g, 0).hand = [card('b1', 'bang'), card('b2', 'bang')];
  g.playCard('p0', 'b1', 'p1'); g.respond('p1', { action: 'take' });
  g.playCard('p0', 'b2', 'p1'); g.respond('p1', { action: 'take' });
  assert(P(g, 1).hp === 2, '두 번 맞아야 함');
});

test('캘러미티 자넷: 빗나감!을 뱅!으로 (뱅 횟수 소모), 뱅!을 빗나감!으로', () => {
  const g = setup(4, ['calamity_janet', 'calamity_janet']);
  P(g, 0).hand = [card('m1', 'missed'), card('b1', 'bang')];
  P(g, 1).hand = [card('b2', 'bang')];
  g.playCard('p0', 'm1', 'p1');
  assert(g.pending && g.pending.type === 'bang', '뱅 대기가 생겨야 함');
  g.respond('p1', { action: 'missed', cardId: 'b2' }); // 뱅!으로 피함
  assert(!g.pending && P(g, 1).hp === 4, '뱅!으로 피할 수 있어야 함');
  let err = null; try { g.playCard('p0', 'b1', 'p1'); } catch (e) { err = e; }
  assert(err, '빗나감!을 뱅!으로 쓴 뒤 다른 뱅!은 막혀야 함');
});

test('키트 칼슨: 세 장 중 두 장 선택, 나머지는 더미 맨 위로', () => {
  const g = setup(4, ['willy_the_kid', 'kit_carlson']);
  g.deck.push(card('x1', 'beer', 'H'), card('x2', 'bang'), card('x3', 'missed'));
  P(g, 0).hand = []; g.endTurn('p0'); g.manualDraw('p1');
  assert(g.pending && g.pending.type === 'kit_carlson' && g.pending.playerId === 'p1', '키트 선택 대기');
  assert(g.pending.cards.map((c) => c.id).sort().join() === 'x1,x2,x3', '맨 위 세 장이어야 함');
  g.choose('p1', { cardIds: ['x1', 'x3'] });
  assert(P(g, 1).hand.map((c) => c.id).join() === 'x1,x3', '고른 두 장이 손에');
  assert(g.deck[g.deck.length - 1].id === 'x2', '남은 한 장은 더미 맨 위');
  assert(g.turn.step === 'play', '선택 후 카드 사용 단계');
});

test('바트 캐시디: 체력 잃을 때 카드 한 장', () => {
  const g = setup(4, ['willy_the_kid', 'bart_cassidy']);
  P(g, 0).hand = [card('b1', 'bang')];
  g.playCard('p0', 'b1', 'p1'); g.respond('p1', { action: 'take' });
  assert(P(g, 1).hand.length === 1, '한 장 받아야 함');
});

test('시드 케첨: 카드 두 장 버리고 체력 1 회복 (최대 초과 불가)', () => {
  const g = setup(4, ['sid_ketchum']);
  P(g, 0).hp = 3; P(g, 0).hand = [card('a', 'bang'), card('b', 'bang'), card('c', 'bang')];
  g.useAbility('p0', { cardIds: ['a', 'b'] });
  assert(P(g, 0).hp === 4 && P(g, 0).hand.length === 1, '회복 + 두 장 버림');
  g.endTurn('p0'); // 다른 사람 차례에도 사용 가능
  P(g, 0).hp = 3; P(g, 0).hand = [card('d', 'bang'), card('e', 'bang')];
  g.useAbility('p0', { cardIds: ['d', 'e'] });
  assert(P(g, 0).hp === 4, '남의 차례에도 사용 가능');
  let err = null; try { g.useAbility('p0', { cardIds: [] }); } catch (e) { err = e; }
  assert(err, '최대 체력이면 불가');
});

test('주르도네: 총알 표적이 되면 카드 펼치기, 하트면 회피', () => {
  const g = setup(4, ['willy_the_kid', 'jourdonnais']);
  P(g, 0).hand = [card('b1', 'bang'), card('b2', 'bang')];
  g.deck.push(card('h', 'beer', 'H'));
  g.playCard('p0', 'b1', 'p1');
  assert(g.pending.drawSources.includes('jourdonnais'), '펼치기 수단이 있어야 함');
  g.respond('p1', { action: 'draw' });
  assert(!g.pending && P(g, 1).hp === 4, '하트 → 회피');
  g.deck.push(card('s', 'bang', 'S'));
  g.playCard('p0', 'b2', 'p1');
  g.respond('p1', { action: 'draw' });
  assert(g.pending && g.pending.drawSources.length === 0, '실패하면 더 못 펼침');
  g.respond('p1', { action: 'take' });
  assert(P(g, 1).hp === 3, '피해');
});

test('럭키 듀크: 카드 펼치기 때 두 장 중 선택', () => {
  const g = setup(4, ['willy_the_kid', 'lucky_duke']);
  // 럭키 듀크 본인이 펼치는 상황: 술통 대신 주르도네 능력을 빌려 시험 (drawCheck 직접 호출)
  g.deck.push(card('s', 'bang', 'S'), card('h', 'beer', 'H'));
  let got = null;
  g.drawCheck(P(g, 1), '테스트', (c) => { got = c; });
  assert(g.pending && g.pending.type === 'lucky_duke' && g.pending.cards.length === 2, '두 장 선택 대기');
  g.choose('p1', { cardId: 'h' });
  assert(got && got.id === 'h', '고른 카드로 판정');
  assert(g.discard.some((c) => c.id === 's') && g.discard.some((c) => c.id === 'h'), '둘 다 버림');
});

test('블랙 잭: 두 번째 카드 공개, 빨간색이면 한 장 더', () => {
  const g = setup(4, ['willy_the_kid', 'black_jack']);
  g.deck.push(card('c3', 'bang', 'C'), card('c2', 'bang', 'D'), card('c1', 'bang', 'S'));
  P(g, 0).hand = []; g.endTurn('p0'); g.manualDraw('p1');
  assert(P(g, 1).hand.length === 3, '다이아 → 세 장');
  assert(g.reveal && g.reveal.cards[0].id === 'c2', '두 번째 카드 공개');
});

test('벌쳐 샘: 탈락자의 카드를 모두 가져감', () => {
  const g = setup(4, ['willy_the_kid', 'vulture_sam', 'willy_the_kid']);
  P(g, 2).hp = 1; P(g, 2).hand = [card('x', 'bang')]; P(g, 2).weapon = card('w', 'schofield'); P(g, 2).passives = [card('m', 'mustang')];
  P(g, 0).hand = [card('b1', 'bang')];
  P(g, 0).weapon = card('w0', 'winchester');
  g.playCard('p0', 'b1', 'p2'); g.respond('p2', { action: 'take' });
  assert(!P(g, 2).alive, '탈락');
  assert(P(g, 1).hand.map((c) => c.id).sort().join() === 'm,w,x', '벌쳐 샘이 3장 모두');
});

test('제시 존스: 첫 카드를 남의 손에서', () => {
  const g = setup(4, ['willy_the_kid', 'jesse_jones']);
  P(g, 2).hand = [card('v', 'beer', 'H')];
  P(g, 0).hand = []; g.endTurn('p0'); g.manualDraw('p1');
  assert(g.pending.type === 'jesse_jones' && g.pending.targetIds.join() === 'p2', '손패 있는 사람만 대상');
  g.choose('p1', { from: 'player', targetId: 'p2' });
  assert(P(g, 2).hand.length === 0 && P(g, 1).hand.some((c) => c.id === 'v') && P(g, 1).hand.length === 2, '한 장 훔치고 한 장 더미');
});

test('수지 라파예트: 손이 비면 즉시 한 장', () => {
  const g = setup(4, ['suzy_lafayette']);
  P(g, 0).hand = [card('b1', 'bang')];
  g.playCard('p0', 'b1', 'p1');
  assert(P(g, 0).hand.length === 1, '뱅 쓴 직후 한 장 보충');
});

test('슬랩 더 킬러: 빗나감! 두 장 필요', () => {
  const g = setup(4, ['slab_the_killer']);
  P(g, 0).hand = [card('b1', 'bang')];
  P(g, 1).hand = [card('m1', 'missed'), card('m2', 'missed')];
  g.playCard('p0', 'b1', 'p1');
  assert(g.pending.needed === 2, '2장 필요');
  g.respond('p1', { action: 'missed', cardId: 'm1' });
  assert(g.pending && g.pending.used === 1, '아직 대기');
  g.respond('p1', { action: 'missed', cardId: 'm2' });
  assert(!g.pending && P(g, 1).hp === 4, '두 장으로 회피');
});

test('로즈 둘란: 본인 기준 거리 1 감소', () => {
  const g = setup(5, ['rose_doolan']);
  assert(g.distance('p0', 'p2') === 1, '2칸 → 1칸');
  assert(g.distance('p2', 'p0') === 2, '상대 기준은 그대로');
});

test('엘 그링고: 맞으면 공격자 손에서 한 장', () => {
  const g = setup(4, ['willy_the_kid', 'el_gringo']);
  P(g, 0).hand = [card('b1', 'bang'), card('k', 'beer', 'H')];
  g.playCard('p0', 'b1', 'p1'); g.respond('p1', { action: 'take' });
  assert(P(g, 0).hand.length === 0 && P(g, 1).hand.some((c) => c.id === 'k'), '공격자 손에서 가져옴');
});

test('엉클 윌: 아무 카드를 잡화점으로 (턴당 1회)', () => {
  const g = setup(4, ['uncle_will']);
  P(g, 0).hand = [card('j', 'jail'), card('j2', 'jail')];
  g.playCard('p0', 'j', null, { as: 'general_store' });
  assert(g.pending.type === 'general_store' && g.pending.cards.length === 4, '4장 펼침');
  assert(g.pending.playerId === 'p0', '본인부터');
  g.choose('p0', { cardId: g.pending.cards[0].id });
  g.choose('p1', { cardId: g.pending.cards[0].id });
  g.choose('p2', { cardId: g.pending.cards[0].id });
  assert(!g.pending, '마지막 사람은 자동으로 받고 종료');
  assert(P(g, 3).hand.length === 1 && P(g, 0).hand.length === 2, '모두 한 장씩');
  let err = null; try { g.playCard('p0', 'j2', null, { as: 'general_store' }); } catch (e) { err = e; }
  assert(err, '턴당 한 번');
});

test('클라우스: (인원+1)장 뽑아 남에게 한 장씩, 본인 두 장', () => {
  const g = setup(5, ['willy_the_kid', 'claus_the_saint']);
  P(g, 0).hand = []; g.endTurn('p0'); g.manualDraw('p1');
  assert(g.pending.type === 'claus_the_saint' && g.pending.cards.length === 6, '6장');
  assert(g.pending.recipientIds.join() === 'p2,p3,p4,p0', '차례 순서대로 나눔');
  while (g.pending && g.pending.type === 'claus_the_saint') g.choose('p1', { cardId: g.pending.cards[0].id });
  assert(P(g, 1).hand.length === 2, '본인 두 장');
  assert([2, 3, 4, 0].every((i) => P(g, i).hand.length === 1), '각자 한 장');
  assert(g.turn.step === 'play', '카드 사용 단계로');
});

test('쓰러지기 직전 맥주로 생존', () => {
  const g = setup(4, ['willy_the_kid']);
  P(g, 1).hp = 1; P(g, 1).hand = [card('beer', 'beer', 'H')];
  P(g, 0).hand = [card('b1', 'bang')];
  g.playCard('p0', 'b1', 'p1'); g.respond('p1', { action: 'take' });
  assert(g.pending && g.pending.type === 'dying', '죽어가는 중 대기');
  g.respond('p1', { action: 'beer', cardId: 'beer' });
  assert(P(g, 1).alive && P(g, 1).hp === 1 && !g.pending, '생존');
});

console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
