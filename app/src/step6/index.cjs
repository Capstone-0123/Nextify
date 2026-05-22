// src/step6/index.cjs
// Step 6: Next.js 심화 변환

const { runAdvancedMigration } = require('../step7/index.cjs');

/**
 * Step 6 메인 실행 함수: Next.js 심화 변환을 실행한다.
 */
async function runStep6(projectRoot, options = {}) {
  return runAdvancedMigration(projectRoot, options);
}

module.exports = { runStep6 };
