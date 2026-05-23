'use strict';

const fs = require('fs-extra');
const path = require('path');
const { stopAndOfferGeminiApply } = require('../utils/manual-flow.cjs');

function toRel(projectRoot, absPath) {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

function hasUseClientDirective(content) {
  const head = content.split('\n').slice(0, 40).join('\n');
  return /^\s*['"]use client['"]\s*;?/m.test(head);
}

function hasClientDataFetchingPattern(content) {
  // 클라이언트 컴포넌트 내부 useEffect 기반 데이터 패칭 패턴 감지
  const hasEffect = /\buseEffect\s*\(/.test(content);
  const hasFetchLike =
    /\bfetch\s*\(/.test(content) ||
    /\baxios\.(get|post|put|patch|delete)\s*\(/.test(content) ||
    /\baxios\s*\(/.test(content) ||
    /\b\w+\.(get|post|put|patch|delete)\s*\(/.test(content);
  return hasEffect && hasFetchLike;
}

function isUnderHooksDir(relPath) {
  const n = relPath.replace(/\\/g, '/');
  return /\/hooks\//.test(n);
}

/**
 * 데이터 훅을 import 하는 src/** 파일 + app page 를 넓혀 Gemini 화이트리스트에 포함합니다.
 * (예: app/browse/page.tsx 는 훅을 직접 안 쓰고 pages/Browse 가 useMovies 를 쓰는 경우)
 */
async function expandDataFetchRelatedFiles(projectRoot, hookAbsPaths) {
  const bases = hookAbsPaths.map((h) => path.basename(h, path.extname(h)));
  const extra = new Set();
  const srcRoot = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcRoot)) return [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', '.git', 'dist', 'build'].includes(e.name)) continue;
        await walk(full);
      } else if (/\.(tsx|jsx)$/.test(e.name)) {
        let pc = '';
        try {
          pc = await fs.readFile(full, 'utf-8');
        } catch {
          continue;
        }
        for (const base of bases) {
          const safeBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const importRe = new RegExp(`from\\s+['"][^'"]*${safeBase}['"]`);
          if (importRe.test(pc)) {
            extra.add(toRel(projectRoot, full));
            break;
          }
        }
      }
    }
  }

  await walk(srcRoot);
  return [...extra];
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

async function optimizeDataFetchingPlacement(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!fs.existsSync(srcDir)) return;

  const sourceFiles = await collectSourceFiles(srcDir);
  const candidateAbsFiles = [];

  for (const absFilePath of sourceFiles) {
    let content = '';
    try {
      content = await fs.readFile(absFilePath, 'utf-8');
    } catch {
      continue;
    }

    const rel = toRel(projectRoot, absFilePath);
    if (!hasClientDataFetchingPattern(content)) continue;
    const allowHookWithoutDirective = isUnderHooksDir(rel);
    if (!hasUseClientDirective(content) && !allowHookWithoutDirective) continue;
    candidateAbsFiles.push(absFilePath);
  }

  if (candidateAbsFiles.length === 0) {
    return;
  }

  const relatedFiles = await expandDataFetchRelatedFiles(projectRoot, candidateAbsFiles);

  const candidateRelPaths = Array.from(
    new Set(
      candidateAbsFiles
        .map((p) => toRel(projectRoot, p))
        .concat(
          [
            'src/app/layout.tsx',
            'src/app/page.tsx',
            'src/app/loading.tsx',
            'src/app/error.tsx',
          ].filter((rel) => fs.existsSync(path.join(projectRoot, rel))),
        )
        .concat(relatedFiles),
    ),
  );

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `클라이언트 컴포넌트의 useEffect 기반 데이터 패칭이 ${candidateAbsFiles.length}개 파일에서 감지되었습니다.`,
    discoverySources: candidateRelPaths,
    instructionForAi: `Next.js App Router 최적화 작업입니다.

[작업 범위(매우 중요)]
이 작업의 유일한 목적은 "초기 데이터 로딩 전용"으로 사용된 useEffect+fetch 패턴을 서버 컴포넌트의 await fetch로 옮기는 것입니다.
파일에 있는 다른 hook(useState, useEffect, useRef, useMemo 등)은 절대 건드리지 마세요.

[절대 변경 금지(엄수)]
다음 항목은 한 글자도 추가/삭제/수정하지 마세요. 의심스러우면 그 파일을 원본 그대로 반환하세요.
- 데이터 패칭과 무관한 useState 호출과 그 setter (예: 모달 열림 상태, 폼 입력값, 토글, 탭 인덱스, hover/focus 상태, 에러 상태, 로딩 상태 중 UI 인터랙션용)
- 데이터 패칭과 무관한 useEffect (예: 이벤트 리스너 등록/해제, 타이머, 스크롤 위치, document.title, 외부 라이브러리 초기화, 디바운스/쓰로틀)
- useRef, useMemo, useCallback, useReducer, useContext, useLayoutEffect, useImperativeHandle, useTransition, useDeferredValue, useId 호출 일체
- 사용자 정의 hook(use로 시작) 호출 일체
- import 문 — 특히 'react'에서 가져오는 hook들은 사용 중인 한 절대 제거 금지
- JSX, props, 타입, 인터페이스, 이벤트 핸들러
- 주석, 빈 줄, 들여쓰기

[허용되는 변경(이것만 가능)]
1) "초기 데이터 로딩 전용" useEffect만 식별해서 서버 컴포넌트(page.tsx/layout.tsx)의 async 함수 본문에 await fetch로 이동
   - 식별 기준: 빈 의존성 배열([])이거나, mount 시 1회 fetch만 수행하고 결과를 useState로 저장하기만 하는 useEffect
2) 위 1번에 의해 더 이상 사용되지 않게 된 "데이터 저장용 useState"만 props로 대체
3) 서버에서 받은 데이터를 props로 전달하기 위한 최소한의 컴포넌트 시그니처 변경
4) 위 변경의 결과로 파일에서 더 이상 사용되지 않는 import만 제거 가능 (사용 중인 import는 절대 제거 금지)

[유지해야 하는 hook 패턴 — 절대 건드리지 마세요]
- 사용자 인터랙션 후 fetch (예: 버튼 클릭으로 호출, 검색어 입력으로 호출): 클라이언트에 그대로 둠
- 의존성 배열에 props/state가 있는 useEffect (예: \`useEffect(..., [id, query])\`): 클라이언트에 그대로 둠
- UI 상태 useState (loading, error, modalOpen, isHovered, formValues, currentTab 등): 그대로 유지
- 타이머/이벤트/observer를 다루는 useEffect: 그대로 유지

[Server Component 변환 시 안전 수칙 — \`dynamic(..., { ssr: false })\` 절대 금지]
- "use client" 가 제거되어 Server Component 가 되거나 새로 작성되는 파일(page.tsx/layout.tsx 등)에는 절대로 \`dynamic(..., { ssr: false })\` 호출이나 \`next/dynamic\` import 를 새로 추가하지 마세요. Next.js App Router 가 빌드를 거부합니다 ("ssr: false is not allowed with next/dynamic in Server Components").
- 변환 대상 파일에 이미 \`dynamic(..., { ssr: false })\` 가 있다면, 그 파일은 본질적으로 클라이언트 의존이 있다는 신호이므로 Server Component 변환 자체를 시도하지 말고 원본 그대로 반환하세요.
- 데이터 패칭을 Server Component 로 옮길 때 추가로 필요한 import 는 오직 (a) \`fetch\` 호출에 필요한 것뿐입니다. \`dynamic\`, \`next/dynamic\` 은 이 작업의 도구가 아닙니다.

[자기 검증 체크리스트 — 출력 직전에 반드시 수행]
각 파일에 대해 순서대로 점검. 하나라도 NO면 그 파일은 원본 그대로 반환하세요.
- [ ] 변경 후 파일에서 사용되는 모든 식별자(useState, useEffect, useRef, useMemo, useCallback 등)가 여전히 import 또는 선언되어 있는가?
- [ ] 원본에 있던 useState/useEffect 중 "데이터 패칭 전용"이 아닌 것들은 100% 그대로 남아있는가?
- [ ] JSX에서 참조하는 모든 변수/함수가 여전히 정의되어 있는가? (예: onClick={handleX}의 handleX가 여전히 있는가?)
- [ ] React import가 (사용 중이라면) 그대로 유지되는가? \`import { useState } from 'react'\`가 한 줄에 여러 hook을 가져온다면, 그 중 하나만 제거하고 나머지는 유지하는가?
- [ ] 'use client' 지시문은 hook이 남아있다면 그대로 유지되는가?
- [ ] 변경 결과 파일의 모든 모듈-스코프 \`let\`/\`const\`/\`var\` 선언과 import 식별자가 어딘가에서 최소 1회 이상 참조되는가? (TS \`noUnusedLocals\` 빌드 에러 방지: "declared but its value is never read")
- [ ] 자기-설명 주석("Moved to ...", "SSR-safe", "Intentional SSR-breaking" 등)을 추가하지 않았는가?

[좋은 예 — "데이터 fetch 전용" useEffect 이동]
원본 (page.tsx, 'use client' 사용):
\`\`\`
'use client';
import { useState, useEffect } from 'react';

export default function Page() {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }, []);
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
\`\`\`
수정 후(허용):
\`\`\`
export default async function Page() {
  const users = await fetch('/api/users').then(r => r.json());
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
\`\`\`

[나쁜 예 — 절대 이렇게 하지 마세요]
원본:
\`\`\`
'use client';
import { useState, useEffect } from 'react';

export default function Page() {
  const [users, setUsers] = useState([]);
  const [open, setOpen] = useState(false);  // UI 상태
  useEffect(() => {
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }, []);
  useEffect(() => {                         // 이벤트 리스너
    const handler = () => setOpen(false);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>}
    </>
  );
}
\`\`\`
잘못된 수정(금지 — UI useState와 이벤트 리스너 useEffect까지 삭제됨):
\`\`\`
export default async function Page() {
  const users = await fetch('/api/users').then(r => r.json());
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
\`\`\`
이 경우 올바른 동작: 이 파일은 UI useState와 이벤트 리스너 useEffect를 가지므로 "use client"와 모든 hook을 그대로 두고, 파일 자체를 변경하지 마세요. 데이터 패칭만 분리할 수 없다면 원본 그대로 반환하세요.

[불확실할 때의 기본 동작]
- 데이터 패칭과 다른 hook 로직이 섞여 있어 안전하게 분리할 수 없다면 원본을 그대로 반환하세요.
- 변경할 파일이 하나도 없다면 \`{"files":[]}\`로 반환해도 됩니다.
- 절대 "리팩터링 김에" hook을 정리하거나 단순화하지 마세요.

[출력 형식]
- 변경한 파일만 files 배열에 포함.
- 새 파일 생성 금지.
- TODO, FIXME, NOTE 등 주석 추가 금지.
`,
    candidateRelPaths,
  });
}

module.exports = {
  optimizeDataFetchingPlacement,
};

