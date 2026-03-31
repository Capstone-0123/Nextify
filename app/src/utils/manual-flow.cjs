'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const { runAskApply } = require('./ai-file-apply.cjs');
const {
  detectBuildTool,
  detectLanguage,
  detectPackageManager,
} = require('./project-info.cjs');

function getProjectContext(projectRoot) {
  return {
    buildTool: detectBuildTool(projectRoot),
    language: detectLanguage(projectRoot),
    packageManager: detectPackageManager(projectRoot),
  };
}

/** 충돌·가이드-only 구간: 안내 후 종료 (재실행 유도) — 레거시/특수 경로용 */
function exitMigrationManualFollowup() {
  console.log(
    chalk.yellow('\n위 안내에 따라 수동으로 정리한 뒤, 마이그레이션을 다시 실행하세요.\n')
  );
  process.exit(1);
}

function validateYnStrict(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'y' || s === 'n') return true;
  return 'y 또는 n 을 입력하세요.';
}

/** 수동 가이드 출력 직후: y면 마이그레이션 계속, n이면 exit(1) */
async function askContinueAfterManualGuide() {
  const { ans } = await inquirer.prompt([
    {
      type: 'input',
      name: 'ans',
      message: chalk.yellow('마이그레이션을 계속 진행할까요? (y/n, n이면 종료)'),
      default: 'y',
      validate: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        if (s === '' || s === 'y' || s === 'n') return true;
        return 'y 또는 n 을 입력하세요.';
      },
      filter: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        return s === '' ? 'y' : s;
      },
    },
  ]);
  if (ans !== 'y') {
    console.log(chalk.yellow('\n종료합니다. 필요 시 안내에 따라 수정한 뒤 다시 실행하세요.\n'));
    process.exit(1);
  }
}

/**
 * Gemini 구간: discoveryLine 출력 후 y/n (n → exit)
 * @param {{ projectRoot: string, discoveryLine: string, instructionForAi: string, candidateRelPaths: string[], manualFallback?: string }} opts
 * @returns {Promise<{applied: boolean}>} applied=true이면 Gemini가 파일을 수정/적용한 상태입니다.
 */
async function stopAndOfferGeminiApply(opts) {
  const { projectRoot, discoveryLine, instructionForAi, candidateRelPaths, manualFallback } = opts;

  const existing = [];
  for (const rel of candidateRelPaths) {
    const abs = path.join(projectRoot, rel);
    if (await fs.pathExists(abs)) {
      existing.push(path.normalize(rel));
    }
  }

  console.log(chalk.yellow(`\n${discoveryLine}`));

  if (existing.length === 0) {
    console.error(chalk.red('\n❌ AI에 넘길 대상 파일이 없습니다. 경로를 확인하세요.\n'));
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error(
      chalk.red('\n❌ GEMINI_API_KEY가 없습니다. AI 자동 수정을 사용할 수 없습니다.\n')
    );
    process.exit(1);
  }

  const { ans } = await inquirer.prompt([
    {
      type: 'input',
      name: 'ans',
      message: chalk.yellow('Gemini로 관련 파일을 자동 수정할까요? (y=적용, n=수동 처리 안내 후 계속)'),
      validate: validateYnStrict,
      filter: (input) => String(input ?? '').trim().toLowerCase(),
    },
  ]);

  if (ans !== 'y') {
    const manualText = manualFallback || instructionForAi;
    console.log(chalk.yellow('\n🤚 Gemini 자동 수정은 건너뜁니다. 아래 안내에 따라 수동으로 수정하세요.\n'));
    console.log(chalk.white(manualText));
    // askContinueAfterManualGuide 내부에서 사용자가 n을 고르면 기존처럼 종료합니다.
    await askContinueAfterManualGuide();
    return { applied: false };
  }

  const spinner = ora('Gemini가 코드를 적용하는 중...').start();
  try {
    const written = await runAskApply({
      projectRoot,
      question: instructionForAi,
      filesCsv: existing.join(','),
      context: getProjectContext(projectRoot),
    });
    spinner.stop();
    console.log(chalk.green(`\n✅ Gemini 적용 완료: ${written.join(', ')}`));
    console.log(chalk.green('마이그레이션을 계속 진행합니다.\n'));
    return { applied: true };
  } catch (e) {
    spinner.stop();
    console.error(chalk.red(`\n❌ Gemini 적용 실패: ${e.message}\n`));
    process.exit(1);
  }
}

/**
 * Gemini에 넘길 상대 경로 목록 (루트 설정 + src 하위 소스, 토큰 한도용 개수 제한)
 * @param {string} projectRoot
 * @param {number} maxSourceFiles
 * @returns {Promise<string[]>}
 */
/** src 하위에 포함할 소스 파일 상한 (루트 설정 파일 개수는 별도) */
const DEFAULT_MAX_MIGRATION_SOURCE_FILES = 220;

async function collectMigrationCandidateRelPaths(
  projectRoot,
  maxSourceFiles = DEFAULT_MAX_MIGRATION_SOURCE_FILES
) {
  const rootCandidates = [
    'vite.config.ts',
    'vite.config.mjs',
    'next.config.mjs',
    'next.config.js',
    'tsconfig.json',
    'tsconfig.app.json',
    'package.json',
  ];
  const out = [];
  for (const rel of rootCandidates) {
    if (await fs.pathExists(path.join(projectRoot, rel))) {
      out.push(rel);
    }
  }

  const srcDir = path.join(projectRoot, 'src');
  if (!(await fs.pathExists(srcDir))) {
    return [...new Set(out)];
  }

  const collected = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (collected.length >= maxSourceFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', '.git'].includes(e.name)) continue;
        await walk(full);
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) {
        collected.push(path.relative(projectRoot, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(srcDir);
  out.push(...collected.slice(0, maxSourceFiles));
  return [...new Set(out)];
}

module.exports = {
  getProjectContext,
  exitMigrationManualFollowup,
  askContinueAfterManualGuide,
  stopAndOfferGeminiApply,
  collectMigrationCandidateRelPaths,
  DEFAULT_MAX_MIGRATION_SOURCE_FILES,
};
