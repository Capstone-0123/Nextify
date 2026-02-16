// Step 5: "use client" 처리 및 Zustand 상태 관리 마이그레이션

const { migrateZustandStores } = require('./zustand-migrator.cjs');
const { migrateUseClient } = require('./useclient-migrator.cjs');
const chalk = require('chalk');

/**
 * Step 5 메인 실행 함수
 */
async function runStep5(projectRoot) {
  console.log(chalk.blue.bold('\n🚀 Step 5: "use client" 처리 및 Zustand 상태 관리 마이그레이션 시작...'));
  console.log(chalk.blue('--------------------------------------------------'));

  try {
    // "use client" 마이그레이션 실행
    console.log(chalk.blue.bold('--"use client" 처리 시작'));
    await migrateUseClient(projectRoot);
    console.log(chalk.blue.bold('--"use client" 처리 완료'));

    // Zustand 스토어 마이그레이션 실행
    console.log(chalk.blue.bold('--Zustand 상태 관리 마이그레이션 시작'));
    const result = await migrateZustandStores(projectRoot);
    console.log(chalk.blue.bold('--Zustand 상태 관리 마이그레이션 완료'));

    console.log(chalk.blue('--------------------------------------------------'));
    console.log(chalk.green.bold('✅ Step 5 모든 작업 완료!'));

    // 결과 요약 출력
    if (result) {
      console.log(chalk.yellow('\n📋 마이그레이션 결과 요약:'));
      console.log(chalk.cyan(`\n  ✅ Zustand 스토어 마이그레이션 완료:`));
      console.log(chalk.cyan(`     - 변환된 스토어: ${result.transformed.length}개`));
      console.log(chalk.cyan(`     - 유지된 스토어: ${result.volatile.length}개`));
      
      if (result.transformed.length > 0) {
        console.log(chalk.cyan('\n  변환된 스토어:'));
        for (const store of result.transformed) {
          const typeLabel = store.type === 'persistence' 
            ? '(localStorage 직접 사용)' 
            : '(Persist 미들웨어)';
          console.log(chalk.cyan(`    - ${store.storeName} ${typeLabel}`));
        }
      }

      if (result.volatile.length > 0) {
        console.log(chalk.gray('\n  유지된 휘발성 스토어:'));
        for (const filePath of result.volatile) {
          console.log(chalk.gray(`    - ${filePath}`));
        }
      }

      // 주의사항 출력
      console.log(chalk.yellow('\n⚠️ 주의사항:'));
      console.log(chalk.white('  1. 변환된 스토어의 hydrate 함수가 Provider에서 호출되는지 확인하세요.'));
      console.log(chalk.white('  2. 휘발성 스토어는 반드시 "use client" 컴포넌트에서만 사용하세요.'));
      console.log(chalk.white('  3. Persist 미들웨어 사용 시 skipHydration: true 설정을 확인하세요.'));
    }

  } catch (error) {
    console.error(chalk.red.bold('❌ Step 5 오류 발생:'), error);
    throw error;
  }
}

module.exports = { runStep5 };
