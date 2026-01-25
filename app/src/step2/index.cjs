// src/step2/index.cjs
// const { convertRoutes } = require('./route-converter.cjs');
const { generateLayout } = require('./layout-generator.cjs');
const chalk = require('chalk');

async function runStep2(projectRoot) {
  console.log(chalk.blue.bold('🚀 Step 2: 구조 변환 시작...'));

  // 1. 라우팅 변환 (App.tsx -> app/**/page.tsx)
  //   await convertRoutes(projectRoot);

  // 2. 레이아웃 생성 (index.html -> app/layout.tsx)
  console.log(chalk.blue.bold('--레이아웃 생성 시작'));
  await generateLayout(projectRoot);
  console.log(chalk.blue.bold('--레이아웃 생성 완료'));
  console.log(chalk.green.bold('✅ Step 2 모든 작업 완료!'));
}

module.exports = { runStep2 };
