// src/step3/index.cjs
// Step 3: 메타데이터 마이그레이션 (React Helmet → Next.js Metadata API)

const { migrateMetadata } = require('./metadata-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 3 메인 실행 함수
 */
async function runStep3(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 3: 메타데이터 마이그레이션 시작...'));

  // 메타데이터 마이그레이션 실행
  console.log(chalk.blue.bold('--메타데이터 변환 시작'));
  await migrateMetadata(projectRoot);
  console.log(chalk.blue.bold('--메타데이터 변환 완료'));

  console.log(chalk.green.bold('✅ Step 3 모든 작업 완료!'));
}

module.exports = { runStep3 };
