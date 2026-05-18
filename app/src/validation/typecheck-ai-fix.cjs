'use strict';

// app/src/validation/typecheck-ai-fix.cjs
// 결정론적 autofix 가 못 잡은 잔여 TypeScript 에러를 Gemini 로 1회 보정.
// 핵심 원칙:
//   - "효율적 AI 재호출": 파일당 최대 1회, 좁은 컨텍스트, 토큰 예산 제한
//   - 무한 루프 금지: 호출 횟수 캡 (DEFAULT_AI_FIX_BUDGET)
//   - 자기 검증·롤백: 호출 후 tsc 재실행으로 회귀 감지 시 백업으로 복구
//   - 안전망: post-ai-sweep 가 runAskApply 안에서 자동 호출되어 메타-주석/dead code 정리
//   - best-effort: 실패가 마이그레이션 흐름을 막지 않음

const fs = require('fs-extra');
const path = require('path');
const { runAskApply } = require('../utils/ai-file-apply.cjs');
const {
  detectBuildTool,
  detectLanguage,
  detectPackageManager,
} = require('../utils/project-info.cjs');

// 파일당 1회만 호출하며, 한 세션에서 처리할 최대 파일 수
const DEFAULT_AI_FIX_BUDGET = 5;

// 너무 큰 파일은 한 번 보낼 때 토큰이 폭증하므로 skip (필요 시 옵션화)
const MAX_FILE_BYTES_FOR_AI = 30_000;

// ---- 6섹션 안전 편집 지침 -------------------------------------------------
// 모든 단계의 Gemini 프롬프트와 동일한 6섹션 템플릿.
// hook 보존, dead code 금지, 자기-설명 주석 금지, 불확실 시 빈 응답.

const SAFE_EDIT_INSTRUCTION = `[작업 범위(매우 중요)]
- 아래 [TypeScript 에러 목록]에 명시된 에러만 해결한다.
- 그 외 코드는 일체 수정·재구성·정리하지 않는다.
- 한 번의 응답에서 같은 파일을 여러 번 변경하지 않는다 (응답에는 파일이 1개만 포함된다).

[절대 변경 금지(엄수)]
- 다음 React/Next hook 식별자의 사용·이름·import 는 절대 변경/제거하지 않는다:
  useState, useEffect, useLayoutEffect, useInsertionEffect, useReducer, useRef,
  useMemo, useCallback, useImperativeHandle, useSyncExternalStore, useTransition,
  useDeferredValue, useId, useContext,
  useRouter, useSearchParams, usePathname, useParams,
  useSelectedLayoutSegment, useSelectedLayoutSegments,
  그리고 use 로 시작하는 모든 사용자 정의 hook.
- 컴포넌트의 export, default export, props 시그니처를 바꾸지 않는다.
- 비즈니스 로직, 분기, JSX 구조, useEffect 종속성 배열을 임의로 바꾸지 않는다.
- "use client" 지시문을 추가하거나 제거하지 않는다.
- 외부 라이브러리 import 를 임의로 교체하지 않는다 (필요한 경우 누락된 import 만 추가).

[허용되는 변경(이것만 가능)]
- 미사용 변수/매개변수/구조분해: 식별자 앞에 _ 추가 (예: searchParams → _searchParams)
- 미사용 import: 안전한 모듈(react, react-dom, next/*, ./, ../, @/) 한정으로 제거
- 누락된 React/Next 표준 식별자: 정확한 모듈에서 import 만 추가
- null/undefined 가능 표현식: 가장 좁은 범위에서 ?? 기본값 또는 ? optional chaining 추가
- implicit any 파라미터: 가능한 경우 명시적 타입 추가 (확신 없으면 손대지 않는다)
- 위 [TypeScript 에러 목록] 에 적힌 위치만 손댄다. 그 외는 손대지 않는다.

[자기 검증 체크리스트] (응답 직전 점검)
- 변경된 줄 수가 에러 개수의 2배를 넘지 않는다.
- 새로 추가하거나 제거한 식별자가 모두 import/선언으로 연결된다.
- React/Next hook 이름과 호출이 그대로다.
- 자기-설명 주석을 추가하지 않았다 (// SSR-safe, // browser only, // moved to useEffect, // intentional ssr-breaking 금지).
- "무엇을 바꿨는지"를 주석으로 설명하지 않았다.
- 파일 길이의 변동이 에러 처리에 비해 합리적이다.

[좋은 예]
function Page({ searchParams }: Props) {}
→ function Page({ searchParams: _searchParams }: Props) {}

import { useState, useEffect } from 'react';  // useState 는 미사용
→ import { useEffect } from 'react';

const params = useParams();  // params 가 null 가능
→ const params = useParams() ?? {};

[나쁜 예]
- 미사용 변수를 발견했다고 useEffect 를 같이 지움 → 절대 금지
- 빌드 에러와 무관한 코드를 "정리" → 절대 금지
- // Removed unused parameter, // Fixed type error 같은 주석 추가 → 금지
- "use client" 추가/제거 → 금지

[불확실할 때의 기본 동작]
- 100% 확신이 없으면 그 파일은 변경하지 말고 정확히 다음 빈 응답을 반환한다.
{"files":[]}
`;

