# Nextify
React to Next migration 자동화 CLI 툴 'Nextify' 개발 레포지토리입니다.

## 설치

### 1) CLI (`nextify-cli`)

프로젝트 폴더에서 아래 중 하나로 설치합니다.

```bash
# 권장: 매번 최신 실행
npx nextify-cli@latest --help

# 또는 전역 설치 후 `migrate-next` 사용
npm install -g nextify-cli
migrate-next --help
```

바이너리 이름은 **`migrate-next`** 입니다 (`package.json`의 `bin`).

### 2) VS Code / Cursor 확장 — Nextify Review

CLI가 `.ai-migration/.../session.json` 을 만들면, 확장이 Explorer의 **Nextify Review** 패널에서 트리·diff·경로 복사를 제공합니다. **CLI와 함께 쓰는 것을 권장**합니다.

`migrate-next`(인자 없음) 또는 `migrate-next step1 --review`로 코드 리뷰 단계에 들어갈 때, VS Code/Cursor CLI를 찾을 수 있으면 **확장이 없을 경우 Marketplace 설치를 물어볼 수 있습니다.** (`NEXTIFY_ASSUME_YES=1`이면 확인 없이 설치를 시도합니다.)

**마켓플레이스에서 설치 (배포 후)**

1. VS Code에서 Extensions (`Ctrl+Shift+X`)를 엽니다.
2. `Nextify Review` 또는 아래 ID로 검색합니다: `capstone0123.nextify-review`
3. Install을 누릅니다.

배포가 완료되면 웹에서도 설치할 수 있습니다 (Publisher ID가 `package.json`과 같을 때):

`https://marketplace.visualstudio.com/items?itemName=capstone0123.nextify-review`

**VSIX로 수동 설치 (마켓플레이스 없이)**

레포에서 확장 디렉터리로 이동한 뒤 VSIX를 만듭니다.

```bash
cd app/extension
npm install
npm run vsix
```

생성된 `nextify-review-*.vsix` 를 VS Code / Cursor에서 **Extensions** 뷰의 `...` 메뉴 → **Install from VSIX...** 로 선택합니다.

**유지 관리자용:** Visual Studio Marketplace에 **Publisher**를 만든 뒤, `app/extension/package.json` 의 `publisher` 값을 본인 Publisher ID와 일치시키고 [Personal Access Token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)으로 로그인한 다음 `npm run vscode:publish` 로 게시합니다 (자세한 절차는 아래).

---

## 사전 준비 (CLI)

### Gemini 인증 경로 구분

- **`GEMINI_API_KEY` + `@google/generative-ai`(API):** `migrate-next ask` 처럼 **Node 안에서 Gemini HTTP API를 직접 호출하는** 명령에 사용됩니다. **마이그레이션할 프로젝트 루트**에서 `migrate-next`를 실행할 때, 같은 폴더의 `.env`와 `.env.local`을 읽습니다 (파일끼리는 `.env.local`이 `.env`보다 우선). **이미 터미널/OS에 설정된 환경 변수는 덮어쓰지 않습니다.** 전역 설치만 쓰는 경우 보조로 `npm root -g\nextify-cli\.env.local` 에도 둘 수 있습니다.
- **`gemini` CLI:** 기본 오케스트레이터(`migrate-next`, 인자 없음) 마지막의 **코드 리뷰 단계만** Gemini CLI 서브프로세스를 띄웁니다. CLI는 프로젝트 `.env`의 `GEMINI_API_KEY`를 자식 프로세스 환경에 합칠 수 있지만, Gemini CLI 고유의 로그인·Vertex 등 다른 인증 방식과 병존할 수 있으므로(`app/src/utils/gemini-cli-spawn-env.cjs` 참고) **`ask`가 되더라도 CLI 리뷰만 실패하는** 경우는 인증 채널이 다른지부터 확인하면 됩니다.

### 기타

- 기본 오케스트레이터(`migrate-next`)의 AI 리뷰는 Gemini CLI(`gemini`)를 사용합니다.
- 기본 오케스트레이터는 리뷰 직전에 Gemini CLI 설치 여부를 확인하고, 없으면 자동 설치를 시도합니다.
- 자동 설치 실패 시 수동 설치 후 재실행하세요: `npm install -g @google/gemini-cli` (또는 `yarn global add @google/gemini-cli`, `pnpm add -g @google/gemini-cli`)
- 기본 오케스트레이터는 step1~6을 실행한 뒤, **Next.js 심화 변환(step7)**, **성능 비교 레포트**, **Gemini CLI 코드 리뷰**를 각각 yes/no 로 선택하도록 묻습니다. 모두 건너뛰면 마이그레이션 결과만 남고 종료합니다.
- step1~6(또는 step7) 이후 **추적된 파일 변경이 하나도 없으면** 성능 레포트와 코드 리뷰 프롬프트는 생략됩니다(`migrate-next report`/`migrate-next review`로 필요 시 별도 실행).
- 기본 레포트 파일은 `nextify-performance-report.md` 로 생성됩니다.
- Nextify Review 패널은 트리/diff 확인 및 선택 파일의 BEFORE/AFTER 경로 복사 기능을 제공합니다. 세션은 `FileSystemWatcher`로 자동 갱신됩니다.

## 실행 명령어 (CLI)

