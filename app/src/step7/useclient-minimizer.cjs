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
      useClientFiles.map((p) => toRel(projectRoot, p)).concat(
        ['src/app/layout.tsx', 'src/app/page.tsx'].filter((rel) =>
          fs.existsSync(path.join(projectRoot, rel))
        )
      )
    )
  );

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `"use client" 지시문이 ${useClientFiles.length}개 파일에서 발견되었습니다. JS 번들 최적화를 위해 최소화가 필요합니다.`,
    instructionForAi: `Next.js App Router 최적화 작업입니다.

목표:
- 초기 JS 번들 크기를 줄이기 위해 "use client" 지시문을 최소화하세요.
- Step5에서 추가된 use client를 재검토해서, 실제로 클라이언트 실행이 필요한 파일에만 남기세요.

최적화 원칙:
1) 서버 컴포넌트 우선: 데이터 fetch/가공/정적 렌더만 하는 파일은 "use client"를 제거하세요.
2) 클라이언트 로직 분리: Hook/이벤트/브라우저 API가 필요한 부분만 작은 하위 컴포넌트로 분리하고, 그 파일에만 "use client"를 유지하세요.
3) 경계 축소: 부모 page/layout까지 "use client"를 붙이지 말고, leaf 컴포넌트만 클라이언트로 두세요.
4) 상태관리 파일 검토: store, interactive widget처럼 클라이언트 실행이 꼭 필요한 파일에만 "use client"를 유지하세요.

작업 규칙:
1) 아래 대상 파일들에서 "use client"를 제거해도 되는 파일은 제거하세요.
   - React Hook(useState/useEffect/useLayoutEffect/useRef 등), 브라우저 API(window/document/localStorage), 이벤트 핸들러(onClick 등), 클라이언트 전용 라이브러리 사용이 없으면 제거 후보입니다.
2) 클라이언트 전용 로직이 반드시 필요한 파일은 "use client"를 유지하세요.
3) 불필요한 TODO 주석을 추가하지 마세요.
4) 기존 동작을 보존하고, 서버/클라이언트 경계를 깨지 않도록 안전하게 수정하세요.
5) 새 파일 생성 없이 현재 파일들만 수정하세요.
`,
    candidateRelPaths,
  });
}

module.exports = {
  minimizeUseClientForBundle,
};

