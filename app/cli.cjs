#!/usr/bin/env node
const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');

// 모듈 경로 변경 (step 폴더의 index.cjs )
const { runStep1 } = require('./src/step1/index.cjs');
const { runStep2 } = require('./src/step2/index.cjs');
const { runStep3 } = require('./src/step3/index.cjs');
const { runStep4 } = require('./src/step4/index.cjs');
const { runStep5 } = require('./src/step5/index.cjs');
const { runStep6 } = require('./src/step6/index.cjs');
const {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
} = require('./src/utils/project-info.cjs');
const { cloneProject } = require('./src/utils/copy.cjs');

const program = new Command();

program.name('migrate-next').description('React(Vite) 프로젝트를 Next.js로 마이그레이션하는 CLI').version('0.1.0');

// =========================================================
// Command: Step 1
// =========================================================
program
  .command('step1')
  .description('1단계: 초기 환경 설정 (패키지, 설정파일)')
  .option('-o, --output <path>', '복사본을 생성할 경로 (지정 시 복사 모드로 자동 실행)')
  .option('--inplace', '원본 폴더에서 직접 마이그레이션 (복사 안 함)')
  .action(async (options) => {
    console.log(chalk.blue.bold('🚀 Next.js 마이그레이션 Step 1을 시작합니다...'));

    const cwd = process.cwd();

    // 1. 프로젝트 상태 감지
    const pm = detectPackageManager(cwd);
    const lang = detectLanguage(cwd);
    const buildTool = detectBuildTool(cwd);
    const monorepo = detectMonorepo(cwd);
    const appType = detectAppType(cwd);

    // 정보 출력
    console.log(chalk.gray(`📦 패키지 매니저: ${chalk.cyan(pm)}`));
    console.log(chalk.gray(`📘 프로젝트 언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`));
    console.log(chalk.gray(`🛠️  빌드 도구:     ${chalk.cyan(buildTool.toUpperCase())}`));

    if (monorepo) console.log(chalk.magenta(`🏢 모노레포 감지: ${chalk.bold(monorepo)}`));
    console.log(chalk.gray('--------------------------------------------------'));

    // 2. 가드
    if (buildTool !== 'vite') {
      console.error(chalk.red.bold('\n⛔️ 지원하지 않는 프로젝트 형식입니다. (Vite 필수)'));
      process.exit(1);
    }
    if (appType !== 'spa') {
      console.error(chalk.red.bold('\n⛔️ SPA(index.html 보유) 프로젝트만 지원합니다.'));
      process.exit(1);
    }

    // 3. 실행
    try {
      let mode;
      let targetPath = cwd;

      // CLI 옵션으로 모드 결정
      if (options.output) {
        mode = 'copy';
        // 입력값 정리 (공백 제거)
        const cleanedPath = options.output.trim();

        // Windows 절대 경로 판단 (C:\, D:\ 등) 또는 Unix 절대 경로 (/)
        const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

        if (isAbsolutePath) {
          // 절대 경로면 그대로 사용
          targetPath = path.resolve(cleanedPath);
        } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
          // 상대 경로 (./foo, ../bar 등)면 현재 디렉토리 기준
          targetPath = path.resolve(cwd, cleanedPath);
        } else {
          // 폴더명만 입력한 경우 부모 디렉토리에 생성
          const parentDir = path.dirname(cwd);
          targetPath = path.join(parentDir, cleanedPath);
        }
      } else if (options.inplace) {
        mode = 'inplace';
      } else {
        // 옵션 없으면 대화형으로 선택
        const answer = await inquirer.prompt([
          {
            type: 'list',
            name: 'mode',
            message: '마이그레이션을 어떻게 진행하시겠습니까?',
            choices: [
              { name: '새 폴더에 복사본을 만들어서 진행 (추천)', value: 'copy' },
              { name: '현재 폴더에 바로 적용 (주의: 원본 변경)', value: 'inplace' },
            ],
          },
        ]);
        mode = answer.mode;
      }

      if (mode === 'copy' && !options.output) {
        const parentDir = path.dirname(cwd);
        const currentDirName = path.basename(cwd);
        const defaultNewPath = path.join(parentDir, `${currentDirName}-nextified`);

        const { outputPath } = await inquirer.prompt([
          {
            type: 'input',
            name: 'outputPath',
            message: '복사본을 생성할 경로 (폴더명 또는 전체 경로):',
            default: defaultNewPath,
          },
        ]);

        // 입력값 정리 (공백 제거)
        const cleanedPath = outputPath.trim();

        // Windows 절대 경로 판단 (C:\, D:\ 등) 또는 Unix 절대 경로 (/)
        const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

        if (isAbsolutePath) {
          // 절대 경로면 그대로 사용
          targetPath = path.resolve(cleanedPath);
        } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
          // 상대 경로 (./foo, ../bar 등)면 현재 디렉토리 기준
          targetPath = path.resolve(cwd, cleanedPath);
        } else {
          // 폴더명만 입력한 경우 부모 디렉토리에 생성
          targetPath = path.join(parentDir, cleanedPath);
        }
      }

      if (mode === 'copy') {
        await cloneProject(cwd, targetPath);
        console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
      }

      //  Step 1 실행
      await runStep1(targetPath);

      // 완료 안내
      const installCmd = getInstallCommand(pm);

      if (mode === 'copy') {
        // 현재 경로에서 target 경로로 가는 상대 경로 계산
        const relativePath = path.relative(cwd, targetPath);
        console.log(chalk.yellow(`\n👉 다음 단계:`));
        console.log(chalk.white(`   1. cd ${relativePath}`));
        console.log(chalk.white(`   2. ${installCmd} (의존성 설치)`));
        console.log(chalk.white(`   3. migrate-next step2`));
      } else {
        console.log(chalk.yellow(`👉 ${installCmd} 로 의존성을 설치한 후, 'migrate-next step2'를 실행하세요.`));
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Step 1 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 2
// =========================================================
program
  .command('step2')
  .description('2단계: 라우팅 구조 변환 (React Router -> App Router)')
  .action(async () => {
    try {
      // Step 2 실행
      await runStep2(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 2 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 3
// =========================================================
program
  .command('step3')
  .description('3단계: 라우팅 페이지 변환 )')
  .action(async () => {
    try {
      // Step 3 실행
      await runStep3(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 3 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 4
// =========================================================
program
  .command('step4')
  .description('4단계: 스타일/리소스 마이그레이션')
  .action(async () => {
    try {
      // Step 4 실행
      await runStep4(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 4 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 5
// =========================================================
program
  .command('step5')
  .description('5단계: use client" 처리 및 Zustand 상태 관리 마이그레이션')
  .action(async () => {
    try {
      // Step 5 실행
      await runStep5(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 5 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Step 6
// =========================================================
program
  .command('step6')
  .description('6단계: 환경 변수 설정 & 의존성 갱신 가이드')
  .action(async () => {
    try {
      // Step 6 실행
      await runStep6(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 6 오류 발생:'), error);
      process.exit(1);
    }
  });

program.parse(process.argv);
