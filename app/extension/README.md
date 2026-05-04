# Nextify Review Extension

`migrate-next` (기본 오케스트레이터) 또는 `migrate-next step1 --review` 로 생성된 `.ai-migration/<step>/session.json` 세션을 읽어서, **프로젝트 디렉터리와 같은 트리 구조**로 변경 파일을 보여 주고 **diff만 열어보는(view-only)** 확장입니다.

## 설치

- **마켓플레이스 (권장):** VS Code / Cursor에서 Extensions에서 `Nextify Review` 또는 확장 ID `capstone0123.nextify-review` 로 검색해 설치합니다.  
  Publisher ID는 레포의 `package.json` 의 `"publisher"` 와 같아야 하며, 배포 전에 Marketplace에서 만든 Publisher와 일치시키세요.
- **VSIX:** 레포 루트의 설명대로 `npm run vsix` 로 만든 파일을 **Install from VSIX...** 로 설치합니다.

## 사용 순서

1. 확장을 현재 호스트(VS Code 또는 Cursor)에 설치·활성화합니다.
2. Command Palette에서 `Nextify Review: Focus Panel` 명령으로 Explorer 패널을 바로 엽니다.
3. 프로젝트 루트에서 `migrate-next`(기본) 또는 레거시 `migrate-next step1 --review` 를 실행합니다.
4. `Nextify Review` 패널에서 폴더를 펼치고, **파일명** 또는 **type 배지(create/modify/delete)** 를 클릭해 diff를 엽니다.
5. 트리에서 파일을 선택한 뒤 `Copy BEFORE path`, `Copy AFTER path` 버튼으로 경로를 복사합니다.
6. Gemini CLI에서 `@복사한경로` 형태로 붙여 넣으면 해당 파일 컨텍스트를 바로 참조할 수 있습니다.
7. 필요하면 `Copy session.json path` 로 세션 메타 경로를 함께 복사해 기준 세션을 명시할 수 있습니다.

개발 중이라면 `app/extension` 을 워크스페이스에 넣고 `F5` 로 Extension Development Host 에서 테스트해도 됩니다 (`.vscode/launch.json` 의 `extensionDevelopmentPath`).

## 동작 방식

- CLI 는 `.ai-migration/<step>/...` 아래에 변경 정보를 기록하고, Extension 은 **step 번호가 가장 큰** `session.json` 을 자동으로 읽습니다.
- 패널에는 **Accept / Reject 가 없습니다.** 마이그레이션 결과는 CLI가 이미 워크스페이스에 반영한 뒤이므로, 리뷰는 확인용입니다.
- 패널의 경로 복사 버튼은 현재 선택된 파일의 `diffBeforePath/diffAfterPath`(또는 호환 경로)를 클립보드에 복사합니다.

## 배포 (vsce)

```bash
cd app/extension
npm install
npm run vsix          # .vsix 생성
npm run vscode:publish  # Marketplace 게시 (PAT 로그인 후)
```

루트 [README.md](../../README.md)에 Publisher 등록·PAT·`vsce login` 절차가 정리되어 있습니다.
