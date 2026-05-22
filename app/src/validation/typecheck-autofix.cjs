'use strict';

// app/src/validation/typecheck-autofix.cjs
// TypeScript 검증 결과를 받아 결정론적(LLM 호출 없는) 자동 수정을 수행.
// - 토큰 비용 0
// - 화이트리스트 코드만 수정 (오작 위험을 최소화)
// - idempotent: 이미 처리된 코드를 다시 건드리지 않음
// - best-effort: 수정 실패가 마이그레이션을 막지 않음

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');
const { applyAppRouterFixes } = require('./typecheck-app-router-fix.cjs');
const {
  fixCannotFindModule,
  resolveImportSpecifierToAbsPath,
} = require('./typecheck-module-resolve.cjs');

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
const CANNOT_FIND_SUGGESTED_CODE = 'TS2552';
const JSX_NULL_INTRINSIC_CODE = 'TS2339';
const MODULE_NOT_FOUND_CODE = 'TS2307';
const NO_EXPORTED_MEMBER_CODE = 'TS2614';
const IMPORT_CONFLICT_CODE = 'TS2440';
const MISSING_EXPORT_CODE = 'TS2459';

const AUTOFIXABLE_CODES = new Set([
  ...UNUSED_DECL_CODES,
  UNUSED_ALL_IMPORTS_CODE,
  CANNOT_FIND_CODE,
  CANNOT_FIND_SUGGESTED_CODE,
  JSX_NULL_INTRINSIC_CODE,
  MODULE_NOT_FOUND_CODE,
  NO_EXPORTED_MEMBER_CODE,
  IMPORT_CONFLICT_CODE,
  MISSING_EXPORT_CODE,
]);

// tsc 라인 단위 외에 파일 단위(App Router 패턴) 보정을 돌릴 트리거
const APP_ROUTER_BULK_CODES = new Set([
  'TS2353',
  'TS2345',
  'TS2786',
  'TS2607',
  'TS17001',
]);

const FILE_PASS_CODES = new Set([...AUTOFIXABLE_CODES, ...APP_ROUTER_BULK_CODES]);

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

/**
 * TS6133 대상 중 문자열/숫자 등 부수효과 없는 초기값이면 변수문 전체 제거 (아이콘 URL 상수 등)
 */
function isTrivialUnusedInitializer(init) {
  if (!init) return false;
  const k = init.getKind();
  if (
    k === SyntaxKind.StringLiteral ||
    k === SyntaxKind.NumericLiteral ||
    k === SyntaxKind.TrueKeyword ||
    k === SyntaxKind.FalseKeyword ||
    k === SyntaxKind.NullKeyword ||
    k === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return true;
  }
  if (k === SyntaxKind.Identifier && init.getText() === 'undefined') return true;
  if (k === SyntaxKind.ArrayLiteralExpression) {
    return init.getElements().every((el) => isTrivialUnusedInitializer(el));
  }
  if (k === SyntaxKind.ObjectLiteralExpression) {
    return init.getProperties().length === 0;
  }
  return false;
}

