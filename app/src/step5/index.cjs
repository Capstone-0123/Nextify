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
  console.log(chalk.blue.bold('파트 5 시작'));

  try {
    // "use client" 마이그레이션 실행
    console.log('"use client" 처리 시작');
    await migrateUseClient(projectRoot);
    console.log('"use client" 처리 완료');

    // 브라우저 전용 API 최상단 접근 제어 마이그레이션 실행
    console.log('브라우저 전용 API 최상단 접근 제어 시작');
    await migrateBrowserAPIs(projectRoot);
    console.log('브라우저 전용 API 최상단 접근 제어 완료');

    // Zustand 스토어 마이그레이션 실행
    console.log('Zustand 상태 관리 마이그레이션 시작');
    const result = await migrateZustandStores(projectRoot);
    console.log('Zustand 상태 관리 마이그레이션 완료');

    console.log(chalk.green.bold('파트 5 완료'));
  } catch (error) {
    console.error(chalk.red.bold('파트 5 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep5 };