```bash
# 기본 오케스트레이터(서브커맨드 없음):
# step1~step6 실행 후, 다음 3가지를 각각 yes/no로 선택
#   1) Next.js 심화 변환(step7: next/image, next/font, Dynamic Import 등)
#   2) 성능 비교 레포트(Vite vs Next.js) 생성
#   3) Gemini CLI 코드 리뷰(view-only)
migrate-next

# step1~step7만 순차 실행 (레포트/AI 리뷰 제외)
migrate-next steps

# 각 step 단독 실행
migrate-next step1
migrate-next step2
migrate-next step3
migrate-next step4
migrate-next step5
migrate-next step6
migrate-next step7

# step1 레거시(기존 방식): 원본 유지 + preview diff 세션 생성
migrate-next step1 --review

# Gemini 질문/스트리밍
migrate-next ask -q "질문..." --stream

# Gemini가 준 JSON을 지정 파일에만 적용(검증용)
migrate-next ask --apply -f path1,path2 -q "지시..."

# 레포트만 별도 재생성 (이미 마이그레이션이 끝난 폴더에서)
migrate-next report

# 코드 리뷰만 단독 실행 (기존 .ai-migration/stepN/session.json 재사용)
migrate-next review
migrate-next review --session <session.json 경로>
```

### 부분 기능만 사용하고 싶다면

| 원하는 작업 | 명령어 |
|---|---|
| step1~7만 실행 (레포트/리뷰 제외) | `migrate-next steps` |
| 마이그레이션 후 나중에 성능 레포트만 생성 | `migrate-next report` |
| 마이그레이션 후 나중에 코드 리뷰만 진행 | `migrate-next review` |
| step7(심화 변환)만 단독 실행 | `migrate-next step7` |

## CLI 출력 형식

CLI는 일관된 색상·기호 규칙으로 출력합니다.

| 색상 | 기호 | 의미 |
|------|------|------|
| 파랑(굵음) | 헤더 | 단계·페이즈 경계(`logSection`) |
| 초록 | `✔` | 완료·성공(`logSuccess`) |
| 노랑 | `⚠` | 경고·우회 가능한 실패(`logWarn`) |
| 빨강 | `✖` | 치명적 에러(`logError`) |
| 회색 | `·` | 하위 진행 항목·부가 정보(`logStep`) |

각 단계 헤더는 `─` 50개로 구분되며, 에러 메시지는 항상 `process.exit(1)` 전에 출력됩니다.

---

## 워크스페이스 자동 추가 (copy 모드)

`migrate-next` 또는 `migrate-next step1`을 **copy 모드**로 실행하면, 생성된 복사본 폴더를 현재 VS Code / Cursor 창의 워크스페이스에 자동으로 추가합니다 (`code --reuse-window --add <folder>`). 이렇게 하면 **Nextify Review 패널이 `session.json`을 즉시 인식**하여 변경 트리를 표시합니다.

자동 추가가 실패하는 경우(VS Code/Cursor CLI가 PATH에 없을 때)는 노란색 안내 메시지와 함께 아래 두 가지 수동 방법을 안내합니다.

1. **파일 → 작업 영역에 폴더 추가** → 복사본 경로 선택
2. **부모 폴더를 워크스페이스로 열고** 터미널에서 하위 폴더로 이동해 `migrate-next` 실행

자동 추가를 건너뛰려면 `NEXTIFY_SKIP_WORKSPACE_ADD=1` 환경 변수를 설정하세요.

---

## 확장(Nextify Review) 확인 방법

Extension 쪽은 “명령어 테스트”라기보다 VS Code / Cursor에서 확장 실행을 확인합니다.

`app/extension/README.md` 기준으로 F5로 Extension Development Host를 띄우거나, 마켓플레이스/VSIX로 설치한 뒤 실제 프로젝트 루트에서 `migrate-next`(기본) 또는 `migrate-next step1 --review`를 실행한 다음 **Nextify Review** 패널에서 트리·diff·BEFORE/AFTER 경로 복사를 확인합니다.

패널 UI:
- 변경 파일은 트리로 표시되며, 각 파일 옆 뱃지는 변경 종류를 수동태로 나타냅니다 (`created` / `modified` / `deleted`).
- 파일명을 클릭하면 BEFORE/AFTER diff 뷰가 열립니다.
- 상단 툴바의 **Copy BEFORE Path** / **Copy AFTER Path** 버튼으로 선택된 파일의 경로를 복사해 Gemini CLI 등에 `@경로` 형태로 붙여 넣을 수 있습니다.
- `session.json` 갱신은 `FileSystemWatcher`로 자동 감지됩니다(별도 새로고침 불필요).

내부 커맨드: `nextifyReview.refreshSession`, `nextifyReview.openChange`, `nextifyReview.copySessionPath`, `nextifyReview.copyBeforePath`, `nextifyReview.copyAfterPath` (UI 버튼은 BEFORE/AFTER 두 가지만 노출)

---

## Visual Studio Marketplace에 확장 배포 (유지 관리자)

1. [Visual Studio Marketplace](https://marketplace.visualstudio.com/)에 로그인하고 [Publisher 만들기](https://marketplace.visualstudio.com/manage)에서 **Publisher ID**를 확보합니다.
2. `app/extension/package.json` 의 `"publisher"` 를 위 Publisher ID와 동일하게 맞춥니다.
3. [Azure DevOps에서 PAT 생성](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate): 범위에 **Marketplace (Manage)** 가 포함되어야 합니다.
4. 로컬에서 한 번 로그인합니다.

   ```bash
   cd app/extension
   npx vsce login <PublisherID>
   ```

5. 게시합니다.

   ```bash
   npm run vscode:publish
   ```

버전 올릴 때는 `package.json` 의 `"version"` 을 수정한 뒤 다시 `vscode:publish` 하면 됩니다.
