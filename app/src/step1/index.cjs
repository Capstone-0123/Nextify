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
  console.log(chalk.gray('────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[1단계] 프로젝트 환경 설정을 시작합니다…'));

  try {
    await ensureWatcherFriendlySettings(projectRoot);
  } catch {
    // ignore — 안전망 자체가 마이그레이션을 막지 않음
  }

  console.log('  → package.json에 Next.js 관련 패키지와 실행 스크립트를 추가하는 중…');
  await updatePackageJson(projectRoot);
  console.log('  ✔ package.json 업데이트 완료\n');

  console.log('  → Vite 전용 설정 파일을 제거하고 next.config.mjs 및 .gitignore를 설정하는 중…');
  await setupConfigFiles(projectRoot);
  console.log('  ✔ 설정 파일 정리 및 생성 완료\n');

  console.log('  → vite.config.ts 설정을 분석해 Next.js 형식으로 변환하는 중…');
  await migrateViteConfig(projectRoot);
  await migrateViteDefine(projectRoot);
  console.log('  ✔ Vite 설정 변환 완료 (vite.config.ts 제거됨)\n');

  console.log('  → tsconfig.app.json의 컴파일러 옵션을 tsconfig.json으로 이관하고 Next.js 기준으로 정리하는 중…');
  await updateTsConfig(projectRoot);
  console.log('  ✔ TypeScript 설정 통합 완료 (tsconfig.app.json 제거됨)');

  console.log(chalk.green.bold('[1단계] 완료 — 프로젝트 환경 설정이 끝났습니다.'));
}

module.exports = { runStep1 };
