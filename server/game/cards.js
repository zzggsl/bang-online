// 기본판 게임 카드 80장 (사용자 스펙 기준, 공식 한글판 명칭).
// 파란색 테두리(table) 17장: 앞에 내려놓고 계속 효과 / 갈색 테두리(action) 63장: 즉시 효과 후 버림

// type:   'action' 갈색 / 'weapon' 무기(파란색, 한 장만) / 'passive' 파란색 비무기(이름당 한 장)
// target: 'none' 대상 없음 / 'other' 다른 플레이어(사거리 필요) / 'other-any' 다른 플레이어(거리 무관)
//         'any' 자기 자신 포함 아무 플레이어(거리 무관) / 'any-range' 자기 자신 포함(사거리 필요)
const CARD_KINDS = {
  // ---------- 파란색 테두리 ----------
  barrel: { name: '술통', en: 'Barrel', type: 'passive', target: 'none', desc: '공격을 받으면 "카드 펼치기!"를 할 수 있습니다. 하트가 나오면 공격을 피합니다.', implemented: true },
  dynamite: { name: '다이너마이트', en: 'Dynamite', type: 'action', target: 'none', desc: '사용한 사람부터 차례로 카드를 펼칩니다. 스페이드 2~9가 나오면 그 사람이 생명력 2를 잃고, 아니면 다음 사람에게 넘어갑니다. 터질 때까지 계속 돕니다.', implemented: true },
  jail: { name: '감옥', en: 'Jail', type: 'passive', target: 'any', desc: '차례를 시작하기 전에 카드를 펼쳐, 차례를 정상적으로 진행할 것인지 건너뛸 것인지를 결정합니다.', implemented: true },
  mustang: { name: '야생마', en: 'Mustang', type: 'passive', target: 'none', desc: '다른 사람이 볼 때 거리 1이 멀어집니다.', implemented: true },
  scope: { name: '조준경', en: 'Scope', type: 'passive', target: 'none', desc: '다른 사람을 볼 때 거리 1이 가까워집니다.', implemented: true },
  remington: { name: '레밍턴', en: 'Remington', type: 'weapon', range: 3, target: 'none', desc: '자신의 사정거리가 3이 된다.', implemented: true },
  rev_carabine: { name: '카빈', en: 'Rev. Carabine', type: 'weapon', range: 4, target: 'none', desc: '자신의 사정거리가 4가 된다.', implemented: true },
  schofield: { name: '스코필드', en: 'Schofield', type: 'weapon', range: 2, target: 'none', desc: '자신의 사정거리가 2가 된다.', implemented: true },
  volcanic: { name: '볼캐닉', en: 'Volcanic', type: 'weapon', range: 1, target: 'none', desc: '<뱅!>을 원하는 만큼 사용할 수 있습니다.', implemented: true },
  winchester: { name: '윈체스터', en: 'Winchester', type: 'weapon', range: 5, target: 'none', desc: '자신의 사정거리가 5가 된다.', implemented: true },
  // ---------- 갈색 테두리 ----------
  bang: { name: '뱅!', en: 'Bang!', type: 'action', target: 'other', desc: '사정거리 내의 1명을 공격한다.', implemented: true },
  beer: { name: '맥주', en: 'Beer', type: 'action', target: 'none', desc: '자신의 생명력을 1 회복한다.', implemented: true },
  cat_balou: { name: '캣 벌로우', en: 'Cat Balou', type: 'action', target: 'other-any', desc: '거리 제한 없이 아무 플레이어 1명의 카드 하나를 제거한다.', implemented: true },
  duel: { name: '결투', en: 'Duel', type: 'action', target: 'other-any', desc: '표적이 된 사람과 결투를 신청한 사람이 번갈아 <뱅!>을 냅니다. 먼저 <뱅!>을 낼 수 없게 된 사람이 생명력 1을 잃습니다.', implemented: true },
  gatling: { name: '기관총', en: 'Gatling', type: 'action', target: 'none', desc: '기관총을 난사하여 자신을 제외한 모든 플레이어를 공격한다.', implemented: true },
  general_store: { name: '잡화점', en: 'General Store', type: 'action', target: 'none', desc: '인원만큼 카드를 펼친 다음, 이 카드를 사용한 사람부터 시계방향으로 원하는 카드를 한 장씩 가져간다.', implemented: true },
  indians: { name: '인디언', en: 'Indians!', type: 'action', target: 'none', desc: '다른 모든 사람들이 <뱅!> 한 장을 버릴 수 있으며, 그러지 않으면 생명력 1을 잃습니다.', implemented: true },
  missed: { name: '빗나감!', en: 'Missed!', type: 'action', target: 'none', desc: '<뱅!> 및 그와 같은 효과의 공격을 피한다. 공격을 받았을 때만 사용할 수 있다.', implemented: true, responseOnly: true },
  panic: { name: '강탈!', en: 'Panic!', type: 'action', target: 'any-range', desc: '거리 1인 상대의 카드를 하나 빼앗아 손으로 가져온다.', implemented: true, fixedRange: 1 },
  saloon: { name: '주점', en: 'Saloon', type: 'action', target: 'none', desc: '모든 플레이어들의 생명력을 1 회복한다.', implemented: true },
  stagecoach: { name: '역마차', en: 'Stagecoach', type: 'action', target: 'none', desc: '즉시 카드 더미 맨 위에서 카드 두 장을 가져온다.', implemented: true },
  wells_fargo: { name: '웰스 파고 은행', en: 'Wells Fargo', type: 'action', target: 'none', desc: '즉시 카드 더미 맨 위에서 카드 세 장을 가져온다.', implemented: true },
};

