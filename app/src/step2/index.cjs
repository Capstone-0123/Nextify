// src/step2/index.cjs
// Step 2: 구조 변환 - 레이아웃, Provider 생성
// Note: 홈 페이지 생성은 step3의 route-migrator.cjs에서 처리됩니다.

const { generateLayout } = require('./layout-generator.cjs');
const { migrateProviders } = require('./provider-generator.cjs');
const chalk = require('chalk');

/**
 * Step 2 메인 실행 함수
 */
async function runStep2(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 2: 구조 변환 시작...'));

  // 1. 레이아웃 생성 (index.html -> app/layout.tsx)
  console.log(chalk.blue.bold('--레이아웃 생성 시작'));
  await generateLayout(projectRoot);
  console.log(chalk.blue.bold('--레이아웃 생성 완료'));

  // 2. Provider 마이그레이션 (React Query, ThemeProvider 등 -> src/app/providers.tsx)
  console.log(chalk.blue.bold('--Provider 마이그레이션 시작'));
  await migrateProviders(projectRoot);
  console.log(chalk.blue.bold('--Provider 마이그레이션 완료'));

  console.log(chalk.green.bold('✅ Step 2 모든 작업 완료!'));
}

module.exports = { runStep2 };
