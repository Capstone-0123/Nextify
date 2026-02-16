// Step 4: 스타일/리소스 마이그레이션

const { migrateGlobalCss } = require('./globalcss-migrator.cjs');
const { migrateStaticResources } = require('./asset-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 4 메인 실행 함수
 */
async function runStep4(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 4: 스타일/리소스 마이그레이션 시작...'));

  // Global CSS 마이그레이션
  console.log(chalk.blue.bold('--Global CSS 마이그레이션 시작'));
  await migrateGlobalCss(projectRoot);
  console.log(chalk.blue.bold('--Global CSS 마이그레이션 완료'));

  // 정적 리소스 마이그레이션
  console.log(chalk.blue.bold('--정적 리소스 마이그레이션 시작'));
  await migrateStaticResources(projectRoot);
  console.log(chalk.blue.bold('--정적 리소스 마이그레이션 완료'));

  console.log(chalk.green.bold('✅ Step 4 모든 작업 완료!'));
}

module.exports = { runStep4 };

