# Nextify Review Extension

`migrate-next` (기본 오케스트레이터) 또는 `migrate-next step1 --review` 로 생성된 `.ai-migration/<step>/session.json` 세션을 읽어서 Cursor/VSCode 안에서 diff를 검토하고 `Accept` 또는 `Reject` 할 수 있게 해주는 확장입니다.

## 사용 순서

1. 일반 작업 창에서 패널을 보려면 `nextify-review` 확장을 현재 호스트에 설치/활성화합니다.
2. Command Palette에서 `Nextify Review: Focus Panel` 명령으로 Explorer 패널을 바로 엽니다.
3. 프로젝트 루트에서 `migrate-next`(기본) 또는 레거시 `migrate-next step1 --review` 를 실행합니다.
4. 첫 diff 가 열리면 Explorer 의 `Nextify Review` 패널에서 `Accept` 또는 `Reject` 를 선택합니다.

개발 중이라면 기존처럼 `app/extension` 폴더를 열고 `F5` 로 Extension Development Host 에서 테스트해도 됩니다.

## 동작 방식

- CLI 는 `.ai-migration/<step>/...` 아래에 변경 정보를 기록하고, Extension 은 최신 `session.json` 을 자동으로 읽습니다.
- `Accept` 는 (기본 오케스트레이터 기준) 이미 적용된 현재 상태를 그대로 유지합니다.
- `Reject` 는 (기본 오케스트레이터 기준) 이전 스냅샷(before snapshot)에서 해당 파일을 복원합니다.
- 모든 항목이 처리되면 해당 step의 `.ai-migration/<step>` 폴더가 자동 정리됩니다.
