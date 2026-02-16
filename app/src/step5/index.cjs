// src/step5/index.cjs
// Step 5: 브라우저 전용 API 최상단 접근 제어

const { migrateBrowserAPIs } = require('./browser-api-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 5 메인 실행 함수
 */
async function runStep5(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 5: 브라우저 전용 API 최상단 접근 제어 시작...'));

  await migrateBrowserAPIs(projectRoot);

  console.log(chalk.green.bold('✅ Step 5 모든 작업 완료!'));
}

module.exports = { runStep5 };
