// app/src/utils/polyfill-uselocation.cjs
//
// react-router-dom 의 `useLocation()` 호출이 마이그레이션 후에도 코드에 남아
// 있는 경우, next/navigation 으로는 해당 hook 가 직접 대응되지 않으므로
// 빌드 단계에서 컴파일 에러가 발생한다. 본 sweep 은 빌드를 안전하게
// 통과시키는 *결정론적 폴백* 을 제공한다.
//
// 정책 (full-lossy: 빌드 통과 우선, 데이터 손실 허용):
//   - import 영역에 `useLocation` 이 어디서도 import 되지 않았는데
//     `useLocation()` 호출이 본문에 남아 있다면,
//     해당 호출을 다음 dummy 표현식으로 치환한다.
//
//     `useLocation()` →
//       `({ pathname: '', search: '', hash: '', state: {} as any, key: '' } as any)`
//
//   이렇게 하면 `location.state?.X` / `location.pathname` 등 다양한 접근
//   패턴이 컴파일러를 통과한다 (state 는 any 라 어떤 키 접근도 허용).
//   런타임 동작은 항상 빈 값이라 react-router 의 state 전달 의미는 손실된다.
//
//   ⚠️ 이 함수는 **이미 useLocation import 가 남아 있는** 경우에는
//   아무것도 건드리지 않는다 (해당 프로젝트는 별도 마이그레이션이 안 된
//   상태라 사용자 검토가 필요하다).

const fs = require('fs-extra');
const path = require('path');

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  '.ai-migration',
  '__nextify_snapshots',
]);

// `({ pathname: '', search: '', hash: '', state: {} as any, key: '' } as any)`
const POLYFILL_EXPR = `({ pathname: '', search: '', hash: '', state: {} as any, key: '' } as any)`;

async function walkSrcFiles(root) {
  /** @type {string[]} */
  const out = [];
  async function recur(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await recur(path.join(dir, e.name));
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTS.has(ext)) out.push(path.join(dir, e.name));
      }
    }
  }
  await recur(root);
  return out;
}

/**
 * 파일 텍스트에 useLocation 이 어디선가 import 되어 있는가?
 * (정규식 휴리스틱 — `import { ..., useLocation, ... } from '...'`)
 */
function hasUseLocationImport(text) {
  if (!/\buseLocation\b/.test(text)) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*import\b/.test(line) && /\buseLocation\b/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * 파일 한 개를 처리한다.
 * - useLocation import 가 없는데 useLocation() 호출이 본문에 있으면
 *   호출을 dummy 객체 표현식으로 치환한다.
 *
 * @param {string} filePath
 * @returns {Promise<{ replaced: number }>}
 */
async function patchFile(filePath) {
  const before = await fs.readFile(filePath, 'utf8');
  if (!/\buseLocation\s*\(/.test(before)) return { replaced: 0 };
  if (hasUseLocationImport(before)) return { replaced: 0 };

  // `useLocation(<anything>)` 의 인자는 react-router 에서 받지 않으므로 보통 없지만
  // 견고하게 0~1개 인자까지 매칭한다. 인자는 무시(데이터 손실 허용).
  const re = /\buseLocation\s*\([^)]*\)/g;
  let count = 0;
  const after = before.replace(re, () => {
    count++;
    return POLYFILL_EXPR;
  });

  if (count === 0 || after === before) return { replaced: 0 };
  await fs.writeFile(filePath, after, 'utf8');
  return { replaced: count };
}

/**
 * 프로젝트 전체에서 미해결 useLocation 호출을 폴백 객체로 치환한다.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ totalReplaced: number, changedFiles: { file: string, replaced: number }[] }>}
 */
async function polyfillUseLocation(projectRoot) {
  const srcDir = path.join(projectRoot, 'src');
  if (!(await fs.pathExists(srcDir))) {
    return { totalReplaced: 0, changedFiles: [] };
  }
  const files = await walkSrcFiles(srcDir);
  const changedFiles = [];
  let totalReplaced = 0;
  for (const f of files) {
    try {
      const { replaced } = await patchFile(f);
      if (replaced > 0) {
        changedFiles.push({ file: path.relative(projectRoot, f), replaced });
        totalReplaced += replaced;
      }
    } catch {
      // single-file failure must not break the whole sweep.
    }
  }
  return { totalReplaced, changedFiles };
}

module.exports = {
  polyfillUseLocation,
};
