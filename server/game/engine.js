// Bang! 게임 엔진 — 서버 권위(authoritative) 상태 관리.
// 클라이언트는 여기서 만들어진 결과를 view.js를 통해 "자기가 볼 수 있는 만큼만" 받는다.
//
// pending(대기 상황)은 스택으로 관리한다. 예: 뱅! 응답 대기 중에 주르도네가 "카드 펼치기"를 하고
// 그가 럭키 듀크라면(불가능하지만 구조상) 그 위에 "두 장 중 선택"이 쌓이는 식이다.
// 각 pending에는 반드시 playerId(지금 행동해야 하는 사람)가 있다.
const { buildRoleDeck, ROLE_INFO } = require('./roles');
const { CHARACTERS, getCharacter } = require('./characters');
const { CARD_KINDS, buildDeck, shuffle } = require('./cards');

class GameError extends Error {}

const SUIT_NAME = { S: '♠', H: '♥', D: '♦', C: '♣' };
function cardLabel(card) {
  return `${CARD_KINDS[card.kind].name} ${card.rank}${SUIT_NAME[card.suit]}`;
}

class Game {
  /**
   * @param {Array<{id:string, nickname:string}>} seatedPlayers 자리 순서대로(원형)
   */
  constructor(seatedPlayers, options = {}) {
    if (seatedPlayers.length < 4 || seatedPlayers.length > 8) {
      throw new GameError('게임은 4~8명이 필요합니다.');
    }
    this.id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.log = [];
    this.winner = null;
    this.pending = null;
    this.attacks = []; // 공개 정보: 누가 누구를 쐈는지 (봇 판단용)
    this.reveal = null; // 테이블 가운데에 잠시 보여주는 공개 카드 { label, cards, turn }
    this.deck = shuffle(buildDeck());
    this.discard = [];

    const roles = shuffle(buildRoleDeck(seatedPlayers.length));
    const chars = shuffle([...CHARACTERS]).slice(0, seatedPlayers.length);
    // 테스트용: 특정 플레이어의 캐릭터 고정 (options.forceCharacters = { playerId: characterId })
    for (const [pid, cid] of Object.entries(options.forceCharacters || {})) {
      const i = seatedPlayers.findIndex((p) => p.id === pid);
      const ch = CHARACTERS.find((c) => c.id === cid);
      if (i === -1 || !ch) continue;
      const j = chars.findIndex((c) => c.id === cid);
      if (j === -1) chars[i] = ch; // 이번 판에 없는 캐릭터면 그냥 배정
      else [chars[i], chars[j]] = [chars[j], chars[i]]; // 있으면 자리 교환
    }

    this.players = seatedPlayers.map((p, i) => {
      const role = roles[i];
      const ch = chars[i];
      const maxHp = ch.hp + (role === 'sheriff' ? 1 : 0);
      return {
        id: p.id,
        nickname: p.nickname,
        seat: i,
        role,
        characterId: ch.id,
        maxHp,
        hp: maxHp,
        hand: [],
        weapon: null,
        passives: [],
        alive: true,
        revealed: role === 'sheriff',
      };
    });

    // 초기 손패: 체력 수만큼
    for (const p of this.players) {
      for (let i = 0; i < p.hp; i++) this.drawCardTo(p);
    }

    const sheriff = this.players.find((p) => p.role === 'sheriff');
    this.turn = null;
    this.addLog(`게임이 시작되었습니다. 보안관은 ${sheriff.nickname}입니다.`, 'system');
    this.startTurn(sheriff.id);
  }

  // ---------- 유틸 ----------
  /**
   * @param {object} [meta] 시각 효과용 부가 정보 { actor, target, card, kind }
   */
  addLog(text, type = 'info', meta = null) {
    this.logSeq = (this.logSeq || 0) + 1;
    const entry = { id: this.logSeq, t: Date.now(), text, type };
    if (meta) Object.assign(entry, meta);
    this.log.push(entry);
    if (this.log.length > 300) this.log.shift();
  }

