#!/usr/bin/env node
const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');

// 모듈 경로 변경 (step 폴더의 index.cjs )
const { runStep1 } = require('./src/step1/index.cjs');
const { runStep2 } = require('./src/step2/index.cjs');

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
  .action(async () => {
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
      const { mode } = await inquirer.prompt([
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

      let targetPath = cwd;

      if (mode === 'copy') {
        const parentDir = path.dirname(cwd);
        const currentDirName = path.basename(cwd);
        const defaultNewName = `${currentDirName}-nextified`;

        const { newFolderName } = await inquirer.prompt([
          {
            type: 'input',
            name: 'newFolderName',
            message: '생성할 새 프로젝트 폴더 이름:',
            default: defaultNewName,
          },
        ]);

        targetPath = path.join(parentDir, newFolderName);
        await cloneProject(cwd, targetPath);
        console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
      }

      //  Step 1 실행
      await runStep1(targetPath);

      // 완료 안내
      const installCmd = getInstallCommand(pm);
      console.log(chalk.green.bold('\n✅ Step 1 완료!'));

      if (mode === 'copy') {
        console.log(chalk.yellow(`\n👉 다음 단계:`));
        console.log(chalk.white(`   1. cd ${path.basename(targetPath)}`));
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

program.parse(process.argv);
