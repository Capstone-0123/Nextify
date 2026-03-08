// src/step4/index.cjs
// Step 4: 스타일/리소스 마이그레이션

const { migrateTailwindAndStyled } = require('./tailwind-styled-migrator.cjs');
const { migrateGlobalCss } = require('./globalcss-migrator.cjs');
const { migrateStaticResources } = require('./asset-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 4 메인 실행 함수
 */
async function runStep4(projectRoot) {
  console.log(chalk.blue.bold('파트 4 시작'));

  // Global CSS 마이그레이션
  console.log('Global CSS 마이그레이션 시작');
  await migrateGlobalCss(projectRoot);
  console.log('Global CSS 마이그레이션 완료');

  // 정적 리소스 마이그레이션
  console.log('정적 리소스 마이그레이션 시작');
  await migrateStaticResources(projectRoot);
  console.log('정적 리소스 마이그레이션 완료');

  // Tailwind CSS 및 Styled Components 마이그레이션
  console.log('Tailwind CSS 및 Styled Components 마이그레이션 시작');
  await migrateTailwindAndStyled(projectRoot);
  console.log('Tailwind CSS 및 Styled Components 마이그레이션 완료');

  console.log(chalk.green.bold('파트 4 완료'));
}


module.exports = { runStep4 };

