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

    if (!hasUseClientDirective(content)) continue;
    if (!hasClientDataFetchingPattern(content)) continue;
    candidateAbsFiles.push(absFilePath);
  }

  if (candidateAbsFiles.length === 0) {
    return;
  }

  const candidateRelPaths = Array.from(
    new Set(
      candidateAbsFiles.map((p) => toRel(projectRoot, p)).concat(
        [
          'src/app/layout.tsx',
          'src/app/page.tsx',
          'src/app/loading.tsx',
          'src/app/error.tsx',
        ].filter((rel) => fs.existsSync(path.join(projectRoot, rel)))
      )
    )
  );

  await stopAndOfferGeminiApply({
    projectRoot,
    discoveryLine: `클라이언트 컴포넌트의 useEffect 기반 데이터 패칭이 ${candidateAbsFiles.length}개 파일에서 감지되었습니다.`,
    instructionForAi: `Next.js App Router 최적화 작업입니다.

목표:
- useEffect/클라이언트 fetch를 가능한 범위에서 서버 컴포넌트 fetch(예: page/layout의 await fetch)로 이동하세요.
- SEO/초기 렌더를 개선하고, 불필요한 "use client"를 줄이세요.

작업 지침:
1) 데이터 패칭 위치 최적화
   - 데이터 fetch/가공/정적 렌더만 하는 코드는 서버 컴포넌트로 이동하세요.
   - 서버에서 가져온 데이터를 클라이언트 상호작용 컴포넌트에 props로 전달하세요.
2) 클라이언트 경계 축소
   - 훅/이벤트/브라우저 API가 필요한 최소 leaf 컴포넌트에만 "use client"를 남기세요.
   - 부모 page/layout의 "use client"는 제거 가능한지 우선 검토하세요.
3) 안정성
   - 기존 동작을 보존하세요.
   - 타입/문법 오류 없이 빌드 가능한 코드로 유지하세요.
   - 불필요한 TODO 주석을 추가하지 마세요.
4) 파일 제약
   - 제공된 파일 범위 안에서만 수정하세요.
   - 새 파일 생성 없이 기존 파일 구조에서 리팩터링하세요.
`,
    candidateRelPaths,
  });
}

module.exports = {
  optimizeDataFetchingPlacement,
};

