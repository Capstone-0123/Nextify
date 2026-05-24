// src/step5/index.cjs
// Step 5: "use client" 처리 및 Zustand 상태 관리 마이그레이션
const { migrateBrowserAPIs } = require('./browser-api-migrator.cjs');
const { migrateZustandStores } = require('./zustand-migrator.cjs');
const { migrateUseClient } = require('./useclient-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 5 메인 실행 함수
 */
async function runStep5(projectRoot) {
  console.log(chalk.gray('──────────────────────────────────────────────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[5단계] 서버·클라이언트 호환성 작업을 시작합니다.'));

  try {
    console.log('  → 클라이언트 전용 컴포넌트를 판별해 "use client" 지시문을 추가하는 중.');
    await migrateUseClient(projectRoot);
    console.log('  ✔ "use client" 추가 완료\n');

    console.log('  → 브라우저 전용 API 사용 코드를 탐색하는 중.');
    await migrateBrowserAPIs(projectRoot);
    console.log('  ✔ 브라우저 API 호환 처리 완료\n');

    console.log('  → Zustand 스토어를 분석해 SSR 안전 구조로 변환하는 중.');
    const result = await migrateZustandStores(projectRoot);
    console.log('  ✔ Zustand 스토어 변환 완료');

    console.log(chalk.green.bold('[5단계] 완료 — 서버·클라이언트 호환성 작업이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('파트 5 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep5 };
