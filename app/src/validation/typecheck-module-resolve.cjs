'use strict';

// TS2307: Cannot find module — 결정론적 경로 보정 (LLM 없음)
// - 상대 경로: 확장자 / index 보강
// - tsconfig paths (@/* 등): 실제 파일로 매핑 후 상대 경로로 통일
// - 그 외: 프로젝트 루트에서 동일 파일명(ts/tsx) 단일·최단 후보

const fs = require('fs-extra');
const path = require('path');
const { SyntaxKind } = require('ts-morph');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  'out',
]);

/**
 * @param {string} absBase path without requiring extension
 * @returns {string|null}
 */
function resolveExistingFile(absBase) {
  const candidates = [
    absBase,
    `${absBase}.ts`,
    `${absBase}.tsx`,
    `${absBase}.js`,
    `${absBase}.jsx`,
    `${absBase}.mjs`,
    `${absBase}.cjs`,
    path.join(absBase, 'index.ts'),
    path.join(absBase, 'index.tsx'),
    path.join(absBase, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.normalize(c);
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * pattern: "@/*" / "./src/*" — 단일 * 만 지원
 * @returns {string|null} 매칭 시 * 치환 문자열
 */
function matchPathStarPattern(spec, pattern) {
  const i = pattern.indexOf('*');
  if (i === -1) return spec === pattern ? '' : null;
  const pre = pattern.slice(0, i);
  const post = pattern.slice(i + 1);
  if (!spec.startsWith(pre)) return null;
  if (post && !spec.endsWith(post)) return null;
  return spec.slice(pre.length, post ? spec.length - post.length : undefined);
}

function loadCompilerOptions(projectRoot) {
  const p = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(p)) return { baseUrl: projectRoot, paths: {} };
  try {
    const raw = fs.readJsonSync(p);
    const co = raw.compilerOptions || {};
    const baseUrl = path.resolve(projectRoot, co.baseUrl || '.');
    return { baseUrl, paths: co.paths && typeof co.paths === 'object' ? co.paths : {} };
  } catch {
    return { baseUrl: projectRoot, paths: {} };
  }
}

/**
 * paths 매핑으로 spec → 절대 파일 경로
 * - 와일드카드 없는 키(예: "@types": ["types"]) 는 spec 과 정확히 일치할 때만 매핑
 */
function resolveViaTsconfigPaths(projectRoot, spec) {
  const { baseUrl, paths } = loadCompilerOptions(projectRoot);
  if (!paths || Object.keys(paths).length === 0) return null;

  for (const [pat, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    if (pat.includes('*')) continue;
    if (spec !== pat) continue;
    for (const t of targets) {
      if (typeof t !== 'string') continue;
      const absMapped = path.resolve(baseUrl, t);
      const found = resolveExistingFile(absMapped);
      if (found) return found;
    }
  }

  for (const [pat, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const matched = matchPathStarPattern(spec, pat);
    if (matched === null) continue;
    for (const t of targets) {
      if (typeof t !== 'string') continue;
      const mapped = t.includes('*') ? t.replace(/\*/g, matched) : t;
      const absMapped = path.resolve(baseUrl, mapped);
      const found = resolveExistingFile(absMapped);
      if (found) return found;
    }
  }
  return null;
}

/**
 * import 문자열 → 해당 모듈의 실제 파일 절대 경로 (TS2459 등)
 */
function resolveImportSpecifierToAbsPath(projectRoot, importerRelPath, spec) {
  const importerAbs = path.join(projectRoot, importerRelPath);
  if (spec.startsWith('.') || spec.startsWith('..')) {
    const base = path.normalize(path.join(path.dirname(importerAbs), spec));
    return resolveExistingFile(base);
  }
  const via = resolveViaTsconfigPaths(projectRoot, spec);
  if (via) return via;
  if (spec === '@types') {
    const f = resolveBareTypesFolder(projectRoot);
    if (f) return f;
  }
  return null;
}

/**
 * `@types` bare import 등에 쓸 타입 루트 후보: tsconfig paths/typeRoots + 관용 경로
 */
function collectBareTypesSearchRoots(projectRoot) {
  const { baseUrl, paths } = loadCompilerOptions(projectRoot);
  const roots = [];
  const add = (p) => {
    try {
      const n = path.normalize(p);
      if (!roots.includes(n)) roots.push(n);
    } catch {
      // ignore
    }
  };

  try {
    const raw = fs.readJsonSync(path.join(projectRoot, 'tsconfig.json'));
    const co = raw.compilerOptions || {};
    const bu = path.resolve(projectRoot, co.baseUrl || '.');
    const tr = co.typeRoots;
    if (Array.isArray(tr)) {
      for (const t of tr) {
        if (typeof t !== 'string') continue;
        if (/node_modules[/\\]@types/i.test(t)) continue;
        add(path.resolve(bu, t));
      }
    }
  } catch {
    // ignore
  }

  if (paths) {
    for (const [pat, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const keyHit = /types/i.test(String(pat));
      for (const t of targets) {
        if (typeof t !== 'string' || /node_modules/i.test(t)) continue;
        const stripStar = t.replace(/\*/g, '').replace(/\/+$/, '');
        if (!stripStar) continue;
        if (keyHit || /types/i.test(stripStar)) {
          add(path.resolve(baseUrl, stripStar));
        }
      }
    }
  }

  for (const rel of ['src/types', 'types', 'app/types']) {
    add(path.join(projectRoot, rel));
  }
  return roots;
}

function resolveBareTypesFolder(projectRoot) {
  for (const dir of collectBareTypesSearchRoots(projectRoot)) {
    const f = resolveExistingFile(dir);
    if (f) return f;
  }
  return null;
}

/**
 * import 경로를 importer 기준 상대(확장자 생략)로
 */
function toRelativeImportSpecifier(importerAbs, targetAbs) {
  const rel = path.relative(path.dirname(importerAbs), targetAbs);
  let s = rel.split(path.sep).join('/');
  if (!s.startsWith('.')) s = `./${s}`;
  return s.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, '');
}

function stemFromModuleSpecifier(spec) {
  const base = spec.split('/').pop() || spec;
  return base.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, '');
}

/**
 * 프로젝트에서 stem.ts(x) 파일 검색 (제한된 DFS)
 */
function findFilesByStem(projectRoot, stem, opts = {}) {
  const maxDirs = opts.maxDirs ?? 4000;
  const maxResults = opts.maxResults ?? 12;
  const results = [];
  let dirCount = 0;
  const stack = [[projectRoot, 0]];

  while (stack.length && results.length < maxResults && dirCount < maxDirs) {
    const [dir, depth] = stack.pop();
    dirCount++;
    if (depth > 14) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push([fp, depth + 1]);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (ext !== '.ts' && ext !== '.tsx') continue;
        if (path.basename(ent.name, ext) === stem) results.push(path.normalize(fp));
      }
    }
  }
  return results;
}

function pickNearestCandidate(importerAbs, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const fromDir = path.dirname(importerAbs);
  let best = null;
  let bestSegs = Infinity;
  for (const c of candidates) {
    const rel = path.relative(fromDir, c);
    const n = rel.split(path.sep).filter(Boolean).length;
    if (n < bestSegs) {
      bestSegs = n;
      best = c;
    }
  }
  return best;
}

/**
 * node_modules 에 해당 패키지 루트가 없으면 import 가 레거시 alias 일 가능성 ↑
 * (@/ 는 별도 처리)
 */
function packageNotInstalled(projectRoot, spec) {
  if (!spec || spec.startsWith('@/')) return true;
  const parts = spec.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  let sub;
  if (parts[0].startsWith('@')) {
    if (parts.length < 2) return true;
    sub = path.join(parts[0], parts[1]);
  } else {
    sub = parts[0];
  }
  const nmPath = path.join(projectRoot, 'node_modules', sub);
  return !fs.existsSync(nmPath);
}

function shouldRunBasenameHeuristic(projectRoot, spec) {
  if (!spec || !spec.includes('/')) return false;
  if (spec.startsWith('.')) return false;
  if (spec.startsWith('@/')) return true;
  return packageNotInstalled(projectRoot, spec);
}

/**
 * @param {import('ts-morph').SourceFile} sourceFile
 * @param {{ line: number, column: number, message: string }} error
 * @param {string} projectRoot
 * @param {string} relPath importer
 */
function fixCannotFindModule(sourceFile, error, projectRoot, relPath) {
  const msg = error.message || '';
  const m = /Cannot find module ['"]([^'"]+)['"]/.exec(msg);
  if (!m) return false;

  const importerAbs = path.join(projectRoot, relPath);
  let node = null;
  try {
    const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(
      error.line - 1,
      error.column - 1,
    );
    node = sourceFile.getDescendantAtPos(pos) || null;
  } catch {
    return false;
  }

  let importDecl = null;
  let exportDecl = null;
  let cur = node;
  for (let i = 0; i < 20 && cur; i++) {
    const k = cur.getKind();
    if (k === SyntaxKind.ImportDeclaration) {
      importDecl = cur;
      break;
    }
    if (k === SyntaxKind.ExportDeclaration) {
      const ex = cur;
      if (typeof ex.getModuleSpecifier === 'function' && ex.getModuleSpecifier()) {
        exportDecl = ex;
        break;
      }
    }
    cur = cur.getParent();
  }

  const decl = importDecl || exportDecl;
  if (!decl) return false;

  let currentSpec = null;
  try {
    currentSpec =
      importDecl?.getModuleSpecifierValue?.() ?? exportDecl?.getModuleSpecifierValue?.();
  } catch {
    return false;
  }
  if (!currentSpec || currentSpec !== m[1]) return false;

  const spec = currentSpec;
  let foundAbs = null;

  if (spec.startsWith('.') || spec.startsWith('..')) {
    const base = path.normalize(path.join(path.dirname(importerAbs), spec));
    foundAbs = resolveExistingFile(base);
  }

  if (!foundAbs) {
    foundAbs = resolveViaTsconfigPaths(projectRoot, spec);
  }

  if (!foundAbs && spec === '@types') {
    foundAbs = resolveBareTypesFolder(projectRoot);
  }

  if (!foundAbs && shouldRunBasenameHeuristic(projectRoot, spec)) {
    const stem = stemFromModuleSpecifier(spec);
    if (stem && stem.length > 0) {
      const hits = findFilesByStem(projectRoot, stem);
      foundAbs = pickNearestCandidate(importerAbs, hits);
    }
  }

  if (!foundAbs) return false;

  const nextSpec = toRelativeImportSpecifier(importerAbs, foundAbs);
  if (nextSpec === spec) return false;

  try {
    if (importDecl) importDecl.setModuleSpecifier(nextSpec);
    else if (exportDecl) exportDecl.setModuleSpecifier(nextSpec);
    else return false;
  } catch {
    return false;
  }

  return true;
}

module.exports = {
  fixCannotFindModule,
  resolveExistingFile,
  resolveViaTsconfigPaths,
  resolveImportSpecifierToAbsPath,
  resolveBareTypesFolder,
  collectBareTypesSearchRoots,
  toRelativeImportSpecifier,
};
