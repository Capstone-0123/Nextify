// Step 3: Route, Link, Outlet 마이그레이션 + 메타데이터 마이그레이션

const { migrateMetadata } = require('./metadata-migrator.cjs');
const { migrateRoutes } = require('./route-migrator.cjs');
const { migrateLinks } = require('./link-migrator.cjs');
const { migrateOutlets } = require('./outlet-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 3 메인 실행 함수
 */
async function runStep3(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 3: Route, Link, Outlet 마이그레이션 시작...'));

  // 1. Route 마이그레이션 (page.tsx, layout.tsx 생성)
  console.log(chalk.blue.bold('--Route 마이그레이션 시작'));
  await migrateRoutes(projectRoot);
  console.log(chalk.blue.bold('--Route 마이그레이션 완료'));

  // 2. Link 마이그레이션
  console.log(chalk.blue.bold('--Link 마이그레이션 시작'));
  await migrateLinks(projectRoot);
  console.log(chalk.blue.bold('--Link 마이그레이션 완료'));

  // 3. Outlet 마이그레이션
  console.log(chalk.blue.bold('--Outlet 마이그레이션 시작'));
  await migrateOutlets(projectRoot);
  console.log(chalk.blue.bold('--Outlet 마이그레이션 완료'));

  // 4. 메타데이터 마이그레이션 실행
  console.log(chalk.blue.bold('--메타데이터 변환 시작'));
  await migrateMetadata(projectRoot);
  console.log(chalk.blue.bold('--메타데이터 변환 완료'));

  console.log(chalk.green.bold('✅ Step 3 모든 작업 완료!'));
}

module.exports = { runStep3 };
