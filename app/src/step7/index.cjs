// src/step7/index.cjs
// Step 7: next/image 적용, next/font 적용, Dynamic Import 적용 및 남겨둔 React 흔적 정리

const { applyNextImage } = require('./next-image-migrator.cjs');
const { applyNextFont } = require('./next-font-migrator.cjs');
const { optimizeDynamicImport } = require('./dynamic-import-migrator.cjs');
const { cleanReactTrace } = require('./react-trace-cleaner.cjs');
const { minimizeUseClientForBundle } = require('./useclient-minimizer.cjs');
const { optimizeDataFetchingPlacement } = require('./data-fetch-migrator.cjs');
const { generatePerformanceReport, createPreStep7Snapshot } = require('./performance-report.cjs');
const { runValidation } = require('../validation/index.cjs');
const { stripImportExtensions } = require('../utils/strip-import-extensions.cjs');
const { stripRouterLeakInProviders } = require('../utils/strip-react-router-leak.cjs');
const { pruneUnusedAssetConsts } = require('../utils/prune-unused-asset-consts.cjs');
const { polyfillUseLocation } = require('../utils/polyfill-uselocation.cjs');
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

    // src/app/providers.tsx 에 흘러든 react-router-dom 코드 제거
    // (createBrowserRouter / RouterProvider / <BrowserRouter> 등)
    try {
      const leakResults = await stripRouterLeakInProviders(projectRoot);
      if (leakResults.length > 0) {
        const total = leakResults.reduce((acc, r) => acc + r.removals.length, 0);
        console.log(
          chalk.gray(
            `   🛠  providers.tsx 에서 react-router 누수 ${total}건 정리`,
          ),
        );
      }
    } catch (leakErr) {
      console.log(
        chalk.gray(`   ⚠️  router 누수 정리(무시): ${leakErr?.message || leakErr}`),
      );
    }

    // 미해결 useLocation() 호출 결정론적 폴백
    // - step3/link-migrator 가 useNavigate→useRouter 는 처리하지만,
    //   useLocation() 은 next/navigation 직접 대응이 없어 호출이 본문에 그대로
    //   남아 빌드/런타임을 깨뜨린다. import 가 없는데 호출만 남은 케이스를
    //   `{ pathname: '', state: {} as any, ... } as any` 로 치환해 빌드를 통과시킨다.
    //   (full-lossy: state 데이터 의미는 손실되지만 빌드는 안전.)
    try {
      const polyResult = await polyfillUseLocation(projectRoot);
      if (polyResult.totalReplaced > 0) {
        console.log(
          chalk.gray(
            `   🛡️  useLocation() 폴백 ${polyResult.totalReplaced}건 (${polyResult.changedFiles.length}개 파일)`,
          ),
        );
      }
    } catch (polyErr) {
      console.log(
        chalk.gray(`   ⚠️  useLocation 폴백(무시): ${polyErr?.message || polyErr}`),
      );
    }

    // 사용처 0 인 asset const 결정론적 제거
    // - step4 가 `import X from '...svg'` → `const X = '/assets/...svg';` 로 바꾼 뒤
    //   step7/next-image-migrator 가 `<img src={X}>` 를 리터럴로 인라이닝하면
    //   X 가 죽은 변수로 남아 `next build` 의 type-check 가 TS6133 으로 실패한다.
    //   이 sweep 이 그 미사용 const 를 자동 제거한다.
    try {
      const pruneResult = await pruneUnusedAssetConsts(projectRoot);
      if (pruneResult.totalRemoved > 0) {
        console.log(
          chalk.gray(
            `   🧹 미사용 asset const ${pruneResult.totalRemoved}개 제거 (${pruneResult.changedFiles.length}개 파일)`,
          ),
        );
      }
    } catch (pruneErr) {
      console.log(
        chalk.gray(`   ⚠️  미사용 asset const 정리(무시): ${pruneErr?.message || pruneErr}`),
      );
    }

    // import 경로 확장자(.ts/.tsx 등) 결정론적 제거
    // - Vite 코드가 './X.tsx' 같은 import 를 가졌을 때 Next.js 의 tsc 가
    //   TS5097/TS2867 로 빌드를 거부하는 문제를 사전 차단한다.
    try {
      console.log('import 경로 확장자 정리 시작');
      const stripResult = await stripImportExtensions(projectRoot);
      if (stripResult.totalReplacements > 0) {
        console.log(
          chalk.gray(
            `   🛠  import 경로 확장자 ${stripResult.totalReplacements}건 정리 (${stripResult.changedFiles.length}개 파일)`,
          ),
        );
      } else {
        console.log(chalk.gray('   ℹ️  import 경로 확장자 정리: 대상 없음'));
      }
      console.log('import 경로 확장자 정리 완료');
    } catch (stripErr) {
      console.log(chalk.gray(`   ⚠️  import 경로 정리(무시): ${stripErr?.message || stripErr}`));
    }

    // 타입 검사·자동 수정 구현체는 app/src/validation (여기서는 진입점만 호출)
    if (options.skipValidation !== true) {
      try {
        console.log('TypeScript 검증 시작 (validation — tsc --noEmit)');
        await runValidation(projectRoot, {
          autofix: options.typecheckAutofix !== false,
          aiFix: options.typecheckAiFix !== false,
          aiFixBudget: options.typecheckAiFixBudget,
        });
        console.log('TypeScript 검증 완료');
      } catch (typecheckErr) {
        console.log(chalk.gray(`   ⚠️  타입 검증 단계 무시: ${typecheckErr?.message || typecheckErr}`));
      }
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
