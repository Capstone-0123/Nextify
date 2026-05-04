'use strict';

// app/src/step7/typecheck-autofix.cjs
// Step7 끝의 typecheck 결과를 받아 결정론적(LLM 호출 없는) 자동 수정을 수행.
// - 토큰 비용 0
// - 화이트리스트 코드만 수정 (오작 위험을 최소화)
// - idempotent: 이미 처리된 코드를 다시 건드리지 않음
// - best-effort: 수정 실패가 마이그레이션을 막지 않음

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');

// ---- 화이트리스트 ---------------------------------------------------------

// "declared but never read/used" 계열
const UNUSED_DECL_CODES = new Set([
  'TS6133', // 'X' is declared but its value is never read.
  'TS6138', // Property 'X' is declared but its value is never read.
  'TS6196', // 'X' is declared but never used.
]);

// "All imports in import declaration are unused" — import 문 전체 제거 안전군에 한정
const UNUSED_ALL_IMPORTS_CODE = 'TS6192';

// "Cannot find name 'X'" — 표준 식별자에 한해서만 자동 import 추가
const CANNOT_FIND_CODE = 'TS2304';

const AUTOFIXABLE_CODES = new Set([
  ...UNUSED_DECL_CODES,
  UNUSED_ALL_IMPORTS_CODE,
  CANNOT_FIND_CODE,
]);

// ---- import 안전성 판정 ---------------------------------------------------

/**
 * 안전하게 제거 가능한 import 모듈인가?
 * - react / react-dom / next/* : 부수 효과 없음
 * - 로컬 경로 ('./', '../', '@/') : 마이그레이션 대상 자기 코드
 * 그 외(예: 'reset.css', 외부 사이드이펙트 패키지)는 제거하지 않는다.
 */
function isSafeImportSource(spec) {
  if (!spec || typeof spec !== 'string') return false;
  if (spec === 'react' || spec === 'react-dom') return true;
  if (spec.startsWith('react/') || spec.startsWith('react-dom/')) return true;
  if (spec === 'next' || spec.startsWith('next/')) return true;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  if (spec.startsWith('@/')) return true;
  return false;
}

// ---- TS2304 자동 import 화이트리스트 --------------------------------------
// React/Next 표준 식별자가 import 누락된 경우만 자동 추가.
// 사용자 코드의 미정의 식별자는 추측해서 import 만들면 위험하므로 절대 손대지 않는다.

const STANDARD_IDENT_IMPORT = new Map([
  // React hooks
  ['useState', { from: 'react', kind: 'named' }],
  ['useEffect', { from: 'react', kind: 'named' }],
  ['useLayoutEffect', { from: 'react', kind: 'named' }],
  ['useInsertionEffect', { from: 'react', kind: 'named' }],
  ['useReducer', { from: 'react', kind: 'named' }],
  ['useRef', { from: 'react', kind: 'named' }],
  ['useMemo', { from: 'react', kind: 'named' }],
  ['useCallback', { from: 'react', kind: 'named' }],
  ['useContext', { from: 'react', kind: 'named' }],
  ['useImperativeHandle', { from: 'react', kind: 'named' }],
  ['useTransition', { from: 'react', kind: 'named' }],
  ['useDeferredValue', { from: 'react', kind: 'named' }],
  ['useId', { from: 'react', kind: 'named' }],
  ['useSyncExternalStore', { from: 'react', kind: 'named' }],
  ['Fragment', { from: 'react', kind: 'named' }],
  ['createContext', { from: 'react', kind: 'named' }],
  ['forwardRef', { from: 'react', kind: 'named' }],
  ['memo', { from: 'react', kind: 'named' }],
  ['useDebugValue', { from: 'react', kind: 'named' }],

  // Next.js navigation
  ['useRouter', { from: 'next/navigation', kind: 'named' }],
  ['useSearchParams', { from: 'next/navigation', kind: 'named' }],
  ['usePathname', { from: 'next/navigation', kind: 'named' }],
  ['useParams', { from: 'next/navigation', kind: 'named' }],
  ['useSelectedLayoutSegment', { from: 'next/navigation', kind: 'named' }],
  ['useSelectedLayoutSegments', { from: 'next/navigation', kind: 'named' }],
  ['redirect', { from: 'next/navigation', kind: 'named' }],
  ['notFound', { from: 'next/navigation', kind: 'named' }],
  ['permanentRedirect', { from: 'next/navigation', kind: 'named' }],

  // Next.js components
  ['Link', { from: 'next/link', kind: 'default' }],
  ['Image', { from: 'next/image', kind: 'default' }],
  ['Script', { from: 'next/script', kind: 'default' }],
  ['dynamic', { from: 'next/dynamic', kind: 'default' }],
  ['Head', { from: 'next/head', kind: 'default' }],
]);

// ---- ts-morph 헬퍼 --------------------------------------------------------

/**
 * 같은 파일 내에 동일한 텍스트 식별자가 이미 존재하는지 검사.
 * rename 충돌을 사전에 회피한다.
 */
