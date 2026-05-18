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
  try {
    console.log(chalk.blue.bold('파트 3 시작'));

    // 1. Route 마이그레이션 (page.tsx, layout.tsx 생성)
    console.log('Route 마이그레이션 시작');
    await migrateRoutes(projectRoot);
    console.log('Route 마이그레이션 완료');

    // 2. Link 마이그레이션
    console.log('Link 마이그레이션 시작');
    await migrateLinks(projectRoot);
    console.log('Link 마이그레이션 완료');

    // 3. Outlet 마이그레이션
    console.log('Outlet 마이그레이션 시작');
    await migrateOutlets(projectRoot);
    console.log('Outlet 마이그레이션 완료');

    // 4. 메타데이터 마이그레이션 실행
    console.log('메타데이터 변환 시작');
    await migrateMetadata(projectRoot);
    console.log('메타데이터 변환 완료');

    console.log(chalk.green.bold('파트 3 완료'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 3 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep3 };
