// src/step6/index.cjs
// Step 6: 환경 변수 설정 & 의존성 갱신 가이드

const { runEnvAndDependencyGuide } = require('./env-guide.cjs');
const chalk = require('chalk');

/**
 * Step 6 메인 실행 함수
 */
async function runStep6(projectRoot, options = {}) {
  console.log(chalk.gray('────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[6단계] 환경 변수 및 의존성 설정 안내'));

  try {
    await runEnvAndDependencyGuide(projectRoot, { reportPath: options.reportPath });
    console.log(chalk.green.bold('[6단계] 완료 — 위 안내에 따라 설정을 완료하세요.'));
  } catch (error) {
    console.error(chalk.red.bold('파트 6 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep6 };
