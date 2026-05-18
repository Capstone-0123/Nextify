// app/src/utils/ensure-nextify-excludes.cjs
//
// Nextify 가 만들거나 활용하는 *내부 산출물* 디렉토리를 사용자 빌드/타입체크
// 영역에서 일관되게 제외하기 위한 안전망.
//
// 대상 디렉토리:
//   - `.ai-migration/`        : `--review` 모드의 IDE diff 검토 세션 / 단계별 스냅샷
//   - `__nextify_snapshots/`  : `pre-step7` 스냅샷 등 성능 비교용 사본
//
// 두 디렉토리 모두 *부분 변환된 코드* 를 들고 있어, 사용자 프로젝트의
// `tsc` / `next build` 가 같이 들여다보면 syntax / 미사용변수 등으로
// 빌드를 실패시킨다. step1 직후에 한 번 보강해 두면 이후 모든 단계와
// 사용자의 후속 빌드가 안전해진다.
//
// 안전 기준:
//   - 파일/JSON 파싱이 실패하면 그 자리만 건너뛰고 마이그레이션 자체는 막지 않는다.
//   - 이미 동일 라인이 있으면 중복 추가하지 않는다.

const fs = require('fs-extra');
const path = require('path');

/** 항상 보강할 exclude / ignore 항목들. */
const NEXTIFY_TS_EXCLUDES = [
  '.ai-migration',
  '__nextify_snapshots',
  '**/__nextify_snapshots/**',
];
const NEXTIFY_GITIGNORE_LINES = [
  '.ai-migration',
  '__nextify_snapshots',
  'nextify-*.txt',
  'nextify-*.md',
];

/**
 * tsconfig.json 의 `exclude` 배열에 NEXTIFY_TS_EXCLUDES 를 보강한다.
 * - JSONC (주석 포함) 파일은 건드리지 않고 보너스 로그만 남긴다.
 * - exclude 가 없으면 새로 만든다.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ updated: boolean, reason?: string }>}
 */
async function ensureTsConfigExcludes(projectRoot) {
  const p = path.join(projectRoot, 'tsconfig.json');
  if (!(await fs.pathExists(p))) {
    return { updated: false, reason: 'no_tsconfig' };
  }
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (e) {
    return { updated: false, reason: `read_error:${e?.message || e}` };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // tsconfig 가 JSONC(주석 포함)인 경우 안전하게 패스. 사용자가 직접 처리하도록 둔다.
    return { updated: false, reason: 'jsonc_or_invalid_json' };
  }
  const before = Array.isArray(json.exclude) ? json.exclude.slice() : [];
  const merged = before.slice();
  let changed = false;
  for (const item of NEXTIFY_TS_EXCLUDES) {
    if (!merged.includes(item)) {
      merged.push(item);
      changed = true;
    }
  }
  if (!changed) return { updated: false, reason: 'already_excluded' };

  json.exclude = merged;
  try {
    await fs.writeFile(p, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    return { updated: true };
  } catch (e) {
    return { updated: false, reason: `write_error:${e?.message || e}` };
  }
}

/**
 * .gitignore 에 NEXTIFY_GITIGNORE_LINES 를 보강한다.
 * - 파일이 없으면 만든다.
 * - 이미 있는 라인은 다시 추가하지 않는다.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ updated: boolean, addedLines: string[] }>}
 */
async function ensureGitignoreLines(projectRoot) {
  const p = path.join(projectRoot, '.gitignore');
  let prev = '';
  if (await fs.pathExists(p)) {
    try {
      prev = await fs.readFile(p, 'utf8');
    } catch {
      prev = '';
    }
  }
  const present = new Set(
    prev.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  const toAdd = NEXTIFY_GITIGNORE_LINES.filter((l) => !present.has(l));
  if (toAdd.length === 0) return { updated: false, addedLines: [] };

  const eol = prev.includes('\r\n') ? '\r\n' : '\n';
  const needsTrailingEol = prev.length > 0 && !/\r?\n$/.test(prev);
  const block = `${needsTrailingEol ? eol : ''}${eol}# Nextify${eol}${toAdd.join(eol)}${eol}`;
  try {
    await fs.writeFile(p, prev + block, 'utf8');
    return { updated: true, addedLines: toAdd };
  } catch {
    return { updated: false, addedLines: [] };
  }
}

/**
 * step1 등에서 한 번 호출한다. 실패해도 마이그레이션을 막지 않는다.
 *
 * @param {string} projectRoot
 */
async function ensureNextifyExcludes(projectRoot) {
  const ts = await ensureTsConfigExcludes(projectRoot);
  const gi = await ensureGitignoreLines(projectRoot);
  return { tsconfig: ts, gitignore: gi };
}

module.exports = {
  ensureNextifyExcludes,
  ensureTsConfigExcludes,
  ensureGitignoreLines,
};