function fileContainsIdentifier(sourceFile, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
  return re.test(sourceFile.getFullText());
}

/**
 * 식별자에 _ prefix 를 붙여 rename. ts-morph 는 같은 스코프 내 모든 reference 를
 * 함께 변경하므로, 사용처가 0개 (TS6133) 인 declaration 에 안전하게 적용 가능.
 *
 * - 이미 _ 로 시작하면 idempotent 하게 skip
 * - _ 변형이 같은 파일에 이미 있으면 충돌 가능 → skip (오작 방지)
 */
function tryRenameToUnderscore(node) {
  if (!node || typeof node.getName !== 'function') return false;
  const name = node.getName();
  if (!name || name.startsWith('_')) return false;
  const target = '_' + name;
  const sf = node.getSourceFile?.();
  if (sf && fileContainsIdentifier(sf, target)) return false;
  try {
    node.rename(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * tsc 의 1-based (line, column) 을 ts-morph SourceFile 의 노드로 변환.
 */
function nodeAtLineColumn(sourceFile, line, column) {
  try {
    const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      line - 1,
      column - 1,
    );
    return sourceFile.getDescendantAtPos(pos) || null;
  } catch {
    return null;
  }
}

/**
 * 노드 → 가까운 Identifier 노드.
 */
function getNearestIdentifier(node) {
  if (!node) return null;
  if (node.getKind() === SyntaxKind.Identifier) return node;
  return node.getFirstChildByKind?.(SyntaxKind.Identifier) || null;
}

// ---- 개별 에러 처리 -------------------------------------------------------

/**
 * TS6133 / TS6138 / TS6196: "declared but never read/used"
 * 부모 컨텍스트별로 가장 안전한 변환을 선택.
 *  - parameter / 구조분해 / 변수 → _ prefix rename
 *  - import specifier / clause / namespace → 안전 모듈에 한해 제거
 *  - type alias / interface (export 안 됨) → 제거
 *  - 그 외 → skip (false 반환)
 */
function fixUnusedDeclaration(sourceFile, error) {
  const node = nodeAtLineColumn(sourceFile, error.line, error.column);
  const id = getNearestIdentifier(node);
  if (!id) return false;

  const parent = id.getParent();
  if (!parent) return false;
  const parentKind = parent.getKind();

  // 1) 함수 파라미터
  if (parentKind === SyntaxKind.Parameter) {
    return tryRenameToUnderscore(parent);
  }

  // 2) 구조분해 (BindingElement)
  if (parentKind === SyntaxKind.BindingElement) {
    return tryRenameToUnderscore(parent);
  }

  // 3) const/let X = ...
  if (parentKind === SyntaxKind.VariableDeclaration) {
    // 사이드이펙트가 있을 수 있으므로 제거하지 말고 rename.
    return tryRenameToUnderscore(parent);
  }

  // 4) named import: import { X } from 'react'
  if (parentKind === SyntaxKind.ImportSpecifier) {
    const importDecl = parent.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const spec = importDecl?.getModuleSpecifierValue();
    if (!isSafeImportSource(spec)) return false;
    parent.remove();
    if (importDecl) {
      const named = importDecl.getNamedImports();
      const def = importDecl.getDefaultImport();
      const ns = importDecl.getNamespaceImport();
      if (named.length === 0 && !def && !ns) {
        importDecl.remove();
      }
    }
    return true;
  }

  // 5) default import: import X from 'react'
  if (parentKind === SyntaxKind.ImportClause) {
    const importDecl = parent.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const spec = importDecl?.getModuleSpecifierValue();
    if (!isSafeImportSource(spec)) return false;
    try {
      parent.removeDefaultImport?.();
    } catch {
      return false;
    }
    if (importDecl) {
      const named = importDecl.getNamedImports();
      const ns = importDecl.getNamespaceImport();
      if (named.length === 0 && !ns) {
        importDecl.remove();
      }
    }
    return true;
  }

  // 6) namespace import: import * as X from 'react'
  if (parentKind === SyntaxKind.NamespaceImport) {
    const importDecl = parent.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const spec = importDecl?.getModuleSpecifierValue();
    if (!isSafeImportSource(spec)) return false;
    importDecl?.remove();
    return true;
  }

  // 7) type alias / interface (export 안 됨) → 제거
  if (
    parentKind === SyntaxKind.TypeAliasDeclaration ||
    parentKind === SyntaxKind.InterfaceDeclaration
  ) {
    const isExported =
      typeof parent.isExported === 'function' ? parent.isExported() : false;
    if (isExported) return false;
    parent.remove();
    return true;
  }

  // 8) function / class declaration (export 안 됨) → rename (사용처 없으므로 안전)
  if (
    parentKind === SyntaxKind.FunctionDeclaration ||
    parentKind === SyntaxKind.ClassDeclaration
  ) {
    const isExported =
      typeof parent.isExported === 'function' ? parent.isExported() : false;
    if (isExported) return false;
    return tryRenameToUnderscore(parent);
  }

  return false;
}

/**
 * TS6192: "All imports in import declaration are unused" → import 문 전체 제거 (안전 모듈만)
 */
function fixUnusedAllImports(sourceFile, error) {
  const node = nodeAtLineColumn(sourceFile, error.line, error.column);
  const importDecl =
    node?.getFirstAncestorByKind?.(SyntaxKind.ImportDeclaration) ||
    (node?.getKind?.() === SyntaxKind.ImportDeclaration ? node : null);
  if (!importDecl) return false;
  const spec = importDecl.getModuleSpecifierValue();
  if (!isSafeImportSource(spec)) return false;
  importDecl.remove();
  return true;
}

/**
 * 표준 React/Next 식별자에 한해 import 추가.
 */
function addStandardImportIfMissing(sourceFile, identName) {
  const meta = STANDARD_IDENT_IMPORT.get(identName);
  if (!meta) return false;

  const existing = sourceFile.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === meta.from,
  );

  if (existing) {
    if (meta.kind === 'named') {
      const has = existing.getNamedImports().some((n) => n.getName() === identName);
      if (has) return false;
      existing.addNamedImport(identName);
      return true;
    }
    if (meta.kind === 'default') {
      if (existing.getDefaultImport()) return false;
      existing.setDefaultImport(identName);
      return true;
    }
  }

  if (meta.kind === 'named') {
    sourceFile.addImportDeclaration({
      moduleSpecifier: meta.from,
      namedImports: [identName],
    });
  } else {
    sourceFile.addImportDeclaration({
      moduleSpecifier: meta.from,
      defaultImport: identName,
    });
  }
  return true;
}

/**
 * TS2304: "Cannot find name 'X'" — 표준 식별자만 import 추가
 */
function fixCannotFindName(sourceFile, error) {
  const m = /Cannot find name ['"`]([^'"`]+)['"`]/.exec(error.message || '');
  if (!m) return false;
  return addStandardImportIfMissing(sourceFile, m[1]);
}

// ---- 파일/배치 진입점 -----------------------------------------------------

/**
 * 단일 파일에 대해 결정론적 autofix 수행.
 * @returns {Promise<{ fixed: number, applied: Array<{ code: string, line: number, column: number }> }>}
 */
async function autofixSingleFile(projectRoot, relPath, fileErrors) {
  const absPath = path.join(projectRoot, relPath);
  if (!(await fs.pathExists(absPath))) return { fixed: 0, applied: [] };
  if (!/\.(t|j)sx?$/.test(relPath)) return { fixed: 0, applied: [] };

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(absPath);
  } catch {
    return { fixed: 0, applied: [] };
  }

  // 라인/컬럼 내림차순으로 처리해 노드 위치 변동 영향을 줄인다.
  const sorted = [...fileErrors].sort(
    (a, b) => b.line - a.line || b.column - a.column,
  );

  let fixed = 0;
  const applied = [];

  for (const err of sorted) {
    let ok = false;
    try {
      if (UNUSED_DECL_CODES.has(err.code)) {
        ok = fixUnusedDeclaration(sourceFile, err);
      } else if (err.code === UNUSED_ALL_IMPORTS_CODE) {
        ok = fixUnusedAllImports(sourceFile, err);
      } else if (err.code === CANNOT_FIND_CODE) {
        ok = fixCannotFindName(sourceFile, err);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      fixed++;
      applied.push({ code: err.code, line: err.line, column: err.column });
    }
  }

  if (fixed > 0) {
    try {
      await sourceFile.save();
    } catch {
      return { fixed: 0, applied: [] };
    }
  }

  return { fixed, applied };
}

/**
 * 다수 파일에 대해 결정론적 autofix 수행.
 * @param {string} projectRoot
 * @param {Array<{ file: string, line: number, column: number, code: string, message: string }>} errors
 * @returns {Promise<{ totalFixed: number, fixedFiles: Array<{ file: string, count: number }> }>}
 */
async function autofixErrors(projectRoot, errors) {
  const filtered = (Array.isArray(errors) ? errors : []).filter((e) =>
    AUTOFIXABLE_CODES.has(e.code),
  );

  const byFile = new Map();
  for (const e of filtered) {
    const arr = byFile.get(e.file) || [];
    arr.push(e);
    byFile.set(e.file, arr);
  }

  let totalFixed = 0;
  const fixedFiles = [];

  for (const [relFile, fileErrors] of byFile.entries()) {
    try {
      const { fixed } = await autofixSingleFile(projectRoot, relFile, fileErrors);
      if (fixed > 0) {
        totalFixed += fixed;
        fixedFiles.push({ file: relFile, count: fixed });
      }
    } catch {
      // best-effort: 개별 파일 오류는 마이그레이션을 막지 않는다.
    }
  }

  return { totalFixed, fixedFiles };
}

module.exports = {
  autofixErrors,
  autofixSingleFile,
  AUTOFIXABLE_CODES,
  STANDARD_IDENT_IMPORT,
  isSafeImportSource,
};
