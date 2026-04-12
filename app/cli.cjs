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
const {
  REVIEW_ROOT_DIR,
  createStepReviewSession,
  createSnapshotReviewSession,
  openReviewDiff,
} = require('./src/utils/review-session.cjs');
const { generateText, createMigrationPrompt, generateTextStream } = require('./src/utils/gemini-client.cjs');
const { runAskApply } = require('./src/utils/ai-file-apply.cjs');
const { runAiReviewSessionStream } = require('./src/utils/ai-review-session.cjs');

const fs = require('fs-extra');

const program = new Command();

program.name('migrate-next').description('React(Vite) 프로젝트를 Next.js로 마이그레이션하는 CLI').version('0.1.0');

program.addHelpText(
  'after',
  `\n예시:\n` +
    `  migrate-next\n` +
    `    - step1~step7을 순차 실행한 뒤, 최종 diff + Gemini CLI 대화형 리뷰(수정 불가)를 한 번만 진행합니다.\n` +
    `    - Gemini CLI(\`gemini\`)가 PATH에 설치되어 있어야 하며, Ctrl+C는 현재 AI 리뷰만 중단합니다.\n` +
    `    - Nextify Review 패널에서 Accept/Reject로 최종 세션을 비운 뒤 마이그레이션을 마무리합니다.\n` +
    `\n레거시(기존 step1 preview clone 방식):\n` +
    `  migrate-next step1 --review\n`,
);

// =========================================================
// Command: Step 1
// =========================================================
program
  .command('step1')
  .description('1단계: 초기 환경 설정 (패키지, 설정파일)')
  .option('-o, --output <path>', '복사본을 생성할 경로 (지정 시 복사 모드로 자동 실행)')
  .option('--inplace', '원본 폴더에서 직접 마이그레이션 (복사 안 함)')
  .option('--review', '원본은 유지하고 .ai-migration diff 세션을 생성해 IDE에서 검토')
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
      if (options.review) {
        mode = 'review';
      } else if (options.output) {
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

      if (mode === 'review') {
        console.log(chalk.blue('\n리뷰 세션을 준비하는 중입니다...'));
        const reviewSession = await createStepReviewSession(cwd, 'step1', runStep1);

        if (reviewSession.manifest.changes.length === 0) {
          console.log(chalk.green('\n변경 사항이 없어 리뷰 세션을 만들지 않았습니다.'));
          return;
        }

        console.log(chalk.green(`\n✔ Step 1 preview 생성 완료 (${reviewSession.manifest.changes.length}개 변경)`));
        console.log(chalk.white(`리뷰 대상 변경 파일: ${reviewSession.manifest.changes.length}개`));
        const openResult = openFirstReviewableDiff(reviewSession.manifest);

        if (openResult.opened) {
          console.log(chalk.blue(`첫 번째 diff를 ${openResult.command}에서 열었습니다.`));
        } else {
          console.log(
            chalk.yellow(
              '자동으로 diff를 열지 못했습니다. Nextify Review 패널이나 session.json을 통해 수동으로 열어주세요.',
            ),
          );
        }

        console.log(chalk.yellow('\n⏸ Step 1은 리뷰 대기 상태에서 멈췄습니다.'));
        console.log(chalk.white('   - 왼쪽: 원본 파일'));
        console.log(chalk.white('   - 오른쪽: .ai-migration 안의 migrated 파일'));
        console.log(chalk.white('   - Cursor/VSCode의 Nextify Review 패널에서 Accept / Reject 하세요.'));
        console.log(chalk.white(`   - 세션 파일: ${reviewSession.manifestPath}`));
        return;
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
            message: options.apply ? '파일에 반영할 지시를 입력하세요:' : '마이그레이션 관련 질문을 입력하세요:',
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
        await generateTextStream(prompt, (chunk) => {
          process.stdout.write(chalk.white(chunk));
        });
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

// =========================================================
// Default command: `migrate-next` (no subcommand)
// =========================================================
async function waitForSessionCleared(sessionPath) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (true) {
    if (!sessionPath) return true;
    if (!(await fs.pathExists(sessionPath))) return true;

    try {
      const manifest = await fs.readJson(sessionPath);
      if (!manifest?.changes || manifest.changes.length === 0) return true;
    } catch {
      // session.json write 중일 수 있으므로 재시도
    }

    await sleep(1500);
  }
}

function openFirstReviewableDiff(manifest) {
  const changes = Array.isArray(manifest?.changes) ? manifest.changes : [];
  for (const change of changes) {
    const result = openReviewDiff(change);
    if (result?.opened) {
      return { ...result, change };
    }
  }
  return { opened: false, command: null, change: null };
}

async function cleanupStaleStepArtifacts(projectRoot) {
  const reviewRoot = path.join(projectRoot, REVIEW_ROOT_DIR);
  if (!(await fs.pathExists(reviewRoot))) return;

  const entries = await fs.readdir(reviewRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^step\d+$/i.test(entry.name)) continue;
    await fs.remove(path.join(reviewRoot, entry.name));
  }
}

