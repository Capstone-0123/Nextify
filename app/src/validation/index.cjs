'use strict';

// app/src/validation/index.cjs
// Step7 밖으로 분리한 타입 검사 + 결정론/AI 보정 + 리포트 진입점.

const { runFinalTypecheckReport } = require('./typecheck-report.cjs');
const {
  runStaticImportScan,
  writeStaticImportReport,
} = require('./static-import-scan.cjs');

/**
 * 마이그레이션 결과 프로젝트에 대해 tsc 기반 검증·자동 수정·리포트를 실행한다.
 * @param {string} projectRoot
 * @param {{
 *   autofix?: boolean,
 *   aiFix?: boolean,
 *   aiFixBudget?: number,
 * }} [options]
 */
async function runValidation(projectRoot, options = {}) {
  return runFinalTypecheckReport(projectRoot, {
    autofix: options.autofix !== false,
    aiFix: options.aiFix !== false,
    aiFixBudget: options.aiFixBudget,
  });
}

module.exports = {
  runValidation,
  runFinalTypecheckReport,
  runStaticImportScan,
  writeStaticImportReport,
};
