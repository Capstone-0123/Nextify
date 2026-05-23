// Step 2: 구조 변환 - 레이아웃, Provider 생성
// Note: 홈 페이지 생성은 step3의 route-migrator.cjs에서 처리됩니다.

const { generateLayout } = require('./layout-generator.cjs');
const { migrateProviders } = require('./provider-generator.cjs');
const chalk = require('chalk');

/**
 * Step 2 메인 실행 함수
 */
async function runStep2(projectRoot) {
  console.log(chalk.gray('────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[2단계] 앱 구조 변환을 시작합니다…'));

  try {
    // 1. 레이아웃 생성 (index.html -> app/layout.tsx)
    console.log('  → index.html을 분석해 Next.js용 루트 레이아웃(layout.tsx)으로 변환하는 중…');
    await generateLayout(projectRoot);
    console.log('  ✔ layout.tsx 생성 완료 (HTML → JSX 변환, Vite 전용 스크립트 제거됨)\n');

    // 2. Provider 마이그레이션 (React Query, ThemeProvider 등 -> src/app/providers.tsx)
    console.log('  → main.tsx·App.tsx에서 Provider 컴포넌트를 탐색해 src/app/providers.tsx로 통합하는 중…');
    await migrateProviders(projectRoot);
    console.log('  ✔ providers.tsx 생성 완료 (layout.tsx에 <Providers> 적용됨)');

    console.log(chalk.green.bold('[2단계] 완료 — 앱 구조 변환이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 2 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep2 };
