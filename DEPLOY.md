# 배포 가이드 — GitHub + Render (무료)

한 번만 설정하면, 이후에는 `git push`할 때마다 1~2분 뒤 자동으로 새 버전이 올라갑니다.

## 0. 준비물
- GitHub 계정, Git 설치 (있음)
- Render 계정: https://render.com → "Get Started" → **GitHub으로 로그인**

## 1. GitHub에 저장소 만들기
1. https://github.com/new 접속
2. Repository name: `bang-online` (아무 이름 가능)
3. **Private** 선택 (친구들끼리만 쓰는 게임이니 비공개 권장)
4. "Add a README", ".gitignore", "license"는 모두 **체크하지 않음** (이미 폴더에 있음)
5. **Create repository** 클릭 → 나오는 주소(`https://github.com/아이디/bang-online.git`)를 복사

## 2. 폴더를 Git 저장소로 만들고 올리기
PowerShell 또는 명령 프롬프트를 열고 아래를 한 줄씩 입력합니다.
(처음 한 번만 Git에 이름/이메일을 알려줘야 합니다. 이미 했다면 첫 두 줄은 생략)

```bash
git config --global user.name "내이름"
git config --global user.email "내깃허브이메일@example.com"

cd "C:\Users\zzggsl\Desktop\Bang!\bang-online\bang-online"
git init
git add .
git commit -m "Bang! 온라인 첫 커밋"
git branch -M main
git remote add origin https://github.com/아이디/bang-online.git
git push -u origin main
```

- `git push` 때 로그인 창이 뜨면 브라우저로 GitHub 로그인하면 됩니다.
- 완료 후 GitHub 저장소 페이지를 새로고침하면 파일들이 보여야 합니다. (`node_modules`는 `.gitignore` 덕분에 올라가지 않음 — 정상)

## 3. Render에 연결하기
1. https://dashboard.render.com 접속 → 오른쪽 위 **New +** → **Blueprint** 선택
   - (Blueprint는 폴더 안의 `render.yaml`을 읽어 설정을 자동으로 채워주는 방식)
2. **Connect GitHub** → 방금 만든 `bang-online` 저장소 선택 (처음이면 Render에게 저장소 접근 권한을 허용하는 화면이 나옴)
3. Blueprint 이름은 아무거나 → **Apply**
4. 1~3분 기다리면 `bang-online` 서비스가 만들어지고 상태가 **Live**로 바뀜
5. 서비스 페이지 위쪽에 주소가 나옴: `https://bang-online-xxxx.onrender.com`
   → 이 주소를 친구들에게 알려주면 어디서든 접속 가능 (아이패드 사파리, PC 크롬 모두 OK)

> Blueprint 메뉴가 안 보이면: **New +** → **Web Service** → 저장소 선택 후 아래처럼 직접 입력
> - Region: Singapore / Runtime: Node / Build Command: `npm install` / Start Command: `npm start` / Instance Type: Free

## 4. 이후 업데이트 올리기
폴더의 코드가 바뀐 뒤(예: Claude가 업데이트를 넣은 뒤) 아래 세 줄만 입력하면 자동 배포됩니다.

```bash
cd "C:\Users\zzggsl\Desktop\Bang!\bang-online\bang-online"
git add .
git commit -m "무엇을 바꿨는지 한 줄"
git push
```

Render 대시보드의 **Events** 탭에서 배포 진행 상황이 보이고, 끝나면 브라우저 새로고침.

## 알아둘 점
- **무료 티어는 15분간 아무도 접속하지 않으면 잠듭니다.** 다음 사람이 접속하면 30초~1분 뒤 깨어나요. 게임 시작 전에 방장이 먼저 들어가 켜두면 됩니다.
- **배포(push)하면 서버가 재시작되어 진행 중인 게임이 사라집니다.** 친구들과 플레이하는 중에는 push하지 마세요.
- 서버가 잠들거나 재시작되면 방도 사라지므로, 게임할 때마다 방을 새로 만들면 됩니다.
- 무료 티어는 한 달 750시간 한도가 있는데, 계정에 서비스가 하나뿐이면 24시간 켜져 있어도 넘지 않습니다.
- 로컬에서 테스트할 때는 여전히 `npm start` 후 `http://localhost:3000` 으로 접속하면 됩니다.

## 문제가 생기면
- **push가 거부됨 (rejected)**: `git pull origin main --rebase` 후 다시 `git push`
- **Render 빌드 실패**: 서비스 페이지 → **Logs** 탭의 빨간 줄을 복사해서 Claude에게 보여주세요.
- **접속은 되는데 방이 안 만들어짐**: Logs에 오류가 있는지 확인. WebSocket 차단 네트워크(일부 학교 와이파이)에서는 폴링으로 자동 전환되지만 느릴 수 있습니다.
