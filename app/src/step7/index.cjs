// src/step7/index.cjs
// Step 7: next/image 적용, next/font 적용, Dynamic Import 적용 및 남겨둔 React 흔적 정리

const { applyNextImage } = require('./next-image-migrator.cjs');
const { applyNextFont } = require('./next-font-migrator.cjs');
const { optimizeDynamicImport } = require('./dynamic-import-migrator.cjs');
const { cleanReactTrace } = require('./react-trace-cleaner.cjs');
const { minimizeUseClientForBundle } = require('./useclient-minimizer.cjs');
const { optimizeDataFetchingPlacement } = require('./data-fetch-migrator.cjs');
const chalk = require('chalk');
const {
  isMechanicalMigrationRerun,
} = require('../utils/manual-flow.cjs');

/**
 * Step 7 메인 실행 함수
 */
async function runStep7(projectRoot) {
  console.log(chalk.blue.bold('파트 7 시작'));

  // next/image 적용 실행
  console.log('next/image 적용 시작');
  await applyNextImage(projectRoot);
  console.log('next/image 적용 완료');

  // next/font 적용 실행 (사용자 직접반영 시 해당 작업만 재실행)
  let nextFontReruns = 0;
  while (true) {
    try {
      console.log('next/font 적용 시작');
      await applyNextFont(projectRoot);
      console.log('next/font 적용 완료');
      break;
    } catch (error) {
      if (!isMechanicalMigrationRerun(error)) {
        console.error(chalk.red.bold('파트 7 오류 발생:'), error);
        throw error;
      }
      nextFontReruns += 1;
      console.log(
        chalk.cyan(
          `\n(next/font 적용 재실행 ${nextFontReruns})\n`
        )
      );
    }
  }

  // 클라이언트 데이터 패칭 위치 최적화 실행 (사용자 직접반영 시 해당 작업만 재실행)
  let dataFetchReruns = 0;
  while (true) {
    try {
      console.log('데이터 패칭 위치 최적화 시작');
      await optimizeDataFetchingPlacement(projectRoot);
      console.log('데이터 패칭 위치 최적화 완료');
      break;
    } catch (error) {
      if (!isMechanicalMigrationRerun(error)) {
        console.error(chalk.red.bold('파트 7 오류 발생:'), error);
        throw error;
      }
      dataFetchReruns += 1;
      console.log(
        chalk.cyan(
          `\n(데이터 패칭 위치 최적화 재실행 ${dataFetchReruns})\n`
        )
      );
    }
  }

  // "use client" 최소화 실행 (사용자 직접반영 시 해당 작업만 재실행)
  let useClientMinReruns = 0;
  while (true) {
    try {
      console.log('"use client" 최소화 시작');
      await minimizeUseClientForBundle(projectRoot);
      console.log('"use client" 최소화 완료');
      break;
    } catch (error) {
      if (!isMechanicalMigrationRerun(error)) {
        console.error(chalk.red.bold('파트 7 오류 발생:'), error);
        throw error;
      }
      useClientMinReruns += 1;
      console.log(
        chalk.cyan(
          `\n("use client" 최소화 재실행 ${useClientMinReruns})\n`
        )
      );
    }
  }

  // Dynamic Import 적용 실행
  console.log('Dynamic Import 적용 시작');
  await optimizeDynamicImport(projectRoot);
  console.log('Dynamic Import 적용 완료');

  // React 흔적 정리 실행 (맨 마지막)
  console.log('React 흔적 정리 시작');
  await cleanReactTrace(projectRoot);
  console.log('React 흔적 정리 완료');

  console.log(chalk.green.bold('파트 7 완료'));
}

module.exports = { runStep7 };

