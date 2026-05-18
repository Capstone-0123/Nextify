// Step 1: 환경 설정 - 패키지, 설정파일

const {
  updatePackageJson,
  setupConfigFiles,
  migrateViteConfig,
  migrateViteDefine,
  updateTsConfig,
} = require('./step1-env.cjs');
const { ensureWatcherFriendlySettings } = require('../utils/watcher-friendly.cjs');
const { ensureNextifyExcludes } = require('../utils/ensure-nextify-excludes.cjs');
const chalk = require('chalk');

/**
 * Step 1 메인 실행 함수
 */
async function runStep1(projectRoot) {
  console.log(chalk.gray('────────────────────────────────────────────────────────────'));
  console.log(chalk.blue.bold('[1단계] 프로젝트 환경 설정을 시작합니다…'));

  try {
    // 0. (사전) 워처 친화 설정 — .ai-migration/, node_modules/ 등을 .vscode/settings.json에서 제외해
    //    F5 Extension Development Host에서 EMFILE 무한 루프가 뜨지 않도록 함.
    //    파싱 실패/쓰기 실패 등은 모두 마이그레이션을 막지 않음.
    try {
      await ensureWatcherFriendlySettings(projectRoot);
    } catch {
      // ignore — 안전망 자체가 마이그레이션을 막지 않음
    }

    // 1. package.json 수정
    console.log('  → package.json에 Next.js 관련 패키지와 실행 스크립트를 추가하는 중…');
    await updatePackageJson(projectRoot);
    console.log('  ✔ package.json 업데이트 완료\n');

    // 2. 설정 파일 업데이트 및 정리
    console.log('  → Vite 전용 설정 파일을 제거하고 next.config.mjs 및 .gitignore를 설정하는 중…');
    await setupConfigFiles(projectRoot);
    console.log('  ✔ 설정 파일 정리 및 생성 완료\n');

    // 3. vite.config.ts 설정 마이그레이션
    console.log('  → vite.config.ts 설정을 분석해 Next.js 형식으로 변환하는 중…');
    await migrateViteConfig(projectRoot);
    await migrateViteDefine(projectRoot);
    console.log('  ✔ Vite 설정 변환 완료 (vite.config.ts 제거됨)\n');

    // 4. TypeScript 설정 정리
    console.log('  → tsconfig.app.json의 컴파일러 옵션을 tsconfig.json으로 이관하고 Next.js 기준으로 정리하는 중…');
    await updateTsConfig(projectRoot);
    console.log('  ✔ TypeScript 설정 통합 완료 (tsconfig.app.json 제거됨)');

    // 5. Nextify 내부 산출물(.ai-migration, __nextify_snapshots) 을
    //    tsconfig.exclude / .gitignore 에서 제외해 사용자 빌드가
    //    부분 변환 스냅샷까지 type-check 하면서 깨지는 사고를 차단한다.
    try {
      const result = await ensureNextifyExcludes(projectRoot);
      if (result.tsconfig.updated) {
        console.log(
          chalk.gray('   🛡️  tsconfig.json exclude 보강: .ai-migration, __nextify_snapshots'),
        );
      }
      if (result.gitignore.updated && result.gitignore.addedLines.length > 0) {
        console.log(
          chalk.gray(`   🛡️  .gitignore 보강: ${result.gitignore.addedLines.join(', ')}`),
        );
      }
    } catch {
      // 안전망 자체의 실패는 마이그레이션을 막지 않는다.
    }

    console.log(chalk.green.bold('[1단계] 완료 — 프로젝트 환경 설정이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('\n❌ Step 1 오류 발생:'), error?.message || error);
    throw error;
  }
}

module.exports = { runStep1 };
