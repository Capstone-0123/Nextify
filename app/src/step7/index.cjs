// src/step7/index.cjs
// Step 7: next/image 적용, next/font 적용, Dynamic Import 적용 및 남겨둔 React 흔적 정리

const { applyNextImage } = require('./next-image-migrator.cjs');
const { applyNextFont } = require('./next-font-migrator.cjs');
const { optimizeDynamicImport } = require('./dynamic-import-migrator.cjs');
const { cleanReactTrace } = require('./react-trace-cleaner.cjs');
const { minimizeUseClientForBundle } = require('./useclient-minimizer.cjs');
const { optimizeDataFetchingPlacement } = require('./data-fetch-migrator.cjs');
const { generatePerformanceReport, createPreStep7Snapshot } = require('./performance-report.cjs');
const { runFinalTypecheckReport } = require('./typecheck-report.cjs');
const chalk = require('chalk');
const path = require('path');

/**
 * Step 7 메인 실행 함수
 */
async function runStep7(projectRoot, options = {}) {
  try {
    // report-only 모드: 마이그레이션을 다시 돌리지 않고 레포트만 생성
    if (options.reportOnly) {
      const outputPath = options.outputPath || path.join(projectRoot, 'nextify-performance-report.md');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot: options.baselineViteRoot,
        preStep7Root: options.preStep7Root,
        outputMarkdownPath: outputPath,
        lighthouseRuns: options.lighthouseRuns,
        warmupRuns: options.warmupRuns,
      });
      return;
    }

    // Step7 적용 전 백업 (step1~6 결과물 보존)
    if (options.report) {
      console.log(chalk.gray('────────────────────────────────────────────────────────────'));
      console.log('· step7(최적화) 적용 전 프로젝트를 백업합니다. (step1~6 결과 보존)');
      const snapshotPath = await createPreStep7Snapshot(projectRoot);
      console.log(`  ✔ 백업 완료: ${snapshotPath}`);
    }

    console.log(chalk.gray('────────────────────────────────────────────────────────────'));
    console.log(chalk.blue.bold('[7단계] Next.js 성능 최적화를 시작합니다…'));

    console.log('  → 이미지를 next/image로 교체해 로딩 성능을 개선하는 중…');
    await applyNextImage(projectRoot);
    console.log('  ✔ next/image 적용 완료\n');

    console.log('  → Google Fonts·로컬 폰트를 next/font로 전환하는 중…');
    await applyNextFont(projectRoot);
    console.log('  ✔ next/font 전환 완료\n');

    console.log('  → 클라이언트 데이터 패칭 코드를 탐색하는 중…');
    await optimizeDataFetchingPlacement(projectRoot);
    console.log('  ✔ 데이터 패칭 위치 최적화 완료\n');

    console.log('  → "use client" 범위를 분석해 불필요한 지시문을 제거하는 중…');
    await minimizeUseClientForBundle(projectRoot);
    console.log('  ✔ "use client" 최소화 완료\n');

    console.log('  → 무거운 컴포넌트를 Dynamic Import로 분리해 초기 번들을 줄이는 중…');
    await optimizeDynamicImport(projectRoot);
    console.log('  ✔ Dynamic Import 적용 완료\n');

    console.log('  → 마이그레이션 과정에서 남은 React·Vite 파일과 패키지를 정리하는 중…');
    await cleanReactTrace(projectRoot);
    console.log('  ✔ 잔여 파일·패키지 정리 완료\n');

    try {
      console.log('  → TypeScript 타입 검사를 실행하고 에러를 자동으로 수정하는 중…');
      await runFinalTypecheckReport(projectRoot, {
        autofix: options.typecheckAutofix !== false,
        aiFix: options.typecheckAiFix !== false,
        aiFixBudget: options.typecheckAiFixBudget,
      });
      console.log('  ✔ TypeScript 타입 검사 완료');
    } catch (typecheckErr) {
      console.log(chalk.gray(`    ⚠️ 타입 검사 단계 무시: ${typecheckErr?.message || typecheckErr}`));
    }

    if (options.report) {
      const outputPath = options.outputPath || path.join(projectRoot, 'nextify-performance-report.md');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot: options.baselineViteRoot,
        preStep7Root: options.preStep7Root,
        outputMarkdownPath: outputPath,
        lighthouseRuns: options.lighthouseRuns,
        warmupRuns: options.warmupRuns,
      });
    }

    console.log(chalk.green.bold('[7단계] 완료 — 성능 최적화가 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('파트 7 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep7 };
