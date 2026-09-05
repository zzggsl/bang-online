// 간단한 봇 AI — 혼자서도 게임 흐름을 테스트할 수 있도록 하는 용도.
// 봇은 자기 직업만 알고, 공개 정보(누가 누구를 쐈는지)를 바탕으로 단순한 규칙으로 행동한다.
const { CARD_KINDS } = require('./game/cards');

const BOT_NAMES = ['봇 잭', '봇 빌', '봇 샘', '봇 톰', '봇 조', '봇 벤', '봇 로이', '봇 루크'];
const DODGE_CHANCE = 0.85; // 빗나감!이 있을 때 실제로 피할 확률

function attackersOf(game, targetId) {
  const counts = {};
  for (const a of game.attacks || []) if (a.targetId === targetId) counts[a.attackerId] = (counts[a.attackerId] || 0) + 1;
  return counts;
}

/** 공격 대상 선택 */
function chooseTarget(game, me, candidates) {
  if (!candidates.length) return null;
  const sheriff = game.players.find((p) => p.role === 'sheriff');
  const hitMe = attackersOf(game, me.id);
  const hitSheriff = attackersOf(game, sheriff.id);
  const alive = game.alivePlayers();

  const scored = candidates.map((p) => {
    let s = Math.random(); // 동점 시 랜덤
    switch (me.role) {
      case 'sheriff':
        s += (hitMe[p.id] || 0) * 3;
        break;
      case 'deputy':
        if (p.id === sheriff.id) return { p, s: -Infinity };
        s += (hitSheriff[p.id] || 0) * 3 + (hitMe[p.id] || 0) * 2;
        break;
      case 'outlaw':
        if (p.id === sheriff.id) s += 5;
        s += (hitMe[p.id] || 0) * 2;
        break;
      case 'renegade':
        // 마지막 둘이 남기 전까지는 보안관을 살려둔다
        if (p.id === sheriff.id && alive.length > 2) s -= 10;
        s += (hitMe[p.id] || 0) * 2;
        break;
      default:
        break;
    }
    return { p, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].s === -Infinity ? null : scored[0].p;
}

/** 카드 가치(높을수록 좋음) — 버릴 때는 낮은 것부터, 고를 때는 높은 것부터 */
function cardValue(card, me, game) {
  const k = CARD_KINDS[card.kind];
  if (!k.implemented) return 0;
  if (card.kind === 'beer') return me.hp < me.maxHp ? 6 : 1;
  if (k.type === 'weapon') return k.range > (game ? game.weaponRange(me) : 1) ? 5 : 1;
  if (k.type === 'passive') return me.passives.some((c) => c.kind === card.kind) ? 1 : 4;
  if (card.kind === 'bang') return 3;
  if (card.kind === 'missed') return 5;
  if (card.kind === 'jail' || card.kind === 'dynamite') return 2;
  if (['stagecoach', 'wells_fargo', 'panic', 'cat_balou', 'gatling', 'indians'].includes(card.kind)) return 4;
  return 2;
}

/** 봇이 "적"으로 여길 만한 대상 (뱅! 대상 선택과 같은 기준) */
function enemyTarget(game, me, candidates) {
  return chooseTarget(game, me, candidates);
}

function lowest(cards, me, game) {
  return [...cards].sort((a, b) => cardValue(a, me, game) - cardValue(b, me, game))[0];
}
function highest(cards, me, game) {
  return [...cards].sort((a, b) => cardValue(b, me, game) - cardValue(a, me, game))[0];
}

/** 대기 상황(pending)에 대한 봇의 한 가지 행동 */
function botPending(game, me) {
  const p = game.pending;
  switch (p.type) {
    case 'bang': {
      // 1) 카드 펼치기(주르도네/술통)가 남아 있으면 먼저 시도
      if (p.drawSources.length) return game.respond(me.id, { action: 'draw', source: p.drawSources[0] });
      // 2) 빗나감!
      const dodges = me.hand.filter((c) => p.missedKinds.includes(c.kind));
      const stillNeeded = p.needed - p.used;
      if (dodges.length >= stillNeeded && Math.random() < DODGE_CHANCE) {
        return game.respond(me.id, { action: 'missed', cardId: dodges[0].id });
      }
      return game.respond(me.id, { action: 'take' });
    }
    case 'dying': {
      const beer = me.hand.find((c) => c.kind === 'beer');
      if (beer) return game.respond(me.id, { action: 'beer', cardId: beer.id });
      return game.respond(me.id, { action: 'die' });
    }
    case 'dynamite':
      return game.resolveDynamite();
    case 'duel': {
      const bang = me.hand.find((c) => c.kind === 'bang') || (me.characterId === 'calamity_janet' ? me.hand.find((c) => c.kind === 'missed') : null);
      if (bang) return game.respond(me.id, { action: 'bang', cardId: bang.id });
      return game.respond(me.id, { action: 'take' });
    }
    case 'indians': {
      const bang = me.hand.find((c) => p.bangKinds.includes(c.kind));
      if (bang) return game.respond(me.id, { action: 'bang', cardId: bang.id });
      return game.respond(me.id, { action: 'take' });
    }
    case 'pick_card': {
      const t = game.getPlayer(p.targetId);
      const table = [...(t.weapon ? [t.weapon] : []), ...t.passives];
      // 훔칠 때: 내게 없는 좋은 카드 / 버리게 할 때: 상대에게 좋은 카드(무기·야생마·술통) 우선. 감옥·다이너마이트는 남기 앞에 둔 채로.
      const good = table.filter((c) => !['jail', 'dynamite'].includes(c.kind));
      if (good.length) return game.choose(me.id, { from: 'table', cardId: highest(good, me, game).id });
      if (p.handCount > 0) return game.choose(me.id, { from: 'hand' });
      return game.choose(me.id, { from: 'table', cardId: table[0].id });
    }
    case 'kit_carlson': {
      const sorted = [...p.cards].sort((a, b) => cardValue(b, me, game) - cardValue(a, me, game));
      return game.choose(me.id, { cardIds: sorted.slice(0, p.count).map((c) => c.id) });
    }
    case 'jesse_jones': {
      // 손패가 가장 많은 사람에게서 훔친다 (보안관/보안관 편이 아닌 쪽 선호는 생략)
      const victims = p.targetIds.map((id) => game.getPlayer(id)).filter((v) => v.alive && v.hand.length);
      if (!victims.length) return game.choose(me.id, { from: 'deck' });
      victims.sort((a, b) => b.hand.length - a.hand.length);
      return game.choose(me.id, { from: 'player', targetId: victims[0].id });
    }
    case 'lucky_duke': {
      const heart = p.cards.find((c) => c.suit === 'H');
      return game.choose(me.id, { cardId: (heart || p.cards[0]).id });
    }
    case 'claus_the_saint':
      return game.choose(me.id, { cardId: lowest(p.cards, me, game).id });
    case 'general_store':
      return game.choose(me.id, { cardId: highest(p.cards, me, game).id });
    default:
      return game.popPending();
  }
}

/**
 * 봇이 지금 해야 할 한 가지 행동을 계산해서 실행한다.
 * @returns {boolean} 무언가 했으면 true
 */
function botStep(game, botId) {
  if (game.winner) return false;
  const me = game.players.find((p) => p.id === botId);
  if (!me || !me.alive) return false;

  // 1) 응답/선택 대기
  if (game.pending) {
    if (game.pending.playerId !== botId) return false;
    botPending(game, me);
    return true;
  }
  if (!game.turn || game.turn.playerId !== botId) return false;

  // 2) 시드 케첨: 손패 4장 이상이고 다쳤으면 두 장 버려 회복
  if (me.characterId === 'sid_ketchum' && me.hp < me.maxHp && me.hand.length >= 4) {
    const sorted = [...me.hand].sort((a, b) => cardValue(a, me, game) - cardValue(b, me, game));
    game.useAbility(botId, { cardIds: [sorted[0].id, sorted[1].id] });
    return true;
  }

  // 3) 버리기 단계
  if (game.turn.step === 'discard') {
    game.discardCard(botId, lowest(me.hand, me, game).id);
    return true;
  }
  if (game.turn.step !== 'play') return false;

  // 4) 장착: 더 좋은 무기 / 미장착 패시브
  const curRange = game.weaponRange(me);
  for (const c of me.hand) {
    const k = CARD_KINDS[c.kind];
    if (!k.implemented) continue;
    if (k.type === 'weapon' && (k.range > curRange || (c.kind === 'volcanic' && !me.weapon))) {
      game.playCard(botId, c.id);
      return true;
    }
    if (k.type === 'passive' && c.kind !== 'jail' && !game.hasPassive(me, c.kind)) {
      game.playCard(botId, c.id);
      return true;
    }
  }

  // 5) 맥주
  const beer = me.hand.find((c) => c.kind === 'beer');
  if (beer && me.hp < me.maxHp && game.alivePlayers().length > 2) {
    game.playCard(botId, beer.id);
    return true;
  }

  // 5-1) 카드 뽑기 계열은 무조건
  const drawCard = me.hand.find((c) => c.kind === 'stagecoach' || c.kind === 'wells_fargo');
  if (drawCard) { game.playCard(botId, drawCard.id); return true; }
  // 5-2) 주점: 다쳤으면
  const saloon = me.hand.find((c) => c.kind === 'saloon');
  if (saloon && me.hp < me.maxHp) { game.playCard(botId, saloon.id); return true; }
  // 5-3) 다이너마이트: 체력이 3 이상일 때 불을 붙인다 (러시안 룰렛)
  const dyn = me.hand.find((c) => c.kind === 'dynamite');
  if (dyn && me.hp >= 3) { game.playCard(botId, dyn.id); return true; }
  // 5-4) 감옥: 적에게 (보안관도 가능)
  const jail = me.hand.find((c) => c.kind === 'jail');
  if (jail) {
    const cands = game.alivePlayers().filter((p) => p.id !== botId && !game.hasPassive(p, 'jail'));
    const t = enemyTarget(game, me, cands);
    if (t) { game.playCard(botId, jail.id, t.id); return true; }
  }
  // 5-5) 강탈!: 거리 1 안에서 카드가 있는 상대 (앞에 놓인 카드가 있으면 그쪽)
  const panic = me.hand.find((c) => c.kind === 'panic');
  if (panic) {
    const cands = game.alivePlayers().filter((p) => p.id !== botId && game.distance(botId, p.id) <= 1 && (p.hand.length || p.weapon || p.passives.length));
    const t = enemyTarget(game, me, cands);
    if (t) { game.playCard(botId, panic.id, t.id); return true; }
  }
  // 5-6) 캣 벌로우: 앞에 카드가 있는 적 우선, 없으면 손패 많은 적
  const cat = me.hand.find((c) => c.kind === 'cat_balou');
  if (cat) {
    const withTable = game.alivePlayers().filter((p) => p.id !== botId && (p.weapon || p.passives.some((c) => !['jail', 'dynamite'].includes(c.kind))));
    const withHand = game.alivePlayers().filter((p) => p.id !== botId && p.hand.length);
    const t = enemyTarget(game, me, withTable.length ? withTable : withHand);
    if (t) { game.playCard(botId, cat.id, t.id); return true; }
  }
  // 5-7) 기관총 / 인디언: 살아있는 사람이 3명 이상일 때
  const aoe = me.hand.find((c) => c.kind === 'gatling' || c.kind === 'indians');
  if (aoe && game.alivePlayers().length >= 3) { game.playCard(botId, aoe.id); return true; }
  // 5-8) 결투: 뱅!이 2장 이상일 때 적에게
  const duel = me.hand.find((c) => c.kind === 'duel');
  if (duel && me.hand.filter((c) => c.kind === 'bang').length >= 2) {
    const t = enemyTarget(game, me, game.alivePlayers().filter((p) => p.id !== botId));
    if (t) { game.playCard(botId, duel.id, t.id); return true; }
  }

  // 6) 잡화점 (카드 / 엉클 윌)
  const store = me.hand.find((c) => c.kind === 'general_store');
  if (store) {
    game.playCard(botId, store.id);
    return true;
  }
  if (me.characterId === 'uncle_will' && !game.turn.abilityUsed) {
    const junk = me.hand.find((c) => cardValue(c, me, game) <= 1);
    if (junk) {
      game.playCard(botId, junk.id, null, { as: 'general_store' });
      return true;
    }
  }

  // 7) 뱅!
  const bang = me.hand.find((c) => c.kind === 'bang');
  if (game.canPlayBang(me) && bang) {
    const range = game.weaponRange(me);
    const candidates = game.alivePlayers().filter((p) => p.id !== botId && game.distance(botId, p.id) <= range);
    const target = chooseTarget(game, me, candidates);
    if (target) {
      game.playCard(botId, bang.id, target.id);
      return true;
    }
  }

  // 8) 턴 종료 (버릴 카드가 있으면 discard 단계로 넘어감)
  game.endTurn(botId);
  return true;
}

module.exports = { botStep, botPending, lowest, BOT_NAMES };