  getPlayer(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('플레이어를 찾을 수 없습니다.');
    return p;
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  /** seat 기준으로 fromId 다음부터 차례 순서대로 살아있는 다른 플레이어들 */
  othersInTurnOrder(fromId) {
    const me = this.getPlayer(fromId);
    const n = this.players.length;
    const out = [];
    for (let k = 1; k < n; k++) {
      const p = this.players[(me.seat + k) % n];
      if (p.alive && p.id !== fromId) out.push(p);
    }
    return out;
  }

  kind(card) {
    return CARD_KINDS[card.kind];
  }

  is(player, characterId) {
    return player.characterId === characterId;
  }

  hasPassive(player, kind) {
    return player.passives.some((c) => c.kind === kind);
  }

  drawTopCard() {
    if (this.deck.length === 0) {
      if (this.discard.length === 0) return null;
      this.deck = shuffle(this.discard);
      this.discard = [];
      this.addLog('카드 더미가 떨어져 버린 카드를 섞어 새 더미를 만들었습니다.', 'system');
    }
    return this.deck.pop();
  }

  drawCardTo(player, n = 1) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      const c = this.drawTopCard();
      if (!c) break;
      player.hand.push(c);
      drawn.push(c);
    }
    return drawn;
  }

  discardCardObj(card) {
    this.discard.push(card);
  }

  removeFromHand(player, cardId) {
    const idx = player.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) throw new GameError('손에 그 카드가 없습니다.');
    return player.hand.splice(idx, 1)[0];
  }

  /** 상대 손에서 무작위 한 장을 가져온다 (제시 존스, 엘 그링고) */
  stealRandomCard(from, to) {
    if (!from.hand.length) return null;
    const idx = Math.floor(Math.random() * from.hand.length);
    const card = from.hand.splice(idx, 1)[0];
    to.hand.push(card);
    return card;
  }

  setReveal(label, cards) {
    this.reveal = { label, cards: cards.map((c) => ({ ...c })), turn: this.turn ? this.turn.number : 0, at: Date.now() };
  }

  // ---------- pending 스택 ----------
  pushPending(p) {
    this.pendingSeq = (this.pendingSeq || 0) + 1;
    p.id = this.pendingSeq;
    p.prev = this.pending;
    this.pending = p;
    return p;
  }

  popPending() {
    const p = this.pending;
    this.pending = p ? p.prev : null;
    return p;
  }

  // ---------- 사거리 ----------
  weaponRange(player) {
    return player.weapon ? this.kind(player.weapon).range : 1;
  }

  distance(fromId, toId) {
    const alive = this.alivePlayers();
    const i = alive.findIndex((p) => p.id === fromId);
    const j = alive.findIndex((p) => p.id === toId);
    if (i === -1 || j === -1) return Infinity;
    const n = alive.length;
    const raw = Math.abs(i - j);
    let d = Math.min(raw, n - raw);
    const from = alive[i];
    const to = alive[j];
    if (this.hasPassive(to, 'mustang')) d += 1;
    if (this.hasPassive(from, 'scope')) d -= 1;
    if (this.is(from, 'rose_doolan')) d -= 1; // 로즈 둘란: 본인 기준으로만 거리 1 감소
    return Math.max(1, d);
  }

  distancesFrom(id) {
    const out = {};
    for (const p of this.alivePlayers()) {
      if (p.id !== id) out[p.id] = this.distance(id, p.id);
    }
    return out;
  }

  // ---------- 턴 진행 ----------
  startTurn(playerId) {
    const p = this.getPlayer(playerId);
    this.turn = {
      playerId,
      step: 'draw',
      bangsPlayed: 0,
      number: (this.turn?.number || 0) + 1,
      abilityUsed: false, // 엉클 윌
    };
    this.reveal = null;
    this.addLog(`${p.nickname}의 차례입니다.`, 'turn');
    // 차례 시작 판정: 감옥 → 카드 가져오기
    this.turn.step = 'start';
    this.checkJail(p, () => this.drawPhase(p));
  }

  /** 감옥: 하트면 탈출, 아니면 차례를 통째로 건너뜀. 어느 쪽이든 감옥 카드는 버려진다 */
  checkJail(p, next) {
    const jail = p.passives.find((c) => c.kind === 'jail');
    if (!jail) return next();
    this.drawCheck(p, '감옥', (card) => {
      p.passives = p.passives.filter((c) => c.id !== jail.id);
      this.discardCardObj(jail);
      if (card && card.suit === 'H') {
        this.addLog(`하트! ${p.nickname}이(가) 감옥에서 탈출했습니다.`, 'info');
        next();
      } else {
        this.addLog(`${p.nickname}이(가) 감옥에서 나오지 못해 이번 차례를 건너뜁니다.`, 'info');
        this.advanceTurn();
      }
    });
  }

  /** "카드 가져오기!" 단계 — 캐릭터에 따라 선택이 필요하면 pending을 쌓는다 */
  drawPhase(p) {
    if (this.is(p, 'kit_carlson')) {
      const cards = [];
      for (let i = 0; i < 3; i++) {
        const c = this.drawTopCard();
        if (c) cards.push(c);
      }
      if (cards.length <= 2) {
        p.hand.push(...cards);
        this.addLog(`${p.nickname}이(가) 카드 ${cards.length}장을 가져왔습니다.`, 'draw', { actor: p.id, count: cards.length, from: 'deck' });
        return this.finishDrawPhase(p);
      }
      this.pushPending({ type: 'kit_carlson', playerId: p.id, cards, count: 2 });
      return;
    }
    if (this.is(p, 'jesse_jones')) {
      const victims = this.othersInTurnOrder(p.id).filter((o) => o.hand.length > 0);
      if (victims.length) {
        this.pushPending({ type: 'jesse_jones', playerId: p.id, targetIds: victims.map((v) => v.id) });
        return;
      }
    }
    if (this.is(p, 'claus_the_saint')) {
      const recipients = this.othersInTurnOrder(p.id);
      const n = this.alivePlayers().length + 1;
      const cards = [];
      for (let i = 0; i < n; i++) {
        const c = this.drawTopCard();
        if (c) cards.push(c);
      }
      this.addLog(`${p.nickname}이(가) 카드 ${cards.length}장을 가져와 나눠주기 시작합니다.`, 'draw', { actor: p.id, count: cards.length, from: 'deck' });
      if (cards.length <= 2 || !recipients.length) {
        p.hand.push(...cards);
        return this.finishDrawPhase(p);
      }
      this.pushPending({ type: 'claus_the_saint', playerId: p.id, cards, recipientIds: recipients.map((r) => r.id), index: 0 });
      return;
    }
    if (this.is(p, 'black_jack')) {
      const first = this.drawCardTo(p, 1);
      const second = this.drawCardTo(p, 1)[0];
      let n = first.length + (second ? 1 : 0);
      if (second) {
        this.setReveal('블랙 잭이 공개한 두 번째 카드', [second]);
        const red = second.suit === 'H' || second.suit === 'D';
        this.addLog(`${p.nickname}이(가) 두 번째 카드 [${cardLabel(second)}]를 공개했습니다.${red ? ' 빨간 카드! 한 장 더 가져옵니다.' : ''}`, 'draw');
        if (red) n += this.drawCardTo(p, 1).length;
      }
      this.addLog(`${p.nickname}이(가) 카드 ${n}장을 가져왔습니다.`, 'draw', { actor: p.id, count: n, from: 'deck' });
      return this.finishDrawPhase(p);
    }
    const drawn = this.drawCardTo(p, 2);
    this.addLog(`${p.nickname}이(가) 카드 ${drawn.length}장을 가져왔습니다.`, 'draw', { actor: p.id, count: drawn.length, from: 'deck' });
    this.finishDrawPhase(p);
  }

  finishDrawPhase(p) {
    if (this.turn && this.turn.playerId === p.id) this.turn.step = 'play';
  }

  nextAlivePlayerAfter(seat) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) {
      const p = this.players[(seat + k) % n];
      if (p.alive) return p;
    }
    return null;
  }

  advanceTurn() {
    if (this.winner) return;
    const cur = this.getPlayer(this.turn.playerId);
    const next = this.nextAlivePlayerAfter(cur.seat);
    if (next) this.startTurn(next.id);
  }

  assertTurn(playerId) {
    if (this.winner) throw new GameError('게임이 끝났습니다.');
    if (!this.turn || this.turn.playerId !== playerId) throw new GameError('당신의 차례가 아닙니다.');
    if (this.pending) throw new GameError('진행 중인 선택이 끝날 때까지 기다려주세요.');
  }

  /** 모든 공개 액션 끝에 호출: 수지 라파예트 등 "즉시" 효과 정리 */
  settle() {
    if (this.winner) return;
    for (const p of this.alivePlayers()) {
      if (this.is(p, 'suzy_lafayette') && p.hand.length === 0) {
        const d = this.drawCardTo(p, 1);
        if (d.length) this.addLog(`${p.nickname}의 손이 비어 카드 한 장을 가져왔습니다. (수지 라파예트)`, 'draw', { actor: p.id, count: 1, from: 'deck' });
      }
    }
  }

  // ---------- "카드 펼치기!" ----------
  /**
   * @param {object} player 펼치는 사람
   * @param {string} label 무엇 때문에 펼치는지
   * @param {(card:object)=>void} cb 펼친 카드로 판정하는 함수
   */
  drawCheck(player, label, cb) {
    if (this.is(player, 'lucky_duke')) {
      const cards = [];
      for (let i = 0; i < 2; i++) {
        const c = this.drawTopCard();
        if (c) cards.push(c);
      }
      if (cards.length === 2) {
        this.setReveal(`${player.nickname}의 카드 펼치기 (${label}) — 럭키 듀크`, cards);
        this.addLog(`${player.nickname}이(가) [${cardLabel(cards[0])}] [${cardLabel(cards[1])}]를 펼쳤습니다. (럭키 듀크: 한 장 선택)`, 'draw');
        this.pushPending({ type: 'lucky_duke', playerId: player.id, cards, label, cb });
        return;
      }
      // 카드가 모자라면 그냥 한 장으로
      const c = cards[0];
      if (!c) return cb(null);
      this.discardCardObj(c);
      this.setReveal(`${player.nickname}의 카드 펼치기 (${label})`, [c]);
      this.addLog(`${player.nickname}이(가) [${cardLabel(c)}]를 펼쳤습니다.`, 'draw');
      return cb(c);
    }
    const c = this.drawTopCard();
    if (!c) return cb(null);
    this.discardCardObj(c);
    this.setReveal(`${player.nickname}의 카드 펼치기 (${label})`, [c]);
    this.addLog(`${player.nickname}이(가) [${cardLabel(c)}]를 펼쳤습니다.`, 'draw');
    cb(c);
  }

  // ---------- 플레이어 액션 ----------
  /**
   * 카드 사용
   * @param {object} [opts] { as: 'general_store' } — 엉클 윌: 아무 카드를 잡화점으로 사용
   */
  playCard(playerId, cardId, targetId, opts = {}) {
    this.assertTurn(playerId);
    if (this.turn.step !== 'play') throw new GameError('지금은 카드를 사용할 수 없습니다.');
    const me = this.getPlayer(playerId);
    const card = me.hand.find((c) => c.id === cardId);
    if (!card) throw new GameError('손에 그 카드가 없습니다.');

    let effectiveKind = card.kind;
    if (opts.as === 'general_store') {
      if (!this.is(me, 'uncle_will')) throw new GameError('엉클 윌만 사용할 수 있는 능력입니다.');
      if (this.turn.abilityUsed) throw new GameError('이번 차례에 이미 능력을 사용했습니다.');
      effectiveKind = 'general_store';
    } else if (card.kind === 'missed' && this.is(me, 'calamity_janet')) {
      effectiveKind = 'bang'; // 캘러미티 자넷: 빗나감! → 뱅!
    }
    const k = CARD_KINDS[effectiveKind];

    if (!k.implemented) throw new GameError(`<${k.name}>은(는) 아직 구현되지 않은 카드입니다.`);
    if (k.responseOnly) throw new GameError(`<${k.name}>은(는) 공격을 받았을 때만 사용할 수 있습니다.`);

    // 대상 검증
    let target = null;
    if (k.target !== 'none') {
      if (!targetId) throw new GameError('대상을 선택해야 합니다.');
      target = this.getPlayer(targetId);
      if (!target.alive) throw new GameError('이미 탈락한 플레이어입니다.');
      const allowSelf = k.target === 'any' || k.target === 'any-range';
      if (target.id === me.id && !allowSelf) throw new GameError('자신을 대상으로 할 수 없습니다.');
      if ((k.target === 'other' || k.target === 'any-range') && target.id !== me.id) {
        const maxRange = k.fixedRange || this.weaponRange(me);
        const d = this.distance(me.id, target.id);
        if (d > maxRange) throw new GameError(`사거리가 부족합니다. (거리 ${d}, 사거리 ${maxRange})`);
      }
    }

    let result;
    switch (effectiveKind) {
      case 'bang':
        result = this.playBang(me, card, target);
        break;
      case 'beer':
        result = this.playBeer(me, card);
        break;
      case 'general_store':
        result = this.playGeneralStore(me, card, opts.as === 'general_store');
        break;
      case 'stagecoach':
      case 'wells_fargo':
        result = this.playDraw(me, card, effectiveKind === 'stagecoach' ? 2 : 3);
        break;
      case 'saloon':
        result = this.playSaloon(me, card);
        break;
      case 'panic':
      case 'cat_balou':
        result = this.playTake(me, card, target, effectiveKind === 'panic' ? 'steal' : 'discard', opts.pick);
        break;
      case 'duel':
        result = this.playDuel(me, card, target);
        break;
      case 'gatling':
        result = this.playGatling(me, card);
        break;
      case 'indians':
        result = this.playIndians(me, card);
        break;
      case 'jail':
        result = this.playJail(me, card, target);
        break;
      case 'dynamite':
        result = this.playDynamite(me, card);
        break;
      case 'scope':
      case 'mustang':
      case 'barrel':
        result = this.equipPassive(me, card);
        break;
      case 'volcanic':
      case 'schofield':
      case 'remington':
      case 'rev_carabine':
      case 'winchester':
        result = this.equipWeapon(me, card);
        break;
      default:
        throw new GameError('사용할 수 없는 카드입니다.');
    }
    this.settle();
    return result;
  }

  canPlayBang(me) {
    const unlimited = this.is(me, 'willy_the_kid') || (me.weapon && me.weapon.kind === 'volcanic');
    return this.turn.bangsPlayed === 0 || unlimited;
  }

  playBang(me, card, target) {
    if (!this.canPlayBang(me)) throw new GameError('<뱅!>은 한 턴에 한 장만 사용할 수 있습니다.');
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    this.turn.bangsPlayed += 1;
    this.attacks.push({ attackerId: me.id, targetId: target.id, turn: this.turn.number });
    const via = card.kind === 'missed' ? ' (빗나감!을 뱅!으로)' : '';
    this.addLog(`${me.nickname}이(가) ${target.nickname}에게 <뱅!>을 사용했습니다.${via}`, 'attack', { actor: me.id, target: target.id, kind: 'bang' });
    this.startBangPending(me, target);
  }

  /**
   * 뱅!(또는 기관총) 공격 대기 생성
   * @param {string} [subtype] 'bang' | 'gatling'
   * @param {Function} [then] 공격이 끝난 뒤 이어서 할 일 (기관총 연쇄 등)
   */
  startBangPending(attacker, target, subtype = 'bang', then = null) {
    const needed = subtype === 'bang' && this.is(attacker, 'slab_the_killer') ? 2 : 1;
    const drawSources = [];
    if (this.is(target, 'jourdonnais')) drawSources.push('jourdonnais');
    if (this.hasPassive(target, 'barrel')) drawSources.push('barrel');
    if (needed === 2) this.addLog(`슬랩 더 킬러의 <뱅!>: 피하려면 <빗나감!> 2장이 필요합니다.`, 'info');
    this.pushPending({
      type: 'bang',
      subtype,
      playerId: target.id,
      attackerId: attacker.id,
      targetId: target.id,
      missedKinds: this.is(target, 'calamity_janet') ? ['missed', 'bang'] : ['missed'],
      needed,
      used: 0,
      drawSources, // 아직 쓰지 않은 "카드 펼치기" 수단
      then,
    });
  }

  // ---------- 새 갈색 카드들 ----------
  playDraw(me, card, n) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    const d = this.drawCardTo(me, n);
    this.addLog(`${me.nickname}이(가) <${this.kind(card).name}>으로 카드 ${d.length}장을 가져왔습니다.`, 'draw', { actor: me.id, kind: card.kind, announce: true, count: d.length, from: 'deck', played: true });
  }

  playSaloon(me, card) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    const healed = [];
    for (const p of this.alivePlayers()) {
      if (p.hp < p.maxHp) { p.hp += 1; healed.push(p.nickname); }
    }
    this.addLog(`${me.nickname}이(가) <주점>을 열었습니다. ${healed.length ? healed.join(', ') + '이(가) 체력 1을 회복했습니다.' : '회복한 사람이 없습니다.'}`, 'heal', { actor: me.id, kind: 'saloon', targets: this.alivePlayers().map((x) => x.id) });
  }

  /** 강탈!(steal) / 캣 벌로우(discard): 대상의 손(무작위) 또는 앞에 놓인 카드(선택) */
  playTake(me, card, target, mode, pick) {
    const tableCards = [...(target.weapon ? [target.weapon] : []), ...target.passives];
    const handCount = target.id === me.id ? 0 : target.hand.length; // 자기 손에서 뺏는 건 의미 없음
    if (!tableCards.length && !handCount) throw new GameError(`${target.nickname}에게는 가져올 카드가 없습니다.`);
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    const name = this.kind(card).name;
    this.addLog(`${me.nickname}이(가) ${target.nickname}에게 <${name}>을(를) 사용했습니다.`, 'attack', { actor: me.id, target: target.id, kind: card.kind });
    // 선택지가 하나뿐이면 바로 처리
    if (!tableCards.length) return this.resolveTake(me, target, mode, { from: 'hand' });
    if (!handCount && tableCards.length === 1) return this.resolveTake(me, target, mode, { from: 'table', cardId: tableCards[0].id });
    if (pick && pick.from) return this.resolveTake(me, target, mode, pick);
    this.pushPending({ type: 'pick_card', playerId: me.id, targetId: target.id, mode, cardName: name, handCount });
  }

  resolveTake(me, target, mode, pick) {
    let taken = null;
    let where = '';
    if (pick.from === 'hand') {
      if (target.id === me.id || !target.hand.length) throw new GameError('손에서 가져올 카드가 없습니다.');
      const idx = Math.floor(Math.random() * target.hand.length);
      taken = target.hand.splice(idx, 1)[0];
      where = '손에서';
    } else {
      if (target.weapon && target.weapon.id === pick.cardId) { taken = target.weapon; target.weapon = null; }
      else {
        const i = target.passives.findIndex((c) => c.id === pick.cardId);
        if (i === -1) throw new GameError('그 카드는 고를 수 없습니다.');
        taken = target.passives.splice(i, 1)[0];
      }
      where = `앞에 놓인 <${this.kind(taken).name}>을(를)`;
    }
    if (mode === 'steal') {
      me.hand.push(taken);
      this.addLog(`${me.nickname}이(가) ${target.nickname}의 ${where} 가져왔습니다.`, 'info', { actor: me.id, target: target.id, kind: 'steal', count: 1, from: 'player' });
    } else {
      this.discardCardObj(taken);
      this.addLog(`${me.nickname}이(가) ${target.nickname}의 ${where} 버리게 했습니다.`, 'info', { actor: target.id, kind: 'forced_discard', card: taken });
    }
  }

  playJail(me, card, target) {
    if (this.hasPassive(target, 'jail')) throw new GameError(`${target.nickname}은(는) 이미 감옥에 있습니다.`);
    this.removeFromHand(me, card.id);
    target.passives.push(card);
    this.addLog(`${me.nickname}이(가) ${target.nickname}을(를) <감옥>에 가두었습니다.`, 'attack', { actor: me.id, target: target.id, kind: 'jail' });
  }

  playDuel(me, card, target) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    this.attacks.push({ attackerId: me.id, targetId: target.id, turn: this.turn.number });
    this.addLog(`${me.nickname}이(가) ${target.nickname}에게 <결투>를 신청했습니다!`, 'attack', { actor: me.id, target: target.id, kind: 'duel' });
    this.pushPending({ type: 'duel', playerId: target.id, challengerId: me.id, targetId: target.id, round: 0 });
  }

  /** 다이너마이트(즉시 발동): 사용한 사람부터 차례로 펼쳐 터질 때까지 돈다. 터지면 체력 2 */
  playDynamite(me, card) {
    this.removeFromHand(me, card.id);
    this.addLog(`${me.nickname}이(가) <다이너마이트>에 불을 붙였습니다! 터질 때까지 차례로 돌아갑니다.`, 'attack', { actor: me.id, kind: 'dynamite' });
    this.pushPending({ type: 'dynamite', playerId: me.id, auto: true, card, hops: 0 });
  }

  /** 다이너마이트 한 단계 진행 (서버가 잠시 뒤 자동 호출) */
  resolveDynamite() {
    const p = this.pending;
    if (!p || p.type !== 'dynamite') throw new GameError('다이너마이트 진행 중이 아닙니다.');
    const holder = this.getPlayer(p.playerId);
    this.popPending();
    this.drawCheck(holder, '다이너마이트', (card) => {
      const boom = card && card.suit === 'S' && ['2', '3', '4', '5', '6', '7', '8', '9'].includes(card.rank);
      if (boom || p.hops > 200) {
        this.discardCardObj(p.card);
        this.addLog(`💥 다이너마이트가 ${holder.nickname}의 앞에서 폭발했습니다!`, 'damage', { target: holder.id, kind: 'dynamite' });
        this.damage(holder, 2, null);
      } else {
        const next = this.nextAlivePlayerAfter(holder.seat) || holder;
        this.addLog(`다이너마이트가 터지지 않아 ${next.nickname}에게 넘어갑니다.`, 'info', { actor: holder.id, target: next.id, kind: 'dynamite' });
        this.pushPending({ type: 'dynamite', playerId: next.id, auto: true, card: p.card, hops: p.hops + 1 });
      }
    });
    this.settle();
  }

  /** 대상들에게 순서대로 공격 대기를 만드는 공통 처리 (기관총 / 인디언) */
  chainAttack(me, targetIds, makePending) {
    const step = (i) => {
      if (this.winner) return;
      if (i >= targetIds.length) return;
      const t = this.players.find((p) => p.id === targetIds[i]);
      if (!t || !t.alive) return step(i + 1);
      makePending(t, () => step(i + 1));
    };
    step(0);
  }

  playGatling(me, card) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    this.addLog(`${me.nickname}이(가) <기관총>을 난사했습니다! 다른 모든 플레이어가 공격받습니다.`, 'attack', { actor: me.id, kind: 'gatling', targets: this.othersInTurnOrder(me.id).map((x) => x.id) });
    const ids = this.othersInTurnOrder(me.id).map((p) => p.id);
    for (const id of ids) this.attacks.push({ attackerId: me.id, targetId: id, turn: this.turn.number });
    this.chainAttack(me, ids, (t, next) => this.startBangPending(me, t, 'gatling', next));
  }

  playIndians(me, card) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    this.addLog(`${me.nickname}이(가) <인디언>을 사용했습니다! 다른 모든 플레이어는 <뱅!>을 버리거나 체력 1을 잃습니다.`, 'attack', { actor: me.id, kind: 'indians', targets: this.othersInTurnOrder(me.id).map((x) => x.id) });
    const ids = this.othersInTurnOrder(me.id).map((p) => p.id);
    this.chainAttack(me, ids, (t, next) => {
      this.pushPending({
        type: 'indians',
        playerId: t.id,
        attackerId: me.id,
        bangKinds: this.is(t, 'calamity_janet') ? ['bang', 'missed'] : ['bang'],
        then: next,
      });
    });
  }

  playBeer(me, card) {
    if (this.alivePlayers().length <= 2) throw new GameError('두 명만 남았을 때는 <맥주>가 효과가 없습니다.');
    if (me.hp >= me.maxHp) throw new GameError('체력이 이미 최대입니다.');
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    me.hp += 1;
    this.addLog(`${me.nickname}이(가) <맥주>를 마시고 체력 1을 회복했습니다.`, 'heal', { actor: me.id, target: me.id, kind: 'beer' });
  }

  playGeneralStore(me, card, viaUncleWill) {
    this.removeFromHand(me, card.id);
    this.discardCardObj(card);
    if (viaUncleWill) {
      this.turn.abilityUsed = true;
      this.addLog(`${me.nickname}이(가) [${cardLabel(card)}]를 <잡화점>으로 사용했습니다. (엉클 윌)`, 'info');
    } else {
      this.addLog(`${me.nickname}이(가) <잡화점>을 사용했습니다.`, 'info', { actor: me.id, kind: 'general_store', announce: true });
    }
    const order = [me, ...this.othersInTurnOrder(me.id)];
    const cards = [];
    for (let i = 0; i < order.length; i++) {
      const c = this.drawTopCard();
      if (c) cards.push(c);
    }
    this.setReveal('잡화점', cards);
    this.addLog(`잡화점에 ${cards.map((c) => `[${cardLabel(c)}]`).join(' ')}이(가) 펼쳐졌습니다.`, 'draw');
    this.pushPending({ type: 'general_store', playerId: order[0].id, cards, orderIds: order.map((p) => p.id), index: 0 });
    this.autoResolveGeneralStore();
  }

  /** 잡화점: 남은 카드가 한 장이면 자동으로 마지막 사람에게 준다 */
  autoResolveGeneralStore() {
    const p = this.pending;
    if (!p || p.type !== 'general_store') return;
    while (p.cards.length === 1 || p.index >= p.orderIds.length) {
      if (p.cards.length === 0 || p.index >= p.orderIds.length) break;
      const taker = this.getPlayer(p.orderIds[p.index]);
      const c = p.cards.shift();
      taker.hand.push(c);
      this.addLog(`${taker.nickname}이(가) 잡화점에서 [${cardLabel(c)}]를 가져갔습니다.`, 'draw', { actor: taker.id, count: 1, from: 'center', card: c });
      p.index += 1;
    }
    if (p.cards.length === 0 || p.index >= p.orderIds.length) {
      for (const c of p.cards) this.discardCardObj(c);
      this.popPending();
      this.reveal = null;
    } else {
      p.playerId = p.orderIds[p.index];
    }
  }

  equipWeapon(me, card) {
    this.removeFromHand(me, card.id);
    if (me.weapon) {
      this.addLog(`${me.nickname}이(가) <${this.kind(me.weapon).name}>을(를) 버렸습니다.`, 'equip', { actor: me.id, kind: me.weapon.kind, discarded: true });
      this.discardCardObj(me.weapon);
    }
    me.weapon = card;
    this.addLog(`${me.nickname}이(가) <${this.kind(card).name}>을(를) 장착했습니다.`, 'equip', { actor: me.id, kind: card.kind });
  }

  equipPassive(me, card) {
    if (this.hasPassive(me, card.kind)) {
      throw new GameError(`<${this.kind(card).name}>은(는) 이미 장착되어 있습니다.`);
    }
    this.removeFromHand(me, card.id);
    me.passives.push(card);
    this.addLog(`${me.nickname}이(가) <${this.kind(card).name}>을(를) 장착했습니다.`, 'equip', { actor: me.id, kind: card.kind });
  }

  /** 시드 케첨: 카드 두 장을 버려 체력 1 회복 (언제든지) */
  useAbility(playerId, payload = {}) {
    if (this.winner) throw new GameError('게임이 끝났습니다.');
    const me = this.getPlayer(playerId);
    if (!me.alive) throw new GameError('탈락한 플레이어입니다.');
    if (!this.is(me, 'sid_ketchum')) throw new GameError('지금 사용할 수 있는 능력이 없습니다.');
    if (this.pending && this.pending.type === 'dying' && this.pending.playerId === me.id) {
      throw new GameError('생명력이 0일 때는 <맥주>만 사용할 수 있습니다.');
    }
    if (me.hp >= me.maxHp) throw new GameError('체력이 이미 최대입니다.');
    const ids = payload.cardIds || [];
    if (ids.length !== 2 || ids[0] === ids[1]) throw new GameError('버릴 카드 두 장을 골라주세요.');
    for (const id of ids) if (!me.hand.some((c) => c.id === id)) throw new GameError('손에 그 카드가 없습니다.');
    for (const id of ids) this.discardCardObj(this.removeFromHand(me, id));
    me.hp += 1;
    this.addLog(`${me.nickname}이(가) 카드 두 장을 버리고 체력 1을 회복했습니다. (시드 케첨)`, 'heal', { actor: me.id, target: me.id, kind: 'ability' });
    this.settle();
  }

  /** 응답: 뱅!(missed / draw / take), 죽어가는 중(beer / die) */
  respond(playerId, response) {
    if (!this.pending) throw new GameError('응답할 것이 없습니다.');
    if (this.pending.playerId !== playerId) throw new GameError('당신이 응답할 차례가 아닙니다.');
    const p = this.pending;
    const me = this.getPlayer(playerId);

    if (p.type === 'bang') {
      const attacker = this.getPlayer(p.attackerId);
      if (response.action === 'missed') {
        const card = me.hand.find((c) => c.id === response.cardId);
        if (!card) throw new GameError('손에 그 카드가 없습니다.');
        if (!p.missedKinds.includes(card.kind)) throw new GameError('그 카드로는 피할 수 없습니다.');
        this.removeFromHand(me, card.id);
        this.discardCardObj(card);
        this.addLog(`${me.nickname}이(가) <${this.kind(card).name}>을(를) 사용했습니다.`, 'dodge', { actor: me.id, target: me.id, kind: 'missed', partial: p.used + 1 < p.needed });
        this.bangDodgeStep(p, me);
      } else if (response.action === 'draw') {
        const src = response.source || p.drawSources[0];
        if (!p.drawSources.includes(src)) throw new GameError('지금은 카드 펼치기를 할 수 없습니다.');
        p.drawSources = p.drawSources.filter((s) => s !== src);
        const label = src === 'jourdonnais' ? '주르도네' : '술통';
        this.drawCheck(me, label, (card) => {
          if (card && card.suit === 'H') {
            this.addLog(`하트! ${me.nickname}이(가) 총알을 피했습니다. (${label})`, 'dodge', { actor: me.id, target: me.id, kind: 'barrel' });
            this.bangDodgeStep(p, me);
          } else {
            this.addLog(`하트가 아닙니다. ${label} 판정 실패.`, 'info');
          }
        });
      } else if (response.action === 'take') {
        this.popPending();
        this.damage(me, 1, attacker, p.then);
      } else {
        throw new GameError('알 수 없는 응답입니다.');
      }
    } else if (p.type === 'duel') {
      const challenger = this.getPlayer(p.challengerId);
      const target = this.getPlayer(p.targetId);
      const other = me.id === challenger.id ? target : challenger;
      const bangKinds = this.is(me, 'calamity_janet') ? ['bang', 'missed'] : ['bang'];
      if (response.action === 'bang') {
        const card = me.hand.find((c) => c.id === response.cardId);
        if (!card || !bangKinds.includes(card.kind)) throw new GameError('<뱅!> 카드를 골라주세요.');
        this.removeFromHand(me, card.id);
        this.discardCardObj(card);
        this.addLog(`결투: ${me.nickname}이(가) <${this.kind(card).name}>을(를) 버렸습니다.`, 'attack', { actor: me.id, target: other.id, kind: 'duel_bang' });
        p.round += 1;
        p.playerId = other.id;
      } else if (response.action === 'take') {
        this.popPending();
        this.addLog(`결투: ${me.nickname}이(가) <뱅!>을 내지 못했습니다.`, 'attack');
        // 결투를 건 사람이 졌으면 상대에게 보상/벌칙 없음 (source 없음)
        this.damage(me, 1, me.id === target.id ? challenger : null);
      } else {
        throw new GameError('알 수 없는 응답입니다.');
      }
    } else if (p.type === 'indians') {
      if (response.action === 'bang') {
        const card = me.hand.find((c) => c.id === response.cardId);
        if (!card || !p.bangKinds.includes(card.kind)) throw new GameError('<뱅!> 카드를 골라주세요.');
        this.removeFromHand(me, card.id);
        this.discardCardObj(card);
        this.addLog(`${me.nickname}이(가) <${this.kind(card).name}>을(를) 버려 인디언을 물리쳤습니다.`, 'dodge', { actor: me.id, target: me.id, kind: 'bang' });
        this.popPending();
        if (p.then) p.then();
      } else if (response.action === 'take') {
        this.popPending();
        this.damage(me, 1, this.getPlayer(p.attackerId), p.then);
      } else {
        throw new GameError('알 수 없는 응답입니다.');
      }
    } else if (p.type === 'dying') {
      if (response.action === 'beer') {
        const card = me.hand.find((c) => c.id === response.cardId && c.kind === 'beer');
        if (!card) throw new GameError('손에 <맥주>가 없습니다.');
        this.removeFromHand(me, card.id);
        this.discardCardObj(card);
        me.hp += 1;
        this.addLog(`${me.nickname}이(가) 쓰러지기 직전 <맥주>를 마셨습니다! (체력 ${me.hp})`, 'heal', { actor: me.id, target: me.id, kind: 'beer' });
        if (me.hp > 0) {
          this.popPending();
          if (p.then) p.then();
        }
      } else if (response.action === 'die') {
        this.popPending();
        this.eliminate(me, p.sourceId ? this.getPlayer(p.sourceId) : null);
        if (p.then && !this.winner && this.turn && this.getPlayer(this.turn.playerId).alive) p.then();
      } else {
        throw new GameError('알 수 없는 응답입니다.');
      }
    } else {
      throw new GameError('지금은 응답이 아니라 선택을 해야 합니다.');
    }
    this.settle();
  }

  /** 뱅! 회피 1단계 성공 — 필요한 만큼 모이면 회피 완료 */
  bangDodgeStep(p, me) {
    p.used += 1;
    if (p.used >= p.needed) {
      this.addLog(`${me.nickname}이(가) 공격을 피했습니다!`, 'dodge');
      // p가 스택 맨 위여야 한다 (럭키 듀크 선택은 이미 pop된 뒤 콜백이 실행됨)
      if (this.pending === p) this.popPending();
      if (p.then) p.then();
    } else {
      this.addLog(`${me.nickname}: <빗나감!>이 ${p.needed - p.used}장 더 필요합니다.`, 'info');
    }
  }

  /** 선택: 키트 칼슨 / 제시 존스 / 럭키 듀크 / 클라우스 / 잡화점 */
  choose(playerId, payload = {}) {
    if (!this.pending) throw new GameError('선택할 것이 없습니다.');
    if (this.pending.playerId !== playerId) throw new GameError('당신이 선택할 차례가 아닙니다.');
    const p = this.pending;
    const me = this.getPlayer(playerId);

    switch (p.type) {
      case 'kit_carlson': {
        const ids = payload.cardIds || [];
        if (ids.length !== p.count || new Set(ids).size !== ids.length) throw new GameError(`카드 ${p.count}장을 골라주세요.`);
        const chosen = ids.map((id) => p.cards.find((c) => c.id === id));
        if (chosen.some((c) => !c)) throw new GameError('그 카드는 고를 수 없습니다.');
        const rest = p.cards.filter((c) => !ids.includes(c.id));
        me.hand.push(...chosen);
        for (const c of rest.reverse()) this.deck.push(c); // 더미 맨 위로
        this.popPending();
        this.addLog(`${me.nickname}이(가) 세 장 중 두 장을 골라 가져왔습니다. (키트 칼슨)`, 'draw', { actor: me.id, count: 2, from: 'deck' });
        this.finishDrawPhase(me);
        break;
      }
      case 'jesse_jones': {
        this.popPending();
        if (payload.from === 'player') {
          if (!p.targetIds.includes(payload.targetId)) throw new GameError('그 플레이어에게서는 가져올 수 없습니다.');
          const victim = this.getPlayer(payload.targetId);
          this.stealRandomCard(victim, me);
          this.addLog(`${me.nickname}이(가) ${victim.nickname}의 손에서 카드 한 장을 가져왔습니다. (제시 존스)`, 'draw', { actor: me.id, target: victim.id, count: 1, from: 'player' });
          const d = this.drawCardTo(me, 1);
          this.addLog(`${me.nickname}이(가) 카드 더미에서 ${d.length}장을 가져왔습니다.`, 'draw', { actor: me.id, count: d.length, from: 'deck' });
        } else {
          const d = this.drawCardTo(me, 2);
          this.addLog(`${me.nickname}이(가) 카드 ${d.length}장을 가져왔습니다.`, 'draw', { actor: me.id, count: d.length, from: 'deck' });
        }
        this.finishDrawPhase(me);
        break;
      }
      case 'lucky_duke': {
        const chosen = p.cards.find((c) => c.id === payload.cardId);
        if (!chosen) throw new GameError('그 카드는 고를 수 없습니다.');
        for (const c of p.cards) this.discardCardObj(c);
        this.popPending();
        this.setReveal(`${me.nickname}의 카드 펼치기 (${p.label})`, [chosen]);
        this.addLog(`${me.nickname}이(가) [${cardLabel(chosen)}]를 선택했습니다. (럭키 듀크)`, 'draw');
        p.cb(chosen);
        break;
      }
      case 'claus_the_saint': {
        const chosen = p.cards.find((c) => c.id === payload.cardId);
        if (!chosen) throw new GameError('그 카드는 고를 수 없습니다.');
        const recipient = this.getPlayer(p.recipientIds[p.index]);
        p.cards = p.cards.filter((c) => c.id !== chosen.id);
        recipient.hand.push(chosen);
        this.addLog(`${me.nickname}이(가) ${recipient.nickname}에게 카드 한 장을 주었습니다. (클라우스)`, 'draw', { actor: recipient.id, target: me.id, count: 1, from: 'player' });
        p.index += 1;
        if (p.index >= p.recipientIds.length || p.cards.length <= 2) {
          me.hand.push(...p.cards);
          this.popPending();
          this.addLog(`${me.nickname}이(가) 남은 카드 ${p.cards.length}장을 가졌습니다.`, 'draw');
          this.finishDrawPhase(me);
        }
        break;
      }
      case 'pick_card': {
        const target = this.getPlayer(p.targetId);
        this.popPending();
        this.resolveTake(me, target, p.mode, payload.from === 'hand' ? { from: 'hand' } : { from: 'table', cardId: payload.cardId });
        break;
      }
      case 'general_store': {
        const chosen = p.cards.find((c) => c.id === payload.cardId);
        if (!chosen) throw new GameError('그 카드는 고를 수 없습니다.');
        p.cards = p.cards.filter((c) => c.id !== chosen.id);
        me.hand.push(chosen);
        this.addLog(`${me.nickname}이(가) 잡화점에서 [${cardLabel(chosen)}]를 가져갔습니다.`, 'draw', { actor: me.id, count: 1, from: 'center', card: chosen });
        p.index += 1;
        if (p.index < p.orderIds.length) p.playerId = p.orderIds[p.index];
        this.setReveal('잡화점', p.cards);
        this.autoResolveGeneralStore();
        break;
      }
      default:
        throw new GameError('지금은 선택이 아니라 응답을 해야 합니다.');
    }
    this.settle();
  }

  /** 카드 버리기 (턴 종료 단계) */
  discardCard(playerId, cardId) {
    this.assertTurn(playerId);
    if (this.turn.step !== 'discard') throw new GameError('지금은 카드를 버릴 수 없습니다.');
    const me = this.getPlayer(playerId);
    const card = this.removeFromHand(me, cardId);
    this.discardCardObj(card);
    this.addLog(`${me.nickname}이(가) 카드 한 장을 버렸습니다.`, 'discard', { actor: me.id, card });
    if (me.hand.length <= me.hp) {
      this.finishTurn(me);
    }
    this.settle();
  }

  /** 턴 종료 요청 */
  endTurn(playerId) {
    this.assertTurn(playerId);
    const me = this.getPlayer(playerId);
    if (this.turn.step !== 'play' && this.turn.step !== 'discard') {
      throw new GameError('지금은 턴을 넘길 수 없습니다.');
    }
    if (me.hand.length > me.hp) {
      this.turn.step = 'discard';
      return { needDiscard: me.hand.length - me.hp };
    }
    this.finishTurn(me);
    this.settle();
    return { needDiscard: 0 };
  }

  /** 버리기 단계에서 카드 사용 단계로 되돌아가기 */
  backToPlay(playerId) {
    this.assertTurn(playerId);
    if (this.turn.step !== 'discard') throw new GameError('지금은 되돌아갈 수 없습니다.');
    this.turn.step = 'play';
  }

  finishTurn(me) {
    this.addLog(`${me.nickname}이(가) 차례를 마쳤습니다.`, 'turn');
    this.advanceTurn();
  }

  // ---------- 피해 / 사망 / 승리 ----------
  /**
   * @param {Function} [then] 피해 처리(맥주로 살아나기 포함)가 끝난 뒤 이어서 할 일. 죽으면 호출되지 않는다.
   */
  damage(victim, amount, source, then = null) {
    victim.hp -= amount;
    this.addLog(
      `${victim.nickname}이(가) 체력 ${amount}을 잃었습니다. (남은 체력 ${Math.max(0, victim.hp)})`,
      'damage',
      { target: victim.id, actor: source ? source.id : null, amount },
    );
    // 바트 캐시디: 잃은 체력만큼 카드
    if (this.is(victim, 'bart_cassidy')) {
      const d = this.drawCardTo(victim, amount);
      if (d.length) this.addLog(`${victim.nickname}이(가) 카드 ${d.length}장을 가져왔습니다. (바트 캐시디)`, 'draw', { actor: victim.id, count: d.length, from: 'deck' });
    }
    // 엘 그링고: 공격자 손에서 카드
    if (this.is(victim, 'el_gringo') && source && source.id !== victim.id) {
      let taken = 0;
      for (let i = 0; i < amount; i++) if (this.stealRandomCard(source, victim)) taken += 1;
      if (taken) this.addLog(`${victim.nickname}이(가) ${source.nickname}의 손에서 카드 ${taken}장을 가져왔습니다. (엘 그링고)`, 'draw', { actor: victim.id, target: source.id, count: taken, from: 'player' });
    }

    if (victim.hp <= 0) {
      const beers = victim.hand.filter((c) => c.kind === 'beer').length;
      const needed = 1 - victim.hp;
      if (this.alivePlayers().length > 2 && beers >= needed) {
        this.addLog(`${victim.nickname}이(가) 쓰러지기 직전입니다! <맥주>로 살아날 수 있습니다.`, 'damage');
        this.pushPending({ type: 'dying', playerId: victim.id, sourceId: source ? source.id : null, needed, then });
        return;
      }
      this.eliminate(victim, source);
      // 연쇄 공격(기관총/인디언) 중 누가 죽어도 다음 대상으로 이어간다
      if (then && !this.winner && this.turn && this.getPlayer(this.turn.playerId).alive) then();
      return;
    }
    if (then) then();
  }

  eliminate(victim, source) {
    victim.hp = 0;
    victim.alive = false;
    victim.revealed = true;

    // 벌쳐 샘: 탈락자의 모든 카드를 가져간다
    const vulture = this.alivePlayers().find((p) => this.is(p, 'vulture_sam') && p.id !== victim.id);
    const all = [...victim.hand, ...(victim.weapon ? [victim.weapon] : []), ...victim.passives];
    victim.hand = [];
    victim.weapon = null;
    victim.passives = [];
    if (vulture && all.length) {
      vulture.hand.push(...all);
      this.addLog(`${vulture.nickname}이(가) ${victim.nickname}의 카드 ${all.length}장을 모두 가져갔습니다. (벌쳐 샘)`, 'draw', { actor: vulture.id, target: victim.id, count: all.length, from: 'player' });
    } else {
      for (const c of all) this.discardCardObj(c);
    }

    this.addLog(
      `${victim.nickname}이(가) 탈락했습니다! 정체는 [${ROLE_INFO[victim.role].name}]이었습니다.`,
      'death',
      { target: victim.id, role: victim.role },
    );

    // 벌칙과 보상
    if (source && source.alive && source.id !== victim.id) {
      if (source.role === 'sheriff' && victim.role === 'deputy') {
        for (const c of source.hand) this.discardCardObj(c);
        source.hand = [];
        if (source.weapon) this.discardCardObj(source.weapon);
        source.weapon = null;
        for (const c of source.passives) this.discardCardObj(c);
        source.passives = [];
        this.addLog(`보안관 ${source.nickname}이(가) 부관을 제거한 벌칙으로 모든 카드를 버렸습니다.`, 'penalty', { actor: source.id, discardAll: true });
      }
      if (victim.role === 'outlaw') {
        this.drawCardTo(source, 3);
        this.addLog(`${source.nickname}이(가) 무법자를 제거한 보상으로 카드 세 장을 가져왔습니다.`, 'reward', { actor: source.id, count: 3, from: 'deck' });
      }
    }

    this.checkWinner();
    if (this.winner) return;

    // 탈락자가 끼어 있는 대기 상황 정리 (잡화점 순서, 클라우스 수신자 등)
    this.dropDeadFromPending();

    // 탈락한 플레이어의 차례였다면 다음으로
    if (this.turn && this.turn.playerId === victim.id) {
      this.pending = null;
      this.advanceTurn();
    }
  }

  dropDeadFromPending() {
    let p = this.pending;
    while (p) {
      if (p.type === 'general_store') {
        p.orderIds = p.orderIds.filter((id, i) => i < p.index || this.getPlayer(id).alive);
        if (p.index < p.orderIds.length) p.playerId = p.orderIds[p.index];
      }
      if (p.type === 'claus_the_saint') {
        p.recipientIds = p.recipientIds.filter((id, i) => i < p.index || this.getPlayer(id).alive);
      }
      p = p.prev;
    }
    if (this.pending && this.pending.type === 'general_store') this.autoResolveGeneralStore();
    // 맨 위 pending의 담당자가 죽었으면 제거
    while (this.pending && !this.getPlayer(this.pending.playerId).alive) this.popPending();
  }

  checkWinner() {
    const alive = this.alivePlayers();
    const sheriff = this.players.find((p) => p.role === 'sheriff');
    if (!sheriff.alive) {
      if (alive.length === 1 && alive[0].role === 'renegade') {
        this.setWinner('renegade', `배신자 ${alive[0].nickname}의 승리!`);
      } else {
        this.setWinner('outlaw', '무법자의 승리!');
      }
      return;
    }
    const enemies = alive.filter((p) => p.role === 'outlaw' || p.role === 'renegade');
    if (enemies.length === 0) {
      this.setWinner('law', '보안관과 부관의 승리!');
    }
  }

  setWinner(team, message) {
    this.winner = { team, message };
    for (const p of this.players) p.revealed = true;
    this.pending = null;
    this.addLog(`게임 종료 — ${message}`, 'end');
  }
}

module.exports = { Game, GameError, getCharacter, cardLabel };
