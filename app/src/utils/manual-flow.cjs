'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const { runAskApply } = require('./ai-file-apply.cjs');
const { printRelPathsBlock } = require('./path-list-print.cjs');
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

/**
 * 사용자 직접처리 가이드 출력 직후: y(또는 Enter)만 허용 후 계속
 */
async function askContinueAfterManualGuide() {
  await inquirer.prompt([
    {
      type: 'input',
      name: 'ans',
      message: chalk.yellow('마이그레이션을 계속 진행할까요? (y, Enter=y)'),
      default: 'y',
      validate: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        if (s === '' || s === 'y') return true;
        return '계속하려면 y 를 입력하세요.';
      },
      filter: (input) => {
        const s = String(input ?? '').trim().toLowerCase();
        return s === '' ? 'y' : s;
      },
    },
  ]);
}

/**
 * 이슈 안내 후 확인 없이 Gemini로 관련 파일을 수정합니다.
 * @param {{ projectRoot: string, discoveryLine: string, discoverySources?: string[], instructionForAi: string, candidateRelPaths: string[] }} opts
 */
async function stopAndOfferGeminiApply(opts) {
  const {
    projectRoot,
    discoveryLine,
    discoverySources = [],
    instructionForAi,
    candidateRelPaths,
    manualGuideLines = [],
    manualFallback,
  } = opts;



  const existing = [];
  for (const rel of candidateRelPaths) {
    const abs = path.join(projectRoot, rel);
    if (await fs.pathExists(abs)) {
      existing.push(path.normalize(rel));
    }
  }

  console.log(chalk.yellow(`\n${discoveryLine}`));
  if (Array.isArray(discoverySources) && discoverySources.length > 0) {
    const uniq = [...new Set(discoverySources.map((s) => String(s).trim()).filter(Boolean))];
    if (uniq.length > 0) {
      printRelPathsBlock(chalk.gray, '  발견 위치', uniq);
    }
  }

  if (existing.length === 0) {
    console.error(chalk.red('\n❌ AI에 넘길 대상 파일이 없습니다. 경로를 확인하세요.\n'));
    process.exit(1);
  }

  console.log(chalk.cyan('→ Gemini로 관련 파일을 수정합니다.\n'));

  if (!process.env.GEMINI_API_KEY) {
    console.error(
      chalk.red('\n❌ GEMINI_API_KEY가 없습니다. AI 자동 수정을 사용할 수 없습니다.\n')
    );
    process.exit(1);
  }

  const context = getProjectContext(projectRoot);
  const spinner = ora('Gemini가 코드를 적용하는 중...').start();
  try {
    const written = await runAskApply({
      projectRoot,
      question: instructionForAi,
      filesCsv: existing.join(','),
      context,
    });
    spinner.stop();
    printRelPathsBlock(chalk.green, '\n✅ Gemini 적용 완료', written);
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
  askContinueAfterManualGuide,
  stopAndOfferGeminiApply,
  collectMigrationCandidateRelPaths,
  DEFAULT_MAX_MIGRATION_SOURCE_FILES,
};
