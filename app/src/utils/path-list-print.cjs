'use strict';

/**
 * 터미널이 수천 줄이 되지 않도록 경로 목록 표시 상한 (환경 변수로 조절)
 * @returns {number}
 */
function getPathListPreviewMax() {
  const n = Number.parseInt(process.env.NEXTIFY_PATH_LIST_PREVIEW_MAX, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 500);
  return 60;
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function normalizeRelPathsForDisplay(paths) {
  return [...new Set((paths || []).map((p) => String(p).replace(/\\/g, '/').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'en')
  );
}

/**
 * 경로를 한 줄에 하나씩 출력. 개수가 많으면 상한까지만 보여 주고 나머지는 요약.
 * @param {(s: string) => string} style chalk.gray / chalk.green 등
 * @param {string} leadLine 제목(개수는 함수가 붙임). 예: "  발견 위치", "\n✅ Gemini 적용 완료"
 * @param {string[]} paths
 */
function printRelPathsBlock(style, leadLine, paths, indent = '') {
  const list = normalizeRelPathsForDisplay(paths);
  const max = getPathListPreviewMax();
  if (list.length === 0) {
    console.log(style(`${indent}${leadLine} (0개):`));
    return;
  }
  console.log(style(`${indent}${leadLine} (${list.length}개):`));
  const preview = list.slice(0, max);
  for (const p of preview) {
    console.log(style(`${indent}    ${p}`));
  }
  const omitted = list.length - preview.length;
  if (omitted > 0) {
    console.log(
      style(
        `${indent}  … 외 ${omitted}개 (총 ${list.length}개, 표시 상한 ${max} — NEXTIFY_PATH_LIST_PREVIEW_MAX 로 변경)`
      )
    );
  }
}

module.exports = {
  getPathListPreviewMax,
  normalizeRelPathsForDisplay,
  printRelPathsBlock,
};
