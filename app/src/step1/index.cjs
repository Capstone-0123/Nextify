// Step 1: 환경 설정 - 패키지, 설정파일

const {
  updatePackageJson,
  setupConfigFiles,
  migrateViteConfig,
  migrateViteDefine,
  updateTsConfig,
} = require('./step1-env.cjs');
const { ensureWatcherFriendlySettings } = require('../utils/watcher-friendly.cjs');
const chalk = require('chalk');

/**
 * Step 1 메인 실행 함수
 */
async function runStep1(projectRoot) {
  try {
    console.log(chalk.blue.bold('파트 1 시작'));

    // 0. (사전) 워처 친화 설정 — .ai-migration/, node_modules/ 등을 .vscode/settings.json에서 제외해
    //    F5 Extension Development Host에서 EMFILE 무한 루프가 뜨지 않도록 함.
    //    파싱 실패/쓰기 실패 등은 모두 마이그레이션을 막지 않음.
    try {
      await ensureWatcherFriendlySettings(projectRoot);
    } catch {
      // ignore — 안전망 자체가 마이그레이션을 막지 않음
    }

    // 1. package.json 수정
    console.log('package.json 의존성 및 스크립트 수정 시작');
    await updatePackageJson(projectRoot);
    console.log('package.json 의존성 및 스크립트 수정 완료');

    // 2. 설정 파일 업데이트 및 정리
    console.log('설정 파일 업데이트 시작');
    await setupConfigFiles(projectRoot);
    console.log('설정 파일 업데이트 완료');

    // 3. vite.config.ts 설정 마이그레이션
    console.log('vite.config.ts 설정 마이그레이션 시작');
    await migrateViteConfig(projectRoot);
    console.log('vite.config.ts 설정 마이그레이션 완료');

    // 4. TypeScript 설정 정리
    console.log('TypeScript 컴파일러 설정 정리 시작');
    await updateTsConfig(projectRoot);
    console.log('TypeScript 컴파일러 설정 정리 완료');

    console.log(chalk.green.bold('파트 1 완료'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 1 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep1 };
