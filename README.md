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

- **`GEMINI_API_KEY`:** `migrate-next ask`, `test-gemini` 등 API 연동에 필요합니다. **마이그레이션할 프로젝트 루트**에서 `migrate-next`를 실행할 때, 같은 폴더의 `.env`와 `.env.local`을 읽습니다 (파일끼리는 `.env.local`이 `.env`보다 우선). **이미 터미널/OS에 설정된 환경 변수는 덮어쓰지 않습니다.** 전역 설치만 쓰는 경우 보조로 `npm root -g\nextify-cli\.env.local` 에도 둘 수 있습니다.
- 기본 오케스트레이터(`migrate-next`)의 AI 리뷰는 Gemini CLI(`gemini`)를 사용합니다.
- 기본 오케스트레이터는 리뷰 직전에 Gemini CLI 설치 여부를 확인하고, 없으면 자동 설치를 시도합니다.
- 자동 설치 실패 시 수동 설치 후 재실행하세요: `npm install -g @google/gemini-cli` (또는 `yarn global add @google/gemini-cli`, `pnpm add -g @google/gemini-cli`)
- 기본 오케스트레이터는 step1~7을 한 번에 실행한 뒤, 최종 **Gemini CLI 대화형 리뷰(view-only)**와 **성능 레포트 생성**까지 한 번에 진행합니다.
- 기본 레포트 파일은 `nextify-performance-report.md` 로 생성됩니다.
- Nextify Review 패널은 트리/diff 확인 및 선택 파일의 before/after 경로 복사 기능을 제공합니다.

## 실행 명령어 (CLI)

```bash
# 기본 오케스트레이터(서브커맨드 없음):
# step1~step7 순차 처리 -> 성능 레포트 생성 -> 코드 리뷰 진행 여부 확인 -> (Yes) diff 및 Gemini 대화형 리뷰(view-only)
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

# Gemini API 연결 테스트
migrate-next test-gemini

# 레포트만 별도 재생성(필요 시)
migrate-next report
```

## 확장(Nextify Review) 확인 방법

Extension 쪽은 “명령어 테스트”라기보다 VS Code / Cursor에서 확장 실행을 확인합니다.

`app/extension/README.md` 기준으로 F5로 Extension Development Host를 띄우거나, 마켓플레이스/VSIX로 설치한 뒤 실제 프로젝트 루트에서 `migrate-next`(기본) 또는 `migrate-next step1 --review`를 실행한 다음 **Nextify Review** 패널에서 트리·diff·before/after 경로 복사를 확인합니다.

내부 커맨드: `nextifyReview.refreshSession`, `nextifyReview.openChange`, `nextifyReview.copySessionPath`, `nextifyReview.copyBeforePath`, `nextifyReview.copyAfterPath`

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
