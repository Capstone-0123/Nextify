# Nextify Review Extension

`migrate-next step1 --review` 로 생성한 `.ai-migration/step1/session.json` 세션을 읽어서 Cursor/VSCode 안에서 diff를 검토하고 `Accept` 또는 `Reject` 할 수 있게 해주는 확장입니다.

## 사용 순서

1. `app/extension` 폴더를 Cursor 또는 VSCode에서 엽니다.
2. `F5` 를 누르면 `Run Nextify Review Extension` 구성으로 Extension Development Host 가 실행됩니다.
3. 새로 뜬 개발 호스트에서 실제 React/Vite 프로젝트를 엽니다.
4. 해당 프로젝트 루트에서 `migrate-next step1 --review` 를 실행합니다.
5. 첫 diff 가 열리면 Explorer 의 `Nextify Review` 패널에서 `Accept` 또는 `Reject` 를 선택합니다.

## 동작 방식

- CLI 는 `.ai-migration/step1/files` 에 migrated 파일을 만듭니다.
- 각 변경 정보는 `.ai-migration/step1/session.json` 에 기록됩니다.
- `Accept` 는 migrated 파일을 원본 경로에 복사하거나 삭제를 적용합니다.
- `Reject` 는 임시 migrated 파일만 지우고 원본은 유지합니다.
- 모든 항목이 처리되면 `.ai-migration/step1` 폴더가 자동 정리됩니다.