function removeVariableDeclarationStatement(vd) {
  const list = vd.getParent();
  if (!list || list.getKind() !== SyntaxKind.VariableDeclarationList) return false;
  const decls = list.getDeclarations();
  if (decls.length === 1) {
    const stmt = list.getParent();
    if (stmt && stmt.getKind() === SyntaxKind.VariableStatement) {
      stmt.remove();
      return true;
    }
  } else {
    vd.remove();
    return true;
  }
  return false;
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
    const init = parent.getInitializer();
    if (isTrivialUnusedInitializer(init)) {
      return removeVariableDeclarationStatement(parent);
    }
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
      if (!importDecl || typeof importDecl.removeDefaultImport !== 'function') return false;
      importDecl.removeDefaultImport();
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
 * TS2339: Property 'null' does not exist on type 'JSX.IntrinsicElements'.
 * - 마이그레이션 중 <null>...</null> 같은 비정상 JSX 태그를 Fragment 로 치환
 */
function fixJsxNullIntrinsic(sourceFile, error) {
  if (!/Property 'null' does not exist on type 'JSX\.IntrinsicElements'/i.test(error.message || '')) {
    return false;
  }
  const fullText = sourceFile.getFullText();
  const nextText = fullText
    .replace(/<\s*null\s*>/g, '<>')
    .replace(/<\s*\/\s*null\s*>/g, '</>')
    .replace(/<\s*null\s*\/\s*>/g, '<></>');
  if (nextText === fullText) return false;
  sourceFile.replaceWithText(nextText);
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

function importPathsRoughlyEqual(specInFile, pathFromMessage) {
  if (!specInFile || !pathFromMessage) return false;
  const a = specInFile.replace(/\\/g, '/');
  const b = pathFromMessage.replace(/\\/g, '/');
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  return false;
}

/**
 * TS2614: named import 가 없고 default 를 쓰라는 tsc 힌트가 있을 때
 */
function fixDefaultImportMember(sourceFile, error) {
  const msg = error.message || '';
  const memberM = /has no exported member ['"]([^'"]+)['"]/.exec(msg);
  const hintM =
    /Did you mean to use ['`]import (\w+) from ["']([^"']+)["']['`] instead\?/i.exec(msg) ||
    /Did you mean to use import (\w+) from ["']([^"']+)["'] instead\?/i.exec(msg) ||
    /Did you mean ['`]import (\w+) from ["']([^"']+)["']['`]\?/i.exec(msg);
  if (!memberM || !hintM) return false;
  const member = memberM[1];
  const hintedName = hintM[1];
  const modPath = hintM[2];
  if (member !== hintedName) return false;

  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!importPathsRoughlyEqual(spec, modPath)) continue;
    const named = decl.getNamedImports().find((n) => n.getName() === member);
    if (!named) continue;
    named.remove();
    if (decl.getDefaultImport()) return false;
    decl.setDefaultImport(member);
    return true;
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * TS2440: next/image default import 이름이 로컬 선언과 충돌 — Next{Name} 로 치환 (심볼은 메시지에서 읽음)
 */
function fixNextDefaultImportNameConflict(sourceFile, error) {
  const msg = error.message || '';
  const m = /conflicts with local declaration of ['"]([^'"]+)['"]/i.exec(msg);
  if (!m) return false;
  const sym = m[1];
  if (!/^[A-Za-z_$][\w$]*$/.test(sym)) return false;
  const decl = sourceFile.getImportDeclarations().find(
    (d) => d.getModuleSpecifierValue() === 'next/image' && d.getDefaultImport()?.getText() === sym,
  );
  if (!decl) return false;
  const alias = `Next${sym}`;
  const text = sourceFile.getFullText();
  const importRe = new RegExp(
    `import\\s+${escapeRegExp(sym)}\\s+from\\s+(['"])next/image\\1`,
    'g',
  );
  if (!text.match(importRe)) return false;
  importRe.lastIndex = 0;
  let next = text.replace(importRe, `import ${alias} from $1next/image$1`);
  const reSym = escapeRegExp(sym);
  next = next.replace(new RegExp(`<\\s*\\/\\s*${reSym}\\s*>`, 'gi'), `</${alias}>`);
  next = next.replace(new RegExp(`<\\s*${reSym}\\s*\\/>`, 'gi'), `<${alias} />`);
  next = next.replace(new RegExp(`<\\s*${reSym}\\s*>`, 'gi'), `<${alias}>`);
  next = next.replace(new RegExp(`<\\s*${reSym}\\s+`, 'gi'), `<${alias} `);
  if (next === text) return false;
  sourceFile.replaceWithText(next);
  return true;
}

/**
 * TS2459: 모듈 내부 타입이 export 되지 않음 — 해당 파일에 export 추가
 */
async function fixMissingTypeExport(projectRoot, importerRelPath, error) {
  const msg = error.message || '';
  const modM = /Module\s+['"]([^'"]+)['"]/.exec(msg);
  const nameM = /declares\s+['"]([^'"]+)['"]\s+locally/i.exec(msg);
  if (!modM || !nameM) return false;
  const modSpec = modM[1];
  const typeName = nameM[1];
  const targetAbs = resolveImportSpecifierToAbsPath(projectRoot, importerRelPath, modSpec);
  if (!targetAbs) return false;

  const proj = new Project({ skipAddingFilesFromTsConfig: true });
  let targetSf;
  try {
    targetSf = proj.addSourceFileAtPath(targetAbs);
  } catch {
    return false;
  }

  let touched = false;
  for (const node of targetSf.getInterfaces()) {
    if (node.getName() === typeName && !node.isExported()) {
      node.setIsExported(true);
      touched = true;
      break;
    }
  }
  if (!touched) {
    for (const node of targetSf.getTypeAliases()) {
      if (node.getName() === typeName && !node.isExported()) {
        node.setIsExported(true);
        touched = true;
        break;
      }
    }
  }
  if (!touched) {
    for (const node of targetSf.getEnums()) {
      if (node.getName() === typeName && !node.isExported()) {
        node.setIsExported(true);
        touched = true;
        break;
      }
    }
  }
  if (!touched) return false;
  try {
    await targetSf.save();
  } catch {
    return false;
  }
  return true;
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

  let bulk = 0;
  const wantsBulk = fileErrors.some((e) => APP_ROUTER_BULK_CODES.has(e.code));
  const wantsStandard = fileErrors.some((e) => AUTOFIXABLE_CODES.has(e.code));
  const wantsModule = fileErrors.some((e) => e.code === MODULE_NOT_FOUND_CODE);
  if ((wantsBulk || wantsStandard || wantsModule) && /\.(tsx|ts)$/.test(relPath)) {
    try {
      bulk = applyAppRouterFixes(sourceFile, projectRoot, relPath);
    } catch {
      bulk = 0;
    }
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
      } else if (err.code === CANNOT_FIND_CODE || err.code === CANNOT_FIND_SUGGESTED_CODE) {
        ok = fixCannotFindName(sourceFile, err);
      } else if (err.code === JSX_NULL_INTRINSIC_CODE) {
        ok = fixJsxNullIntrinsic(sourceFile, err);
      } else if (err.code === MODULE_NOT_FOUND_CODE) {
        ok = fixCannotFindModule(sourceFile, err, projectRoot, relPath);
      } else if (err.code === NO_EXPORTED_MEMBER_CODE) {
        ok = fixDefaultImportMember(sourceFile, err);
      } else if (err.code === IMPORT_CONFLICT_CODE) {
        ok = fixNextDefaultImportNameConflict(sourceFile, err);
      } else if (err.code === MISSING_EXPORT_CODE) {
        ok = await fixMissingTypeExport(projectRoot, relPath, err);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      fixed++;
      applied.push({ code: err.code, line: err.line, column: err.column });
    }
  }

  fixed += bulk;

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
    FILE_PASS_CODES.has(e.code),
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
  FILE_PASS_CODES,
  MODULE_NOT_FOUND_CODE,
  STANDARD_IDENT_IMPORT,
  isSafeImportSource,
};
