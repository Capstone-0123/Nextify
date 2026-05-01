'use strict';

const fs = require('fs-extra');
const path = require('path');
const { stopAndOfferGeminiApply } = require('../utils/manual-flow.cjs');

function toRel(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

function hasUseClientDirective(content) {
  const head = content.split('\n').slice(0, 30).join('\n');
  return /^\s*['"]use client['"]\s*;?/m.test(head);
}

function requiresClientBoundary(content, relPath = '') {
  const normalizedRel = relPath.replace(/\\/g, '/');

  // App Router entry files are server-first by design.
  if (/^src\/app\/.*\/(page|layout)\.(t|j)sx?$/.test(normalizedRel)) {
    return false;
  }

  // React client hooks and Next client hooks.
  if (/\buse(State|Effect|LayoutEffect|InsertionEffect|Reducer|Ref|Memo|Callback|ImperativeHandle|SyncExternalStore|Transition|DeferredValue|Id)\s*\(/.test(content)) {
    return true;
  }
  if (/\buseRouter\s*\(/.test(content) || /\buseSearchParams\s*\(/.test(content) || /\busePathname\s*\(/.test(content) || /\buseSelectedLayoutSegment(s)?\s*\(/.test(content)) {
    return true;
  }

  // Browser-only APIs.
  if (/\bwindow\b|\bdocument\b|\blocalStorage\b|\bsessionStorage\b|\bnavigator\b|\bmatchMedia\b|\bIntersectionObserver\b|\bResizeObserver\b|\bMutationObserver\b/.test(content)) {
    return true;
  }

  // Event handlers in JSX usually mean interactive client component.
  if (/\son[A-Z][A-Za-z0-9_]*\s*=/.test(content)) {
    return true;
  }

  return false;
}

async function collectSourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '.git', 'dist', 'build'].includes(entry.name)) {
        continue;
      }
      out.push(...(await collectSourceFiles(fullPath)));
      continue;
    }

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }

  return out;
}

async function minimizeUseClientForBundle(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  const sourceFiles = await collectSourceFiles(srcDir);
  const useClientFiles = [];

  for (const absFilePath of sourceFiles) {
    let content = '';
    try {
      content = await fs.readFile(absFilePath, 'utf-8');
    } catch {
      continue;
    }
    if (hasUseClientDirective(content)) {
      useClientFiles.push(absFilePath);
    }
  }

  if (useClientFiles.length === 0) {
    return;
  }

  const candidateRelPaths = Array.from(
    new Set(
      useClientFiles.map((p) => toRel(projectRoot, p))
    )
  );

  const removableCandidateRelPaths = [];
  const protectedClientRelPaths = [];

  for (const relPath of candidateRelPaths) {
    const absPath = path.join(projectRoot, relPath);
    let content = '';
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    if (requiresClientBoundary(content, relPath)) {
      protectedClientRelPaths.push(relPath);
      continue;
    }
    removableCandidateRelPaths.push(relPath);
  }

  if (removableCandidateRelPaths.length === 0) {
    return;
  }

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `"use client" 지시문이 ${useClientFiles.length}개 파일에서 발견되었습니다. JS 번들 최적화를 위해 최소화가 필요합니다.`,
    discoverySources: removableCandidateRelPaths,
    instructionForAi: `Next.js App Router 최적화 작업입니다.

[작업 범위(매우 중요)]
이 작업의 유일한 목적은 "use client" 지시문(파일 최상단의 'use client' 또는 "use client" 한 줄)을 제거 가능한 파일에서만 제거하는 것입니다.
파일의 다른 어떤 코드도 변경/삭제/추가/리팩터링해서는 안 됩니다.

[절대 변경 금지(엄수)]
다음 항목은 한 글자도 추가/삭제/수정하지 마세요. 발견되면 그 파일은 그대로 둡니다(원본 그대로 반환).
- import / export 문 (특히 'react'에서 가져오는 useState, useEffect, useLayoutEffect, useInsertionEffect, useRef, useMemo, useCallback, useReducer, useContext, useImperativeHandle, useSyncExternalStore, useTransition, useDeferredValue, useId 등 모든 hook import)
- 'next/navigation', 'next/router'에서 가져오는 useRouter, useSearchParams, usePathname, useSelectedLayoutSegment(s) 등 hook import
- 모든 hook 호출 (useState(...), useEffect(...), useRef(...) 등)
- 사용자 정의 hook (use로 시작하는 함수) 호출 및 import
- 함수/컴포넌트 본문, JSX, props, 타입, 인터페이스, 상수, 헬퍼 함수
- 주석, 빈 줄, 들여쓰기, 따옴표 종류, 세미콜론 유무
- 파일 인코딩과 줄바꿈(LF/CRLF)

[허용되는 변경(이것만 가능)]
- 파일 최상단의 'use client' 또는 "use client" 지시문 한 줄 + (있다면) 그 직후의 빈 줄 1개를 삭제

[제거 가능 여부 판정 — 모두 만족해야 함]
다음 중 하나라도 파일 본문에 존재하면 "use client"를 절대 제거하지 마세요(원본 그대로 반환):
1) React/Next client hook 호출: useState, useEffect, useLayoutEffect, useInsertionEffect, useReducer, useRef, useMemo, useCallback, useImperativeHandle, useSyncExternalStore, useTransition, useDeferredValue, useId, useRouter, useSearchParams, usePathname, useSelectedLayoutSegment(s)
2) 사용자 정의 hook 호출(이름이 use로 시작하고 함수 호출인 모든 식별자, 예: useAuth(), useStore(), useTheme())
3) 브라우저 전용 API 참조: window, document, localStorage, sessionStorage, navigator, location, history, matchMedia, IntersectionObserver, ResizeObserver, MutationObserver, requestAnimationFrame, addEventListener
4) JSX 이벤트 핸들러 속성: onClick, onChange, onInput, onSubmit, onKeyDown, onKeyUp, onMouseEnter, onMouseLeave, onFocus, onBlur 등 on[A-Z]로 시작하는 모든 핸들러
5) 클라이언트 전용 라이브러리: zustand의 create, recoil, jotai, react-query/tanstack-query의 useQuery/useMutation, swr, framer-motion, react-hook-form, react-spring 등
6) Context Provider 내부에서 상태/이펙트를 다루는 컴포넌트
7) Class component가 lifecycle 메서드(componentDidMount 등)를 가진 경우

[자기 검증 체크리스트 — 출력 직전에 반드시 수행]
각 파일에 대해 다음을 순서대로 점검하고, 하나라도 NO면 그 파일은 원본 content를 그대로 반환하세요.
- [ ] 변경 후 파일에서 사용되는 모든 식별자(특히 useState, useEffect 등)가 여전히 import 또는 선언되어 있는가?
- [ ] import 줄의 개수와 모든 named import가 원본과 100% 동일한가? (예: 원본이 \`import { useState, useEffect } from 'react'\` 였으면 그대로 유지)
- [ ] 함수 본문, JSX, return 문이 원본과 완벽히 동일한가?
- [ ] 변경 사항이 오직 'use client' 지시문 한 줄 삭제뿐인가?
- [ ] 파일 줄 수가 원본 대비 1~2줄만 줄었는가? (3줄 이상 줄었다면 과잉 삭제이므로 금지)
- [ ] 모듈-스코프 \`let\`/\`const\`/\`var\` 선언과 import 식별자 모두가 여전히 어딘가에서 최소 1회 이상 참조되는가? (TS \`noUnusedLocals\` 빌드 에러 방지)

[좋은 예]
원본:
\`\`\`
'use client';

export default function Card({ title }: { title: string }) {
  return <div>{title}</div>;
}
\`\`\`
수정 후(허용):
\`\`\`
export default function Card({ title }: { title: string }) {
  return <div>{title}</div>;
}
\`\`\`

[나쁜 예 — 절대 이렇게 하지 마세요]
원본:
\`\`\`
'use client';
import { useState, useEffect } from 'react';

export default function Counter() {
  const [n, setN] = useState(0);
  useEffect(() => { setN(1); }, []);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
\`\`\`
잘못된 수정(금지 — 이 파일은 hook 사용 중이므로 'use client'를 그대로 두어야 함):
\`\`\`
export default function Counter() {
  return <button>0</button>;
}
\`\`\`
이 경우 올바른 동작: 파일을 원본 그대로 반환(변경 없음).

[불확실할 때의 기본 동작]
- 어떤 파일에 대해 제거 가능 여부가 100% 명확하지 않으면 원본 content를 그대로 반환하세요.
- 변경할 파일이 하나도 없다면 \`{"files":[]}\`로 반환해도 됩니다(권장).
- "최소화" 목적으로 hook이나 다른 코드를 함께 정리하지 마세요. 그것은 이 작업의 범위가 아닙니다.

[출력 형식]
- 변경한 파일만 files 배열에 포함하세요(원본과 동일한 파일은 굳이 포함하지 않아도 됩니다).
- 새 파일 생성 금지. 기존 파일 경로만 사용.
- TODO, FIXME, NOTE 등 주석 추가 금지.
`,
    manualFallback: `수동 처리 필요: "use client"를 실제로 필요한 leaf 컴포넌트에만 남기고, 불필요한 파일에서는 제거/경계 분리를 해주세요.\n- 제외(클라이언트 필요) 파일 수: ${protectedClientRelPaths.length}\n- 후보 파일(일부): ${removableCandidateRelPaths
      .slice(0, 20)
      .join(', ')}${removableCandidateRelPaths.length > 20 ? ' ...' : ''}\n- 빌드/런타임이 깨지지 않는지 검증하세요.`,
    candidateRelPaths: removableCandidateRelPaths,
  });
}

module.exports = {
  minimizeUseClientForBundle,
};

