# Nextify
React to Next migration 자동화 CLI 툴 'Nextify' 개발 레포지토리입니다.

0) 사전 준비
- 기본 오케스트레이터(`migrate-next`)의 AI 리뷰는 Gemini CLI(`gemini`)를 사용합니다.
- 기본 오케스트레이터는 리뷰 직전에 Gemini CLI 설치 여부를 확인하고, 없으면 자동 설치를 시도합니다.
- 자동 설치 실패 시 수동 설치 후 재실행하세요: `npm install -g @google/gemini-cli` (또는 `yarn global add @google/gemini-cli`, `pnpm add -g @google/gemini-cli`)
- 기본 오케스트레이터는 step1~7을 한 번에 실행한 뒤, 최종 **Gemini CLI 대화형 리뷰(view-only)**와 **성능 레포트 생성**까지 한 번에 진행합니다.
- 기본 레포트 파일은 `nextify-performance-report.md` 로 생성됩니다.
- Nextify Review 패널은 트리/diff 확인 및 선택 파일의 before/after 경로 복사 기능을 제공합니다.

1) 테스트(실행) 명령어들
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
Extension 쪽은 “명령어 테스트”라기보다 VSCode/Cursor에서 확장 실행을 확인합니다.

app/extension/README.md 기준으로 F5로 Extension Development Host 띄우고, 실제 프로젝트 루트에서 migrate-next(기본) 또는 migrate-next step1 --review를 실행한 뒤 Nextify Review 패널에서 트리/diff 확인 및 before/after 경로 복사를 확인합니다.
Extension 내부 커맨드는 nextifyReview.refreshSession, nextifyReview.openChange, nextifyReview.copySessionPath, nextifyReview.copyBeforePath, nextifyReview.copyAfterPath 입니다.

