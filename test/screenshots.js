// UI 스크린샷 검증: 5명의 브라우저 컨텍스트로 로비→게임까지 진행하고 화면을 캡처한다.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3998;
const URL = `http://localhost:${PORT}`;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.on('data', (d) => { if (String(d).includes('실행 중')) r(); }));

  const browser = await chromium.launch();
  const errors = [];
  const pages = [];
  const viewports = [
    { width: 1180, height: 820 }, // iPad landscape
    { width: 820, height: 1180 }, // iPad portrait
    { width: 1440, height: 900 }, // desktop
    { width: 1024, height: 768 },
    { width: 390, height: 844 }, // phone (참고용)
  ];
  try {
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext({ viewport: viewports[i], hasTouch: i < 2 });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`[p${i}] ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`[p${i}] console: ${m.text()}`); });
      await page.goto(URL);
      pages.push(page);
    }
    // 메인 화면
    await pages[0].screenshot({ path: `${OUT}/01-main-ipad.png` });

    // 방 생성
    await pages[0].fill('#nickname', '민준');
    await pages[0].click('#btn-create');
    await pages[0].waitForSelector('#screen-lobby:not([hidden])');
    const code = await pages[0].textContent('#lobby-code');
    console.log('방 코드', code);

    const names = ['서연', '도윤', '하은', '지호'];
    for (let i = 1; i < 5; i++) {
      await pages[i].fill('#nickname', names[i - 1]);
      await pages[i].click('#btn-join-toggle');
      await pages[i].fill('#room-code', code);
      await pages[i].click('#btn-join');
      await pages[i].waitForSelector('#screen-lobby:not([hidden])');
    }
    await pages[1].fill('#lobby-chat-slot .chat-form input', '안녕 얘들아!');
    await pages[1].press('#lobby-chat-slot .chat-form input', 'Enter');
    await pages[0].waitForTimeout(200);
    await pages[0].screenshot({ path: `${OUT}/02-lobby-ipad-host.png` });
    await pages[1].screenshot({ path: `${OUT}/03-lobby-ipad-portrait.png` });

    // 설정 모달(비방장 보기 전용)
    await pages[2].click('#btn-settings');
    await pages[2].screenshot({ path: `${OUT}/04-settings-readonly.png` });
    await pages[2].click('#btn-settings-close');

    // 준비
    for (let i = 1; i < 5; i++) await pages[i].click('#lobby-controls .btn-success');
    await pages[0].waitForSelector('#lobby-controls .btn-primary:not([disabled])');
    await pages[0].screenshot({ path: `${OUT}/05-lobby-ready.png` });
    await pages[0].click('#lobby-controls .btn-primary');
    for (const p of pages) await p.waitForSelector('#screen-game:not([hidden])');
    await pages[0].waitForTimeout(300);

    for (let i = 0; i < 5; i++) await pages[i].screenshot({ path: `${OUT}/06-game-p${i}.png` });

    // 현재 턴 플레이어 찾기 → 뱅 시도
    let turnIdx = -1;
    for (let i = 0; i < 5; i++) {
      const mine = await pages[i].evaluate(() => document.querySelector('#turn-banner').classList.contains('mine'));
      if (mine) { turnIdx = i; break; }
    }
    console.log('턴 플레이어 index', turnIdx);
    const tp = pages[turnIdx];
    // 뱅 카드 선택
    const bang = tp.locator('#hand .card:has(.c-name:text-is("뱅!"))').first();
    if (await bang.count()) {
      await bang.click();
      await tp.screenshot({ path: `${OUT}/07-bang-selected.png` });
      const target = tp.locator('.seat.targetable').first();
      if (await target.count()) {
        await target.click();
        await tp.waitForTimeout(300);
        await tp.screenshot({ path: `${OUT}/08-bang-pending-attacker.png` });
        // 대상 화면
        for (let i = 0; i < 5; i++) {
          const visible = await pages[i].evaluate(() => !document.querySelector('#respond-modal').hidden);
          if (visible) {
            await pages[i].screenshot({ path: `${OUT}/09-respond-modal.png` });
            await pages[i].click('#btn-take-hit');
            break;
          }
        }
        await tp.waitForTimeout(300);
      }
    }
    // 채팅 사이드 열기(좁은 화면)
    await pages[1].click('#btn-toggle-side');
    await pages[1].waitForTimeout(250);
    await pages[1].screenshot({ path: `${OUT}/10-game-portrait-side.png` });
    // 턴 종료
    await tp.click('#action-bar .btn-secondary');
    await tp.waitForTimeout(300);
    await tp.screenshot({ path: `${OUT}/11-after-endturn.png` });

    console.log('오류:', errors.length ? errors : '없음');
  } finally {
    await browser.close();
    server.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
