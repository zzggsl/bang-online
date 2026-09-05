// 플레이어별 뷰 생성 — 숨겨진 정보(다른 사람의 손패·직업)는 절대 내려보내지 않는다.
const { ROLE_INFO } = require('./roles');
const { getCharacter } = require('./characters');
const { describeCard } = require('./cards');

/**
 * @param {import('./engine').Game} game
 * @param {string|null} viewerId  게임 참가자 id, 관전자면 null
 */
function buildView(game, viewerId) {
  const viewer = viewerId ? game.players.find((p) => p.id === viewerId) : null;

  const players = game.players.map((p) => {
    const isMe = viewer && p.id === viewer.id;
    const showRole = p.revealed || isMe || !!game.winner;
    const ch = getCharacter(p.characterId);
    return {
      id: p.id,
      nickname: p.nickname,
      seat: p.seat,
      alive: p.alive,
      hp: p.hp,
      maxHp: p.maxHp,
      character: { id: ch.id, name: ch.name, hp: ch.hp, ability: ch.ability },
      role: showRole ? p.role : null,
      roleName: showRole ? ROLE_INFO[p.role].name : null,
      handCount: p.hand.length,
      hand: isMe ? p.hand.map(describeCard) : null,
      weapon: p.weapon ? describeCard(p.weapon) : null,
      passives: p.passives.map(describeCard),
      range: p.weapon ? (describeCard(p.weapon).range || 1) : 1,
      isMe: !!isMe,
    };
  });

  const pend = game.pending;
  const myTurn = !!(viewer && game.turn && game.turn.playerId === viewer.id);
  const me = viewer
    ? {
        id: viewer.id,
        role: viewer.role,
        roleName: ROLE_INFO[viewer.role].name,
        roleGoal: ROLE_INFO[viewer.role].goal,
        alive: viewer.alive,
        distances: viewer.alive ? game.distancesFrom(viewer.id) : {},
        canPlayBang: viewer.alive && myTurn && game.canPlayBang(viewer),
        // 시드 케첨: 언제든지 (죽어가는 중 제외)
        canSidKetchum:
          viewer.alive &&
          viewer.characterId === 'sid_ketchum' &&
          viewer.hp < viewer.maxHp &&
          viewer.hand.length >= 2 &&
          !(pend && pend.type === 'dying' && pend.playerId === viewer.id) &&
          !game.winner,
        // 엉클 윌: 자기 차례 play 단계, 턴당 한 번
        canUncleWill:
          viewer.alive && myTurn && game.turn.step === 'play' && !pend &&
          viewer.characterId === 'uncle_will' && !game.turn.abilityUsed && viewer.hand.length > 0,
      }
    : null;

  let pending = null;
  if (pend) {
    const isMine = viewer ? pend.playerId === viewer.id : false;
    pending = { id: pend.id, type: pend.type, playerId: pend.playerId, isMine, auto: !!pend.auto };
    switch (pend.type) {
      case 'bang':
        Object.assign(pending, {
          subtype: pend.subtype || 'bang',
          attackerId: pend.attackerId,
          targetId: pend.targetId,
          missedKinds: pend.missedKinds,
          needed: pend.needed,
          used: pend.used,
          drawSources: pend.drawSources,
        });
        break;
      case 'dying':
        Object.assign(pending, { sourceId: pend.sourceId, needed: pend.needed });
        break;
      case 'dynamite':
        Object.assign(pending, { auto: true, hops: pend.hops });
        break;
      case 'duel':
        Object.assign(pending, { challengerId: pend.challengerId, targetId: pend.targetId, round: pend.round });
        break;
      case 'indians':
        Object.assign(pending, { attackerId: pend.attackerId, bangKinds: pend.bangKinds });
        break;
      case 'pick_card': {
        const t = game.players.find((x) => x.id === pend.targetId);
        Object.assign(pending, {
          targetId: pend.targetId,
          mode: pend.mode,
          cardName: pend.cardName,
          handCount: pend.handCount,
          tableCards: [...(t.weapon ? [t.weapon] : []), ...t.passives].map(describeCard),
        });
        break;
      }
      case 'kit_carlson':
        Object.assign(pending, { count: pend.count, cards: isMine ? pend.cards.map(describeCard) : null, cardCount: pend.cards.length });
        break;
      case 'jesse_jones':
        Object.assign(pending, { targetIds: pend.targetIds });
        break;
      case 'lucky_duke':
        Object.assign(pending, { label: pend.label, cards: pend.cards.map(describeCard) }); // 펼친 카드는 공개
        break;
      case 'claus_the_saint':
        Object.assign(pending, {
          cards: isMine ? pend.cards.map(describeCard) : null,
          cardCount: pend.cards.length,
          recipientId: pend.recipientIds[pend.index] || null,
          remaining: pend.recipientIds.length - pend.index,
        });
        break;
      case 'general_store':
        Object.assign(pending, { cards: pend.cards.map(describeCard), orderIds: pend.orderIds, index: pend.index });
        break;
      default:
        break;
    }
  }

  return {
    players,
    me,
    turn: game.turn
      ? {
          playerId: game.turn.playerId,
          step: game.turn.step,
          bangsPlayed: game.turn.bangsPlayed,
          number: game.turn.number,
          abilityUsed: game.turn.abilityUsed,
          isMine: myTurn,
        }
      : null,
    pending,
    reveal: game.reveal && (!game.turn || game.reveal.turn === game.turn.number)
      ? { label: game.reveal.label, cards: game.reveal.cards.map(describeCard), at: game.reveal.at }
      : null,
    deckCount: game.deck.length,
    discardCount: game.discard.length,
    discardTop: game.discard.length ? describeCard(game.discard[game.discard.length - 1]) : null,
    log: game.log.slice(-80),
    winner: game.winner,
  };
}

module.exports = { buildView };
