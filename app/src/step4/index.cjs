// src/step4/index.cjs
// Step 4: 스타일/리소스 마이그레이션

const { migrateTailwindAndStyled } = require('./tailwind-styled-migrator.cjs');
const { migrateGlobalCss } = require('./globalcss-migrator.cjs');
const { migrateStaticResources } = require('./asset-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 4 메인 실행 함수
 */
async function runStep4(projectRoot) {
  console.log(chalk.gray('──────────────────────────────────────────────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[4단계] 스타일 및 리소스 마이그레이션을 시작합니다.'));

  try {
    // Global CSS 마이그레이션
    console.log('  → 전역 CSS 파일을 src/app/global.css로 통합하는 중.');
    await migrateGlobalCss(projectRoot);
    console.log('  ✔ Global CSS 통합 완료\n');

    // 정적 리소스 마이그레이션
    console.log('  → 정적 리소스를 public 폴더로 이동하고 참조 경로를 수정하는 중.');
    await migrateStaticResources(projectRoot);
    console.log('  ✔ 정적 리소스 이동 완료\n');

    // Tailwind CSS 및 Styled Components 마이그레이션
    console.log('  → Tailwind·styled-components 설정을 Next.js에 맞게 업데이트하는 중.');
    await migrateTailwindAndStyled(projectRoot);
    console.log('  ✔ 스타일 라이브러리 설정 완료');

    console.log(chalk.green.bold('[4단계] 완료 — 스타일 및 리소스 마이그레이션이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 4 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep4 };
