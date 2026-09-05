// 인원 수에 따른 직업 배치 (기본판)
// 4인은 규칙상 최소 인원으로 포함해 둠 — 필요 없으면 MIN_PLAYERS를 5로 올리면 된다.
const ROLE_TABLE = {
  4: { sheriff: 1, deputy: 0, outlaw: 2, renegade: 1 },
  5: { sheriff: 1, deputy: 1, outlaw: 2, renegade: 1 },
  6: { sheriff: 1, deputy: 1, outlaw: 3, renegade: 1 },
  7: { sheriff: 1, deputy: 2, outlaw: 3, renegade: 1 },
  8: { sheriff: 1, deputy: 2, outlaw: 3, renegade: 2 },
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

const ROLE_INFO = {
  sheriff: { name: '보안관', goal: '무법자 모두와 배신자를 사살하라!', color: '#c9a227' },
  deputy: { name: '부관', goal: '보안관을 보호하라! 무법자 모두와 배신자를 사살하라!', color: '#4d8bd6' },
  outlaw: { name: '무법자', goal: '보안관을 사살하라!', color: '#c0392b' },
  renegade: { name: '배신자', goal: '게임이 끝날 때까지 혼자 살아남아라!', color: '#7d5ba6' },
};

function buildRoleDeck(count) {
  const table = ROLE_TABLE[count];
  if (!table) throw new Error(`지원하지 않는 인원 수: ${count}`);
  const deck = [];
  for (const [role, n] of Object.entries(table)) {
    for (let i = 0; i < n; i++) deck.push(role);
  }
  return deck;
}

module.exports = { ROLE_TABLE, ROLE_INFO, MIN_PLAYERS, MAX_PLAYERS, buildRoleDeck };
