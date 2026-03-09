// src/step7/index.cjs
// Step 7: next/image 적용, next/font 적용, Dynamic Import 적용 및 남겨둔 React 흔적 정리

const { applyNextImage } = require('./next-image-migrator.cjs');
const { applyNextFont } = require('./next-font-migrator.cjs');
const { optimizeDynamicImport } = require('./dynamic-import-migrator.cjs');
const { cleanReactTrace } = require('./react-trace-cleaner.cjs');
const chalk = require('chalk');

/**
 * Step 7 메인 실행 함수
 */
async function runStep7(projectRoot) {
  console.log(chalk.blue.bold('파트 7 시작'));

  try {
    // next/image 적용 실행
    console.log('next/image 적용 시작');
    await applyNextImage(projectRoot);
    console.log('next/image 적용 완료');

    // next/font 적용 실행
    console.log('next/font 적용 시작');
    await applyNextFont(projectRoot);
    console.log('next/font 적용 완료');

    // Dynamic Import 적용 실행
    console.log('Dynamic Import 적용 시작');
    await optimizeDynamicImport(projectRoot);
    console.log('Dynamic Import 적용 완료');

    // React 흔적 정리 실행 (맨 마지막)
    console.log('React 흔적 정리 시작');
    await cleanReactTrace(projectRoot);
    console.log('React 흔적 정리 완료');

    console.log(chalk.green.bold('파트 7 완료'));
  } catch (error) {
    console.error(chalk.red.bold('파트 7 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep7 };

