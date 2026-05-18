'use strict';

// app/src/utils/strip-import-extensions.cjs
// 결정론적(LLM 호출 없는) 후처리: 상대/alias import 경로의 .ts / .tsx / .js / .jsx /
// .mjs / .cjs / .mts / .cts 확장자를 제거한다.
//
// 왜 필요한가:
//   - Vite 는 import './X.tsx' 를 허용하지만, Next.js 가 쓰는 tsc 는
//     `An import path can only end with a '.tsx' extension when
//      'allowImportingTsExtensions' is enabled.` (TS5097/TS2867) 로 거부한다.
//   - 마이그레이션 결과물에는 원본 Vite 코드의 .tsx/.ts import 가 그대로 남는 경우가
//     많아 빌드가 깨진다. 이 sweep 으로 한 번에 정리한다.
//
// 안전성:
//   - bare 모듈 import (예: 'react', '@scope/pkg') 는 손대지 않는다.
//   - http(s):, node:, data: 같은 protocol 이 있는 specifier 는 제외.
//   - 상대 경로 (`./`, `../`) 와 tsconfig path alias (`@/...` 등) 만 처리.
//   - import / export ... from / dynamic import('...') 모두 동일하게 처리.

const fs = require('fs-extra');
const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');

const STRIPPABLE_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i;
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'out',
]);

function loadTsconfigPathPatterns(projectRoot) {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return [];
  try {
    const raw = fs.readJsonSync(tsconfigPath);
    const paths = raw?.compilerOptions?.paths;
    if (!paths || typeof paths !== 'object') return [];
    return Object.keys(paths);
  } catch {
    return [];
  }
}

function specMatchesPathAlias(spec, pattern) {
  const i = pattern.indexOf('*');
  if (i === -1) return spec === pattern;
  const pre = pattern.slice(0, i);
  const post = pattern.slice(i + 1);
  if (!spec.startsWith(pre)) return false;
  if (post && !spec.endsWith(post)) return false;
  return true;
}

function isLocalSpecifier(spec, patterns) {
  if (!spec || typeof spec !== 'string') return false;
  if (spec.startsWith('node:')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return false; // http: / data: 등
  if (spec.startsWith('.')) return true;
  for (const pat of patterns) {
    if (specMatchesPathAlias(spec, pat)) return true;
  }
  return false;
}

/**
 * .ts / .tsx 등의 코드 모듈 확장자만 잘라내고, 쿼리/해시는 보존한다.
 * @param {string} spec
 * @returns {string|null} 변경 없으면 null
 */
function stripExtensionFromSpec(spec) {
  if (!spec) return null;
  const queryIdx = spec.search(/[?#]/);
  const head = queryIdx === -1 ? spec : spec.slice(0, queryIdx);
  const tail = queryIdx === -1 ? '' : spec.slice(queryIdx);
  if (!STRIPPABLE_EXT_RE.test(head)) return null;
  // 단순 './' 또는 '../' 같은 경계는 손대지 않는다 (이미 위에서 정규식이 거름).
  const next = head.replace(STRIPPABLE_EXT_RE, '') + tail;
  return next === spec ? null : next;
}

async function findSourceFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const fp = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name) && !item.name.startsWith('.')) {
          stack.push(fp);
        }
        continue;
      }
      if (!item.isFile()) continue;
      if (!/\.(tsx?|jsx?|mjs|cjs)$/i.test(item.name)) continue;
      out.push(fp);
    }
  }
  return out;
}

/**
 * 단일 파일에 대해 결정론적 import 경로 확장자 제거.
 * @returns {Promise<{ changed: boolean, replacements: number }>}
 */
async function stripExtensionsInFile(projectRoot, absPath, patterns, project) {
  let sourceFile;
  try {
    sourceFile = project.addSourceFileAtPath(absPath);
  } catch {
    return { changed: false, replacements: 0 };
  }

  let replacements = 0;

  const handleSpec = (decl, currentSpec) => {
    if (!isLocalSpecifier(currentSpec, patterns)) return;
    const next = stripExtensionFromSpec(currentSpec);
    if (!next || next === currentSpec) return;
    try {
      decl.setModuleSpecifier(next);
      replacements++;
    } catch {
      // ignore
    }
  };

  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec) handleSpec(decl, spec);
  }

  for (const decl of sourceFile.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec) handleSpec(decl, spec);
  }

  // 동적 import('...') — string literal 인자만 처리
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.ImportKeyword) {
      // 일반 함수 호출인 경우 ImportKeyword 가 아닐 수 있다 — 별도 검사
      if (expr.getKind() !== SyntaxKind.Identifier) continue;
      if (expr.getText() !== 'import') continue;
    }
    const args = call.getArguments();
    const a0 = args[0];
    if (!a0 || a0.getKind() !== SyntaxKind.StringLiteral) continue;
    const lit = a0;
    const cur = lit.getLiteralValue();
    if (!isLocalSpecifier(cur, patterns)) continue;
    const next = stripExtensionFromSpec(cur);
    if (!next || next === cur) continue;
    try {
      lit.setLiteralValue(next);
      replacements++;
    } catch {
      // ignore
    }
  }

  if (replacements > 0) {
    try {
      await sourceFile.save();
      return { changed: true, replacements };
    } catch {
      return { changed: false, replacements: 0 };
    }
  }

  return { changed: false, replacements: 0 };
}

/**
 * 프로젝트 전체에서 import 경로의 .ts/.tsx 등 확장자를 결정론적으로 제거.
 * @param {string} projectRoot
 * @returns {Promise<{ changedFiles: string[], totalReplacements: number }>}
 */
async function stripImportExtensions(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  const rootDir = fs.existsSync(srcDir) ? srcDir : projectRoot;
  const patterns = loadTsconfigPathPatterns(projectRoot);

  const files = await findSourceFiles(rootDir);
  if (files.length === 0) return { changedFiles: [], totalReplacements: 0 };

  // 파일이 많을 수 있으므로 ts-morph Project 를 한 번만 만든다.
  const project = new Project({ skipAddingFilesFromTsConfig: true });

  const changedFiles = [];
  let totalReplacements = 0;

  for (const abs of files) {
    try {
      const { changed, replacements } = await stripExtensionsInFile(
        projectRoot,
        abs,
        patterns,
        project,
      );
      if (changed) {
        changedFiles.push(path.relative(projectRoot, abs).split(path.sep).join('/'));
        totalReplacements += replacements;
      }
    } catch {
      // best-effort
    }
  }

  return { changedFiles, totalReplacements };
}

module.exports = {
  stripImportExtensions,
  stripExtensionsInFile,
  stripExtensionFromSpec,
  isLocalSpecifier,
};
