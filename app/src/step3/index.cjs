// Step 3: Route, Link, Outlet 마이그레이션 + 메타데이터 마이그레이션

const { migrateMetadata } = require('./metadata-migrator.cjs');
const { migrateRoutes } = require('./route-migrator.cjs');
const { migrateLinks } = require('./link-migrator.cjs');
const { migrateOutlets } = require('./outlet-migrator.cjs');
const chalk = require('chalk');
const {
  isMechanicalMigrationRerun,
} = require('../utils/manual-flow.cjs');

/**
 * Step 3 메인 실행 함수
 */
async function runStep3(projectRoot) {
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

  // 4. 메타데이터 마이그레이션 실행 (AI 거절 후 사용자 직접반영 시 동일 작업을 처음부터 재실행)
  let metadataReruns = 0;
  while (true) {
    try {
      console.log('메타데이터 변환 시작');
      await migrateMetadata(projectRoot);
      console.log('메타데이터 변환 완료');
      break;
    } catch (e) {
      if (!isMechanicalMigrationRerun(e)) {
        throw e;
      }
      metadataReruns += 1;
      console.log(
        chalk.cyan(
          `\n(메타데이터 마이그레이션 재실행 ${metadataReruns})\n`
        )
      );
    }
  }

  console.log(chalk.green.bold('파트 3 완료'));
}

module.exports = { runStep3 };
