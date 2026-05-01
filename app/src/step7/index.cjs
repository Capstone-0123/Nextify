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
  console.log(chalk.blue.bold('파트 7 시작'));

  try {
    // report-only 모드: 마이그레이션을 다시 돌리지 않고 레포트만 생성
    if (options.reportOnly) {
      console.log('성능 레포트 생성 시작 (report-only)');
      const outputPath = options.outputPath || path.join(projectRoot, 'nextify-performance-report.md');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot: options.baselineViteRoot,
        preStep7Root: options.preStep7Root,
        outputMarkdownPath: outputPath,
        lighthouseRuns: options.lighthouseRuns,
        warmupRuns: options.warmupRuns,
      });
      console.log(chalk.green.bold('파트 7 완료 (report-only)'));
      return;
    }

    // Step7 적용 전 스냅샷 (step1~6 결과물 보존)
    if (options.report) {
      console.log('Step7 적용 전 스냅샷 생성 시작');
      await createPreStep7Snapshot(projectRoot);
      console.log('Step7 적용 전 스냅샷 생성 완료');
    }

    // next/image 적용 실행
    console.log('next/image 적용 시작');
    await applyNextImage(projectRoot);
    console.log('next/image 적용 완료');

    // next/font 적용 실행
    console.log('next/font 적용 시작');
    await applyNextFont(projectRoot);
    console.log('next/font 적용 완료');

    // 클라이언트 데이터 패칭 위치 최적화 실행
    console.log('데이터 패칭 위치 최적화 시작');
    await optimizeDataFetchingPlacement(projectRoot);
    console.log('데이터 패칭 위치 최적화 완료');

    // "use client" 최소화 실행
    console.log('"use client" 최소화 시작');
    await minimizeUseClientForBundle(projectRoot);
    console.log('"use client" 최소화 완료');

    // Dynamic Import 적용 실행
    console.log('Dynamic Import 적용 시작');
    await optimizeDynamicImport(projectRoot);
    console.log('Dynamic Import 적용 완료');

    // React 흔적 정리 실행 (맨 마지막)
    console.log('React 흔적 정리 시작');
    await cleanReactTrace(projectRoot);
    console.log('React 흔적 정리 완료');

    // 최종 타입 검사 (자동 수정 없이 잠재적 빌드 에러만 경고로 출력)
    // - LLM 호출 없음, 토큰 0
    // - 실패해도 마이그레이션 흐름을 막지 않음
    try {
      console.log('TypeScript 타입 검사 시작 (tsc --noEmit, 경고 출력)');
      await runFinalTypecheckReport(projectRoot);
      console.log('TypeScript 타입 검사 완료');
    } catch (typecheckErr) {
      console.log(chalk.gray(`   ⚠️  타입 검사 단계 무시: ${typecheckErr?.message || typecheckErr}`));
    }

    // 성능 레포트 생성
    if (options.report) {
      console.log('성능 레포트 생성 시작 (Lighthouse + 번들 용량 비교)');
      const outputPath = options.outputPath || path.join(projectRoot, 'nextify-performance-report.md');
      await generatePerformanceReport({
        projectRoot,
        baselineViteRoot: options.baselineViteRoot,
        preStep7Root: options.preStep7Root,
        outputMarkdownPath: outputPath,
        lighthouseRuns: options.lighthouseRuns,
        warmupRuns: options.warmupRuns,
      });
      console.log('성능 레포트 생성 완료');
    }

    console.log(chalk.green.bold('파트 7 완료'));
  } catch (error) {
    console.error(chalk.red.bold('파트 7 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep7 };