function summarizeChangeTypes(changes) {
  const summary = { create: 0, modify: 0, delete: 0 };
  for (const change of Array.isArray(changes) ? changes : []) {
    if (summary[change?.type] !== undefined) {
      summary[change.type] += 1;
    }
  }
  return summary;
}

async function runDefaultOrchestrator() {
  const cwd = process.cwd();

  // 1) detect & validate project type
  const pm = detectPackageManager(cwd);
  const lang = detectLanguage(cwd);
  const buildTool = detectBuildTool(cwd);
  const monorepo = detectMonorepo(cwd);
  const appType = detectAppType(cwd);

  console.log(chalk.blue.bold('🚀 Nextify 마이그레이션(기본 오케스트레이터)을 시작합니다...'));
  console.log(chalk.gray(`📦 패키지 매니저: ${chalk.cyan(pm)}`));
  console.log(chalk.gray(`📘 프로젝트 언어: ${chalk.cyan(lang === 'ts' ? 'TypeScript' : 'JavaScript')}`));
  console.log(chalk.gray(`🛠️  빌드 도구:     ${chalk.cyan(buildTool.toUpperCase())}`));
  if (monorepo) console.log(chalk.magenta(`🏢 모노레포 감지: ${chalk.bold(monorepo)}`));
  console.log(chalk.gray('--------------------------------------------------'));

  if (buildTool !== 'vite') {
    console.error(chalk.red.bold('\n⛔️ 지원하지 않는 프로젝트 형식입니다. (Vite 필수)'));
    process.exit(1);
  }
  if (appType !== 'spa') {
    console.error(chalk.red.bold('\n⛔️ SPA(index.html 보유) 프로젝트만 지원합니다.'));
    process.exit(1);
  }

  // 2) mode selection
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

  let mode = answer.mode;
  let targetPath = cwd;

  if (mode === 'copy') {
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

    const cleanedPath = outputPath.trim();
    const isAbsolutePath = path.isAbsolute(cleanedPath) || /^[A-Za-z]:[\\/]/.test(cleanedPath);

    if (isAbsolutePath) {
      targetPath = path.resolve(cleanedPath);
    } else if (cleanedPath.includes('/') || cleanedPath.includes('\\')) {
      targetPath = path.resolve(cwd, cleanedPath);
    } else {
      targetPath = path.join(parentDir, cleanedPath);
    }

    await cloneProject(cwd, targetPath);
    console.log(chalk.blue(`\n📂 작업 경로가 변경되었습니다: ${targetPath}`));
  }

  // 이전 실행에서 남아있는 step 아티팩트를 정리합니다.
  await cleanupStaleStepArtifacts(targetPath);

  const stepEntries = [
    ['step1', runStep1],
    ['step2', runStep2],
    ['step3', runStep3],
    ['step4', runStep4],
    ['step5', runStep5],
    ['step6', runStep6],
    ['step7', runStep7],
  ];

  const finalReviewSession = await createSnapshotReviewSession(targetPath, 'step7', async (projectRoot) => {
    for (const [stepName, stepRunner] of stepEntries) {
      const partNum = stepName.replace('step', '');
      console.log(chalk.yellow(`\n==================== Part ${partNum} (${stepName}) ====================`));
      await stepRunner(projectRoot);
    }
  });

  const { manifest, manifestPath } = finalReviewSession;

  if (!manifestPath || !Array.isArray(manifest?.changes) || manifest.changes.length === 0) {
    console.log(chalk.green('\n✔ step1~step7 완료: 최종 변경 없음'));
    const installCmd = getInstallCommand(pm);
    console.log(chalk.yellow('\n👉 다음 단계 안내'));
    console.log(chalk.white(`   - ${installCmd} (의존성 설치)`));
    console.log(chalk.white('   - 마이그레이션된 프로젝트에서 빌드/실행을 확인하세요. '));
    return;
  }

  const typeSummary = summarizeChangeTypes(manifest.changes);
  console.log(chalk.green(`\n✔ step1~step7 완료: 최종 리뷰 대상 ${manifest.changes.length}개 변경`));
  console.log(
    chalk.white(
      `변경사항 type: create ${typeSummary.create}, modify ${typeSummary.modify}, delete ${typeSummary.delete}`,
    ),
  );

  const openResult = openFirstReviewableDiff(manifest);
  if (openResult.opened) {
    console.log(chalk.blue(`첫 번째 diff를 ${openResult.command}에서 열었습니다.`));
  } else {
    console.log(chalk.yellow('자동으로 diff를 열지 못했습니다. Nextify Review 패널에서 수동으로 열어주세요.'));
  }

  console.log(chalk.yellow('\n⏳ 최종 Gemini CLI 리뷰를 시작합니다.'));

  const aiAbort = new AbortController();
  const onSigint = () => {
    if (!aiAbort.signal.aborted) {
      process.stdout.write('\n');
      console.log(chalk.yellow('⏹ Ctrl+C 감지: 현재 Gemini CLI 리뷰를 중단합니다.'));
      aiAbort.abort();
    }
  };

  const sessionClearedPromise = waitForSessionCleared(manifestPath);
  process.on('SIGINT', onSigint);
  try {
    const aiReviewPromise = runAiReviewSessionStream({
      sessionPath: manifestPath,
      signal: aiAbort.signal,
      transport: 'cli',
      mode: 'interactive-seeded',
      model: process.env.NEXTIFY_GEMINI_CLI_MODEL || 'gemini-2.5-flash-lite',
      workingDirectory: targetPath,
      onChunk: (t) => process.stdout.write(t),
    });

    await Promise.all([sessionClearedPromise, aiReviewPromise]);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error(chalk.red('\n❌ Gemini CLI를 찾을 수 없습니다.'));
      console.log(chalk.yellow('   - Gemini CLI를 설치하고 `gemini` 명령이 PATH에서 실행되는지 확인하세요.'));
    }
    throw err;
  } finally {
    process.off('SIGINT', onSigint);
  }

  console.log(chalk.green('\n✔ Final review complete.'));

  const installCmd = getInstallCommand(pm);
  console.log(chalk.yellow('\n👉 다음 단계 안내'));
  console.log(chalk.white(`   - ${installCmd} (의존성 설치)`));
  console.log(chalk.white('   - 마이그레이션된 프로젝트에서 빌드/실행을 확인하세요. '));
}

// Only run default orchestrator when user calls `migrate-next` with no subcommand.
const argv = process.argv.slice(2);
if (argv.length === 0) {
  runDefaultOrchestrator().catch((e) => {
    console.error(chalk.red('\n❌ 기본 오케스트레이터 오류:'), e?.message || e);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
