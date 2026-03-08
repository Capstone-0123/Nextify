// src/step6/index.cjs
// Step 6: 환경 변수 설정 & 의존성 갱신 가이드

const { runEnvAndDependencyGuide } = require('./env-guide.cjs');
const chalk = require('chalk');

/**
 * Step 6 메인 실행 함수
 */
async function runStep6(projectRoot) {
  console.log(chalk.blue.bold('파트 6 시작'));

  try {
    console.log('환경 변수 설정 및 의존성 가이드 시작');
    await runEnvAndDependencyGuide(projectRoot);
    console.log('환경 변수 설정 및 의존성 가이드 완료');

    console.log(chalk.green.bold('파트 6 완료'));
  } catch (error) {
    console.error(chalk.red.bold('파트 6 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep6 };
