// Step 1: 환경 설정 - 패키지, 설정파일

const {
  updatePackageJson,
  setupConfigFiles,
  migrateViteConfig,
  migrateViteDefine,
  updateTsConfig,
} = require('./step1-env.cjs');
const chalk = require('chalk');

/**
 * Step 1 메인 실행 함수
 */
async function runStep1(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 1: 환경 설정 시작...'));

  // 1. package.json 수정
  console.log(chalk.blue.bold('--package.json 의존성 및 스크립트 수정 시작'));
  await updatePackageJson(projectRoot);
  console.log(chalk.blue.bold('--package.json 의존성 및 스크립트 수정 완료'));

  // 2. 설정 파일 업데이트 및 정리
  console.log(chalk.blue.bold('--설정 파일 업데이트 시작'));
  await setupConfigFiles(projectRoot);
  console.log(chalk.blue.bold('--설정 파일 업데이트 완료'));

  // 3. vite.config.ts 설정 마이그레이션
  console.log(chalk.blue.bold('--vite.config.ts 설정 마이그레이션 시작'));
  await migrateViteConfig(projectRoot);
  console.log(chalk.blue.bold('--vite.config.ts 설정 마이그레이션 완료'));

  // 4. Vite define 처리
  console.log(chalk.blue.bold('--Vite define 처리 시작'));
  await migrateViteDefine(projectRoot);
  console.log(chalk.blue.bold('--Vite define 처리 완료'));

  // 5. TypeScript 설정 정리
  console.log(chalk.blue.bold('--TypeScript 컴파일러 설정 정리 시작'));
  await updateTsConfig(projectRoot);
  console.log(chalk.blue.bold('--TypeScript 컴파일러 설정 정리 완료'));

  console.log(chalk.green.bold('✅ Step 1 모든 작업 완료!'));
}

module.exports = { runStep1 };
