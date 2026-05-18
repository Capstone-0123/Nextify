# Changelog

## 0.1.3 — 2026-05-11

### Added

- **CLI ↔ Nextify Review:** 기본 오케스트레이터에서 코드 리뷰 단계 진입 전·`migrate-next step1 --review`에서 확장 미설치 시 Marketplace 설치 확인(`NEXTIFY_ASSUME_YES=1`면 확인 생략), 설치 시도 후 패널 포커스.

### Changed

- **확장(Nextify Review 패널):** 워크스페이스에 폴더가 없을 때·세션이 없을 때 안내 문구 구분. 동일 창에 `session.json` 후보가 여러 개면 step 번호 우선 선택 안내.

### Fixed

- **`migrate-next --help` 후행 예시:** `migrate-next steps` 설명을 실제 동작(레포트·Gemini 리뷰 미실행 등)과 일치하도록 수정.
- **`migrate-next step1 --review` 종료 안내:** Accept/Reject 언급 제거(view-only 패널과 일치).

## 0.1.2 — 2026-05-04

### Changed

- **프로젝트 루트 `.env` / `.env.local`:** `migrate-next` 실행 시 `process.cwd()` 기준으로 두 파일을 병합해 적용합니다 (파일 간 우선순위는 `.env.local` > `.env`). **셸/OS에 이미 있는 환경 변수는 건드리지 않습니다.** 그다음 패키지 옆 `__dirname/.env.local` 은 dotenv로 남은 키만 채웁니다.

## 0.1.1 — 2026-05-04

### Added

- **Nextify Review 확장 연동:** `migrate-next`(기본 오케스트레이터)에서 코드 리뷰 단계 진입 시 VS Code/Cursor에 Nextify Review 확장 설치 여부를 확인합니다.
- **선택적 자동 설치:** 확장이 없으면 “지금 설치할까요?” 확인 후 `code`/`cursor` CLI로 `capstone0123.nextify-review` 설치를 시도합니다. (`NEXTIFY_ASSUME_YES=1` 이면 확인 없이 설치 시도)
- **`migrate-next step1 --review`:** 동일한 확장 확인·포커스 흐름을 적용했습니다.
- 설치되어 있거나 설치에 성공하면 **Nextify Review 패널 포커스** 후 기존처럼 첫 diff를 엽니다.

### Fixed

- **`--list-extensions` 감지:** 마켓플레이스 형식(`publisher.nextify-review`)으로 설치된 확장을 CLI가 “미설치”로 잘못 보던 경우를 수정했습니다.

### Notes

- 에디터 CLI를 찾지 못하면 마켓플레이스 URL만 안내하고, diff는 기존과 같이 `--diff`로 열 수 있습니다.
- CLI 버전은 `package.json`의 `version`과 `migrate-next --version` 출력이 항상 일치합니다.

## 0.1.0

- 초기 npm 공개 버전 (기본 오케스트레이터, step1–7, Gemini 리뷰, 성능 레포트 등).
