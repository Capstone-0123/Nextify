#!/usr/bin/env node
// .env.local 파일 로드 (가장 먼저 실행)
require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });

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
const { runStep7 } = require('./src/step7/index.cjs');

const {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
} = require('./src/utils/project-info.cjs');
const { cloneProject } = require('./src/utils/copy.cjs');
const { generateText, createMigrationPrompt, generateTextStream } = require('./src/utils/gemini-client.cjs');
const { runAskApply } = require('./src/utils/ai-file-apply.cjs');

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
  .description('5단계: Zustand 상태 관리 마이그레이션')
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

// =========================================================
// Command: Step 7
// =========================================================
program
  .command('step7')
  .description('7단계: next/image, next/font, Dynamic Import 적용 및 React 흔적 정리')
  .action(async () => {
    try {
      // Step 7 실행
      await runStep7(process.cwd());
    } catch (error) {
      console.error(chalk.red('\n❌ Step 7 오류 발생:'), error);
      process.exit(1);
    }
  });

// =========================================================
// Command: Ask (Gemini AI)
// =========================================================
program
  .command('ask')
  .description('Gemini AI에게 React → Next.js 마이그레이션 관련 질문하기')
  .option('-q, --question <text>', '질문 내용 (옵션 없으면 대화형 입력)')
  .option('-s, --stream', '스트리밍 모드로 응답 받기 (실시간 출력)')
  .option('--apply', 'AI가 반환한 JSON 패치로 지정 파일만 디스크에 직접 적용 (검증용, 수정안 본문은 출력하지 않음)')
  .option('-f, --files <list>', '쉼표로 구분한 프로젝트 루트 기준 상대 경로 (--apply 시 필수)')
  .action(async (options) => {
    try {
      // API 키 확인
      if (!process.env.GEMINI_API_KEY) {
        console.error(chalk.red('\n❌ GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.'));
        console.log(chalk.yellow('\n설정 방법:'));
        console.log(chalk.white('  1. Google AI Studio에서 API 키 발급: https://makersuite.google.com/app/apikey'));
        console.log(chalk.white('  2. 환경 변수 설정:'));
        console.log(chalk.cyan('     Windows: set GEMINI_API_KEY=your_api_key'));
        console.log(chalk.cyan('     Mac/Linux: export GEMINI_API_KEY=your_api_key'));
        process.exit(1);
      }

      if (options.apply && options.stream) {
        console.error(chalk.red('\n❌ --apply 와 --stream 은 함께 쓸 수 없습니다.\n'));
        process.exit(1);
      }

      if (options.apply && !options.files) {
        console.error(chalk.red('\n❌ --apply 사용 시 -f/--files 로 수정 대상 파일을 지정해야 합니다.\n'));
        console.log(chalk.gray('예: migrate-next ask --apply -f src/App.tsx -q "..."\n'));
        process.exit(1);
      }

      // 질문 입력
      let question = options.question;
      if (!question) {
        const answer = await inquirer.prompt([
          {
            type: 'input',
            name: 'question',
            message: options.apply
              ? '파일에 반영할 지시를 입력하세요:'
              : '마이그레이션 관련 질문을 입력하세요:',
            validate: (input) => input.trim().length > 0 || '내용을 입력해주세요.',
          },
        ]);
        question = answer.question;
      }

      // 프로젝트 컨텍스트 수집
      const cwd = process.cwd();
      const context = {
        buildTool: detectBuildTool(cwd),
        language: detectLanguage(cwd),
        packageManager: detectPackageManager(cwd),
      };

      if (options.apply) {
        const spinner = require('ora')('AI가 코드를 적용하는 중...').start();
        const written = await runAskApply({
          projectRoot: cwd,
          question,
          filesCsv: options.files,
          context,
        });
        spinner.stop();
        console.log(chalk.green(`\n✅ 적용 완료 (${written.length}개): ${written.join(', ')}\n`));
        return;
      }

      // 프롬프트 생성
      const prompt = createMigrationPrompt(question, context);

      console.log(chalk.blue.bold('\n🤖 Gemini AI가 답변을 생성하고 있습니다...\n'));

      if (options.stream) {
        // 스트리밍 모드
        await generateTextStream(
          prompt,
          (chunk) => {
            process.stdout.write(chalk.white(chunk));
          }
        );
        console.log('\n');
      } else {
        // 일반 모드
        const spinner = require('ora')('답변 생성 중...').start();
        const response = await generateText(prompt);
        spinner.stop();
        console.log(chalk.green('\n📝 답변:\n'));
        console.log(chalk.white(response));
        console.log('\n');
      }
    } catch (error) {
      console.error(chalk.red('\n❌ 오류 발생:'), error.message);
      process.exit(1);
    }
  });

// =========================================================
// Command: Test Gemini Connection
// =========================================================
program
  .command('test-gemini')
  .description('Gemini API 연결 테스트')
  .action(async () => {
    try {
      const { generateText } = require('./src/utils/gemini-client.cjs');
      
      // API 키 확인
      if (!process.env.GEMINI_API_KEY) {
        console.error(chalk.red('\n❌ GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.'));
        console.log(chalk.yellow('\n설정 방법:'));
        console.log(chalk.white('  1. Google AI Studio에서 API 키 발급: https://makersuite.google.com/app/apikey'));
        console.log(chalk.white('  2. 환경 변수 설정:'));
        console.log(chalk.cyan('     Windows: set GEMINI_API_KEY=your_api_key'));
        console.log(chalk.cyan('     Mac/Linux: export GEMINI_API_KEY=your_api_key'));
        process.exit(1);
      }

      // 질문 입력
      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'question',
          message: '마이그레이션 관련 질문을 입력하세요:',
          validate: (input) => input.trim().length > 0 || '질문을 입력해주세요.',
        },
      ]);

      // 프로젝트 컨텍스트 수집
      const cwd = process.cwd();
      const context = {
        buildTool: detectBuildTool(cwd),
        language: detectLanguage(cwd),
        packageManager: detectPackageManager(cwd),
      };

      // 프롬프트 생성
      const prompt = createMigrationPrompt(answer.question, context);

      console.log(chalk.blue.bold('\n🤖 Gemini AI가 답변을 생성하고 있습니다...\n'));

      const spinner = require('ora')('답변 생성 중...').start();
      const response = await generateText(prompt);
      spinner.stop();
      
      console.log(chalk.green('\n📝 답변:\n'));
      console.log(chalk.white(response));
      console.log('\n');
    } catch (error) {
      console.error(chalk.red('\n❌ Gemini API 연결 실패:'), error.message);
      console.log(chalk.yellow('\n확인 사항:'));
      console.log(chalk.white('  1. GEMINI_API_KEY 환경 변수가 올바르게 설정되었는지 확인'));
      console.log(chalk.white('  2. 인터넷 연결 확인'));
      console.log(chalk.white('  3. API 키가 유효한지 확인 (Google AI Studio에서 확인)'));
      process.exit(1);
    }
  });

program.parse(process.argv);