// 덱 구성: [kind, suit, rank] — suit: S(♠) H(♥) D(♦) C(♣), rank: 'A','2'..'10','J','Q','K'
const R = (from, to) => {
  const order = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const i = order.indexOf(from);
  const j = order.indexOf(to, i);
  return order.slice(i, j + 1);
};
const DECK_SPEC = [
  // ----- 파란색 17장 -----
  ['barrel', 'S', 'Q'], ['barrel', 'S', 'K'],
  ['dynamite', 'H', '2'],
  ['jail', 'H', '4'], ['jail', 'S', '10'], ['jail', 'S', 'J'],
  ['mustang', 'H', '8'], ['mustang', 'H', '9'],
  ['scope', 'S', 'A'],
  ['remington', 'C', 'K'],
  ['rev_carabine', 'C', 'A'],
  ['schofield', 'C', 'J'], ['schofield', 'C', 'Q'], ['schofield', 'S', 'K'],
  ['volcanic', 'C', '10'], ['volcanic', 'S', '10'],
  ['winchester', 'S', '8'],
  // ----- 갈색 63장 -----
  // 뱅! 25장: 하트 Q~A, 다이아 2~A, 클로버 2~9, 스페이드 A
  ...R('Q', 'A').map((r) => ['bang', 'H', r]),
  ...R('2', 'A').map((r) => ['bang', 'D', r]),
  ...R('2', '9').map((r) => ['bang', 'C', r]),
  ['bang', 'S', 'A'],
  // 맥주 6장: 하트 6~J
  ...R('6', 'J').map((r) => ['beer', 'H', r]),
  // 캣 벌로우 4장: 다이아 9~J, 하트 K
  ...R('9', 'J').map((r) => ['cat_balou', 'D', r]), ['cat_balou', 'H', 'K'],
  // 결투 3장
  ['duel', 'D', 'Q'], ['duel', 'C', '8'], ['duel', 'S', 'J'],
  // 기관총 1장
  ['gatling', 'H', '10'],
  // 잡화점 2장
  ['general_store', 'C', '9'], ['general_store', 'S', 'Q'],
  // 인디언 2장
  ['indians', 'D', 'K'], ['indians', 'D', 'A'],
  // 빗나감! 12장: 스페이드 2~8, 클로버 10~A
  ...R('2', '8').map((r) => ['missed', 'S', r]),
  ...R('10', 'A').map((r) => ['missed', 'C', r]),
  // 강탈! 4장: 다이아 8, 하트 J~Q, 하트 A
  ['panic', 'D', '8'], ['panic', 'H', 'J'], ['panic', 'H', 'Q'], ['panic', 'H', 'A'],
  // 주점 1장
  ['saloon', 'H', '5'],
  // 역마차 2장
  ['stagecoach', 'S', '9'], ['stagecoach', 'S', '9'],
  // 웰스 파고 은행 1장
  ['wells_fargo', 'H', '3'],
];

if (DECK_SPEC.length !== 80) {
  throw new Error(`덱 카드 수가 80장이 아닙니다: ${DECK_SPEC.length}`);
}
{
  // 다이너마이트는 이 게임에서 즉시 발동 카드로 바꿨으므로(사용자 규칙) 파란색 16장 + 다이너마이트 1장
  const blue = DECK_SPEC.filter(([k]) => CARD_KINDS[k].type !== 'action').length;
  if (blue !== 16) throw new Error(`파란색 테두리 카드 수가 16장이 아닙니다: ${blue}`);
}

function buildDeck() {
  return DECK_SPEC.map(([kind, suit, rank], i) => ({
    id: `c${i + 1}`,
    kind,
    suit,
    rank,
  }));
}

// 클라이언트에 보낼 카드 정보(정의 포함)
function describeCard(card) {
  const k = CARD_KINDS[card.kind];
  return {
    id: card.id,
    kind: card.kind,
    suit: card.suit,
    rank: card.rank,
    name: k.name,
    en: k.en,
    type: k.type,
    range: k.range || null,
    target: k.target,
    desc: k.desc,
    implemented: !!k.implemented,
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { CARD_KINDS, buildDeck, describeCard, shuffle };
