// src/step4/index.cjs
// Step 4: Tailwind CSS 및 Styled Components 자동 설정

const { migrateTailwindAndStyled } = require('./tailwind-styled-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 4 메인 실행 함수
 */
async function runStep4(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 4: Tailwind CSS 및 Styled Components 설정 시작...'));

  await migrateTailwindAndStyled(projectRoot);

  console.log(chalk.green.bold('✅ Step 4 모든 작업 완료!'));
}

module.exports = { runStep4 };
