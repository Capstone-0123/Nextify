// src/step7/index.cjs
// Next.js 심화 변환: next/image, next/font, Dynamic Import 적용 및 남겨둔 React 흔적 정리

const { applyNextImage } = require('./next-image-migrator.cjs');
const { applyNextFont } = require('./next-font-migrator.cjs');
const { optimizeDynamicImport } = require('./dynamic-import-migrator.cjs');
const { cleanReactTrace } = require('./react-trace-cleaner.cjs');
const { minimizeUseClientForBundle } = require('./useclient-minimizer.cjs');
const { optimizeDataFetchingPlacement } = require('./data-fetch-migrator.cjs');
const { stripRouterLeakInProviders } = require('../utils/strip-react-router-leak.cjs');
const { pruneUnusedAssetConsts } = require('../utils/prune-unused-asset-consts.cjs');
const { polyfillUseLocation } = require('../utils/polyfill-uselocation.cjs');
const chalk = require('chalk');

/**
 * Next.js 심화 변환 실행 함수
 */
async function runAdvancedMigration(projectRoot, options = {}) {
  try {
    console.log(chalk.gray('──────────────────────────────────────────────────────────────────────────────────────────────────────'));
    console.log(chalk.blue.bold('[6단계] Next.js 심화 변환을 시작합니다.'));

    console.log('  → 이미지를 next/image로 교체해 로딩 성능을 개선하는 중.');
    await applyNextImage(projectRoot);
    console.log('  ✔ next/image 적용 완료\n');

    console.log('  → Google Fonts·로컬 폰트를 next/font로 전환하는 중.');
    await applyNextFont(projectRoot);
    console.log('  ✔ next/font 전환 완료\n');

    console.log('  → 클라이언트 데이터 패칭 코드를 탐색하는 중.');
    await optimizeDataFetchingPlacement(projectRoot);
    console.log('  ✔ 데이터 패칭 위치 최적화 완료\n');

    console.log('  → "use client" 범위를 분석해 불필요한 지시문을 제거하는 중.');
    await minimizeUseClientForBundle(projectRoot);
    console.log('  ✔ "use client" 최소화 완료\n');

    console.log('  → 무거운 컴포넌트를 Dynamic Import로 분리해 초기 번들을 줄이는 중.');
    await optimizeDynamicImport(projectRoot);
    console.log('  ✔ Dynamic Import 적용 완료\n');

    console.log('  → 마이그레이션 과정에서 남은 React·Vite 파일과 패키지를 정리하는 중.');
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
      await polyfillUseLocation(projectRoot);
    } catch (polyErr) {
      console.log(
        chalk.gray(`   ⚠️  useLocation 폴백(무시): ${polyErr?.message || polyErr}`),
      );
    }

    // 사용처 0 인 asset const 결정론적 제거
    // - step4 가 `import X from '...svg'` → `const X = '/assets/...svg';` 로 바꾼 뒤
    //   next-image-migrator 가 `<img src={X}>` 를 리터럴로 인라이닝하면
    //   X 가 죽은 변수로 남아 `next build` 의 type-check 가 TS6133 으로 실패한다.
    //   이 sweep 이 그 미사용 const 를 자동 제거한다.
    try {
      await pruneUnusedAssetConsts(projectRoot);
    } catch (pruneErr) {
      console.log(
        chalk.gray(`   ⚠️  미사용 asset const 정리(무시): ${pruneErr?.message || pruneErr}`),
      );
    }

    console.log(chalk.green.bold('[6단계] 완료 — Next.js 심화 변환이 끝났습니다.'));
  } catch (error) {
    console.error(chalk.red.bold('Next.js 심화 변환 오류 발생:'), error);
    throw error;
  }
}

module.exports = {
  runAdvancedMigration,
  runStep7: runAdvancedMigration,
};