function buildPerFileInstruction(relPath, fileErrors) {
  const errLines = fileErrors
    .map(
      (e) =>
        `- [${e.code}] ${relPath}:${e.line}:${e.column} — ${e.message}`,
    )
    .join('\n');

  return `다음 파일의 TypeScript 빌드 에러만 해결해주세요.

[대상 파일]
${relPath}

[TypeScript 에러 목록]
${errLines}

${SAFE_EDIT_INSTRUCTION}`;
}

function getProjectContext(projectRoot) {
  return {
    buildTool: detectBuildTool(projectRoot),
    language: detectLanguage(projectRoot),
    packageManager: detectPackageManager(projectRoot),
  };
}

function countByFile(errors) {
  const m = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    m.set(e.file, (m.get(e.file) || 0) + 1);
  }
  return m;
}

/**
 * 결정론으로 못 잡은 잔여 에러를 파일 단위로 AI 에 1회씩 의뢰.
 * - 파일당 1회만 호출 (재시도 없음, 무한 루프 방지)
 * - 호출 전 백업을 보관해 호출자(typecheck-report)가 회귀 발견 시 롤백할 수 있게 함
 * - 너무 큰 파일은 토큰 비용을 이유로 skip
 *
 * @param {string} projectRoot
 * @param {Array<{ file, line, column, code, message }>} errors
 * @param {{ budget?: number }} [options]
 * @returns {Promise<{
 *   ran: boolean,
 *   reason?: string,
 *   filesAttempted: Array<{ file: string, errorCount: number, backup: string }>,
 *   filesChanged: string[],
 *   skipped: Array<{ file: string, reason: string, size?: number }>,
 *   budget: number,
 * }>}
 */
async function aiFixRemainingErrors(projectRoot, errors, options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      ran: false,
      reason: 'no_api_key',
      filesAttempted: [],
      filesChanged: [],
      skipped: [],
      budget: 0,
    };
  }

  const budget = Math.max(1, Number(options.budget) || DEFAULT_AI_FIX_BUDGET);

  const byFile = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    const arr = byFile.get(e.file) || [];
    arr.push(e);
    byFile.set(e.file, arr);
  }

  // 우선순위: 에러 수가 많은 파일 먼저 (한 번 호출로 효과 최대화)
  const ordered = [...byFile.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  const context = getProjectContext(projectRoot);
  const filesAttempted = [];
  const filesChanged = [];
  const skipped = [];

  for (const [relFile, fileErrors] of ordered) {
    if (filesAttempted.length >= budget) {
      skipped.push({ file: relFile, reason: 'budget_exhausted' });
      continue;
    }

    const absPath = path.join(projectRoot, relFile);
    if (!(await fs.pathExists(absPath))) {
      skipped.push({ file: relFile, reason: 'missing' });
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      skipped.push({ file: relFile, reason: 'stat_error' });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES_FOR_AI) {
      skipped.push({ file: relFile, reason: 'too_large', size: stat.size });
      continue;
    }

    let backup;
    try {
      backup = await fs.readFile(absPath, 'utf8');
    } catch {
      skipped.push({ file: relFile, reason: 'read_error' });
      continue;
    }

    filesAttempted.push({
      file: relFile,
      errorCount: fileErrors.length,
      backup,
    });

    const question = buildPerFileInstruction(relFile, fileErrors);
    try {
      const written = await runAskApply({
        projectRoot,
        question,
        filesCsv: relFile,
        context,
      });
      if (Array.isArray(written) && written.length > 0) {
        filesChanged.push(relFile);
      }
    } catch {
      // AI 호출 실패는 파일 미변경으로 간주. 백업은 유지(필요 시 호출자가 사용).
    }
  }

  return {
    ran: true,
    filesAttempted,
    filesChanged,
    skipped,
    budget,
  };
}

/**
 * AI 호출 후 에러가 더 늘어난 파일을 백업으로 롤백.
 * - 단순 비교: after 의 에러 카운트가 before 보다 크면 회귀로 본다.
 * - 같은 카운트는 변경 의도가 있을 수 있으니 보존 (예: 일부 해결 + 다른 코드 보강).
 * - best-effort: 쓰기 실패는 조용히 무시.
 *
 * @param {string} projectRoot
 * @param {Array<{ file: string, errorCount: number, backup: string }>} filesAttempted
 * @param {Array} errorsBefore - AI 호출 전 잔여 에러 (tsc 2차 결과)
 * @param {Array} errorsAfter  - AI 호출 후 에러 (tsc 3차 결과)
 * @returns {Promise<Array<{ file: string, before: number, after: number }>>}
 */
async function rollbackRegressions(
  projectRoot,
  filesAttempted,
  errorsBefore,
  errorsAfter,
) {
  const beforeByFile = countByFile(errorsBefore);
  const afterByFile = countByFile(errorsAfter);

  const rolledBack = [];

  for (const att of Array.isArray(filesAttempted) ? filesAttempted : []) {
    const before = beforeByFile.get(att.file) || 0;
    const after = afterByFile.get(att.file) || 0;
    if (after > before) {
      try {
        await fs.writeFile(
          path.join(projectRoot, att.file),
          att.backup,
          'utf8',
        );
        rolledBack.push({ file: att.file, before, after });
      } catch {
        // best-effort
      }
    }
  }

  return rolledBack;
}

module.exports = {
  aiFixRemainingErrors,
  rollbackRegressions,
  DEFAULT_AI_FIX_BUDGET,
  MAX_FILE_BYTES_FOR_AI,
};
