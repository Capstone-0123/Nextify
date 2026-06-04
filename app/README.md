# Nextify CLI

> **사용 후기를 들려주세요.** Nextify를 사용해 보셨다면 짧은 설문으로 피드백을 남겨 주세요: [Nextify 사용성 설문조사](https://docs.google.com/forms/d/e/1FAIpQLScxEmaxyoaTxNcMeyLFpK3XEATOurYamMPRqyQN3G2HnuKrag/viewform?usp=sharing&ouid=109629042614252569123)

React(Vite) + TypeScript SPA 프로젝트를 Next.js App Router 프로젝트로 마이그레이션하는 CLI입니다.

## 설치

매번 최신 버전으로 실행하려면 `npx`를 권장합니다.

```bash
npx nextify-cli@latest
```

전역 설치 후 `migrate-next` 명령으로 사용할 수도 있습니다.

```bash
npm install -g nextify-cli
migrate-next --help
```

## 마이그레이션 전 준비

마이그레이션을 시작하기 전에 대상 프로젝트 루트에 `.env` 또는 `.env.local` 파일을 만들고 Gemini API Key를 설정하세요.

```bash
GEMINI_API_KEY=your_gemini_api_key_here
```

예시:

```text
your-vite-project/
├─ .env
├─ package.json
├─ vite.config.ts
└─ src/
```

Nextify는 `migrate-next`를 실행한 현재 프로젝트 루트의 `.env`, `.env.local`을 읽습니다. 두 파일이 모두 있으면 `.env.local` 값이 우선됩니다.

Gemini API Key는 AI 리뷰, 수동 처리 후보 안내, 일부 보조 수정 흐름에 사용됩니다. 키가 없으면 마이그레이션 중간에 안내 후 중단될 수 있습니다.

## 요구 사항

- Node.js `18.18` 이상
- React + Vite 기반 SPA 프로젝트
- TypeScript 프로젝트 권장
- 프로젝트 루트에 `package.json`이 있어야 합니다.

## 권장 사용 환경

Nextify는 VS Code 또는 Cursor에서 마이그레이션 대상 프로젝트를 열고, 해당 에디터의 통합 터미널에서 실행하는 환경에 가장 적합합니다.

CLI 마이그레이션 자체는 일반 터미널에서도 실행할 수 있지만, 변경 파일을 트리와 diff로 확인하는 리뷰 기능은 VS Code/Cursor용 **Nextify Review** 확장이 필요합니다.

- 확장 ID: `capstone0123.nextify-review`
- Marketplace: [Nextify Review](https://marketplace.visualstudio.com/items?itemName=capstone0123.nextify-review)
- CLI가 생성하는 `.ai-migration/<step>/session.json`을 확장이 읽어서 변경 파일 목록과 diff를 보여줍니다.

확장이 설치되어 있지 않아도 마이그레이션은 진행할 수 있습니다. 다만 `migrate-next review` 또는 마이그레이션 후 diff 리뷰 패널을 사용하려면 확장을 설치해야 합니다.

## 빠른 시작

마이그레이션할 Vite 프로젝트 루트에서 실행합니다.

```bash
cd your-vite-project
npx nextify-cli@latest
```

기본 실행은 다음 흐름으로 진행됩니다.

```text
원본 프로젝트 확인
→ 복사본 생성 또는 현재 폴더 적용 선택
→ step1~step5 기본 마이그레이션
→ TypeScript 검증
→ 성능 비교용 스냅샷 생성
→ 다음 명령 안내
```

복사 모드를 선택하면 원본은 유지하고 `<project-name>-nextified` 폴더에서 변환을 진행합니다.

## 주요 명령어

```bash
# 기본 마이그레이션: step1~step5 + TypeScript 검증
migrate-next

# Next.js 심화 변환: image/font/dynamic import/data fetching/use client 최소화 등
migrate-next advanced

# 성능 비교 레포트 생성
migrate-next report

# 기존 마이그레이션 세션으로 코드 리뷰 실행
migrate-next review

# Gemini API 기반 질문 또는 제한적 파일 패치
migrate-next ask -q "마이그레이션 오류 원인을 설명해줘"
```

## 마이그레이션 구성

기본 마이그레이션은 `migrate-next`에서 실행되며 step1~step5로 구성됩니다.

- `step1`: Next.js 의존성, Vite 설정, env, tsconfig, 출력 제외 설정 정리
- `step2`: `index.html` 기반 구조를 `src/app/layout.tsx`와 providers 구조로 변환
- `step3`: React Router 라우팅을 Next.js App Router 구조로 변환
- `step4`: global CSS, 정적 리소스, Tailwind, styled-components 설정 정리
- `step5`: `"use client"`, 브라우저 API, Zustand SSR 안정성 보정

심화 변환은 `migrate-next advanced`에서 실행되며 내부적으로 step6를 사용합니다.

- `step6`: image, font, dynamic import, data fetching, use client 최소화, cleanup 등 Next.js 최적화 변환

## TypeScript 검증

마이그레이션 후 TypeScript 검증을 실행합니다.

- 로컬 `node_modules/.bin/tsc`가 없으면 감지된 패키지 매니저로 의존성 설치를 먼저 시도합니다.
- 설치/검증 실행이 실패하면 의존성 재설치 가이드를 출력합니다.
- 타입 오류가 남으면 가능한 범위에서 결정론적 자동 수정과 AI 보조 수정을 시도합니다.

## 성능 레포트

`migrate-next report`는 Vite 원본, 기본 마이그레이션 결과, advanced 이후 결과를 비교하는 성능 레포트를 생성합니다.

```bash
migrate-next report
```

필요하면 원본 Vite 프로젝트 경로를 직접 지정할 수 있습니다.

```bash
migrate-next report --baseline ../original-vite-project
```

## AI와 리뷰 기능

Nextify는 일부 수동 처리 후보를 안내하고, 선택적으로 Gemini 기반 보조 기능을 사용할 수 있습니다.

- `GEMINI_API_KEY`: Gemini API 기반 `ask` 명령에 사용
- `gemini` CLI: 마이그레이션 diff 리뷰 세션에 사용
- VS Code/Cursor에서 Nextify Review 확장을 통해 `.ai-migration` diff를 확인할 수 있습니다.

## 지원 범위

권장 대상:

- React
- Vite
- TypeScript
- SPA
- React Router 기반 프로젝트

취약하거나 수동 확인이 필요한 경우:

- `createBrowserRouter`
- `useRoutes`
- TanStack Router
- CRA
- webpack
- JS-only 프로젝트
- monorepo, Nx, Turbo, pnpm workspace
- 동적 provider composition
- 복잡한 metadata 로직

## 주의 사항

- 마이그레이션 전 Git 커밋 또는 백업을 권장합니다.
- copy 모드를 사용하면 원본 프로젝트를 보존할 수 있습니다.
- 자동 변환이 어려운 코드는 수동 처리 가이드가 출력될 수 있습니다.
- 마이그레이션 후에는 `npm run build` 또는 해당 패키지 매니저의 build 명령으로 직접 확인하세요.

## 패키지 정보

- npm package: `nextify-cli`
- binary: `migrate-next`
- repository: [Capstone-0123/Nextify](https://github.com/Capstone-0123/Nextify)
- license: MIT
