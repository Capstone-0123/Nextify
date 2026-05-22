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
  console.log(chalk.gray('──────────────────────────────────────────────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[3단계] 라우팅 구조 변환을 시작합니다.'));

  try {
    // 1. Route 마이그레이션 (page.tsx, layout.tsx 생성)
    console.log('  → React Router의 Route 구조를 분석해 Next.js 폴더·파일 구조로 변환하는 중.');
    await migrateRoutes(projectRoot);
    console.log('  ✔ Route 구조 변환 완료\n');

    // 2. Link 마이그레이션
    console.log('  → React Router의 link·hook을 Next.js 방식으로 교체하는 중.');
    await migrateLinks(projectRoot);
    console.log('  ✔ link·hook 교체 완료\n');

    // 3. Outlet 마이그레이션
    console.log('  → React Router의 Outlet을 Next.js children 구조로 변환하는 중.');
    await migrateOutlets(projectRoot);
    console.log('  ✔ Outlet 변환 완료\n');

    // 4. 메타데이터 마이그레이션 실행
    console.log('  → Helmet·Head 태그를 Next.js Metadata API로 변환하는 중.');
    await migrateMetadata(projectRoot);
    console.log('  ✔ Metadata 변환 완료');

    console.log(chalk.green.bold('[3단계] 완료 — 라우팅 구조 변환이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 3 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep3 };
