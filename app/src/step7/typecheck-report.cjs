'use strict';

// app/src/step7/typecheck-report.cjs
// Step 7 마지막에 마이그레이션된 프로젝트에서 `tsc --noEmit`을 실행해
// "사용되지 않는 변수/타입(TS6133, TS6196, TS6138)" 등을 경고로 출력합니다.
// 자동 수정은 하지 않습니다 — 결정론적 sweep으로 못 잡은 잔여를 사용자에게 정확히 알려주는 용도.
// 마이그레이션 자체의 성공/실패에 영향을 주지 않습니다(경고 only).

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');

const REPORT_FILE_NAME = 'nextify-typecheck-report.txt';

// 사용자가 곧장 빌드 실패로 만나는 핵심 코드들
const KEY_TS_ERROR_CODES = new Set([
  'TS6133', // 'X' is declared but its value is never read.
  'TS6138', // Property 'X' is declared but its value is never read.
  'TS6196', // 'X' is declared but never used.
  'TS6192', // All imports in import declaration are unused.
  'TS2304', // Cannot find name 'X'.
  'TS2552', // Cannot find name 'X'. Did you mean 'Y'?
]);

function hasTsConfig(projectRoot) {
  return fs.existsSync(path.join(projectRoot, 'tsconfig.json'));
}

/**
 * tsc 실행. 표준 출력을 캡처하고 종료 코드를 반환.
 * - npx tsc --noEmit --pretty false 사용해 stable한 텍스트 결과 보장
 * - 타임아웃 방지: 큰 프로젝트도 여유롭게 (180s)
 */
function runTsc(projectRoot) {
  const args = ['tsc', '--noEmit', '--pretty', 'false'];
  const result = spawnSync('npx', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 180_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return result;
}

/**
 * tsc 출력을 파싱해 에러 행만 모음.
 * 라인 형식 예: `src/hooks/useMovies.ts(24,5): error TS6133: 'initialScrollY' is declared but its value is never read.`
 */
function parseTscErrors(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const lines = text.split(/\r?\n/);
  const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
  const errors = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const [, file, lineStr, colStr, kind, code, message] = m;
    errors.push({
      file: file.replace(/\\/g, '/'),
      line: Number(lineStr),
      column: Number(colStr),
      kind,
      code,
      message: message.trim(),
    });
  }
  return errors;
}

function formatGroupedSummary(errors) {
  const byCode = new Map();
  for (const e of errors) {
    if (!byCode.has(e.code)) byCode.set(e.code, []);
    byCode.get(e.code).push(e);
  }
  const out = [];
  for (const [code, list] of byCode.entries()) {
    out.push({ code, count: list.length, sample: list[0] });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * 마이그레이션된 프로젝트에서 tsc --noEmit을 실행하고 결과를 출력/저장.
 * - 토큰 비용 0 (LLM 호출 없음)
 * - 실패해도 마이그레이션 흐름을 막지 않음 (경고만)
 */
async function runFinalTypecheckReport(projectRoot) {
  if (!hasTsConfig(projectRoot)) {
    return { ran: false, reason: 'no_tsconfig' };
  }

  console.log(chalk.gray('   ⏳ TypeScript 타입 검사 중 (tsc --noEmit) ...'));

  let result;
  try {
    result = runTsc(projectRoot);
  } catch (e) {
    console.log(chalk.gray(`   ⚠️  타입 검사를 건너뜁니다: ${e?.message || e}`));
    return { ran: false, reason: 'spawn_error' };
  }

  if (result.error) {
    console.log(chalk.gray(`   ⚠️  타입 검사를 건너뜁니다: ${result.error.message || result.error}`));
    return { ran: false, reason: 'tsc_unavailable' };
  }

  const exitCode = typeof result.status === 'number' ? result.status : -1;
  const errors = parseTscErrors(result.stdout, result.stderr);

  if (exitCode === 0 && errors.length === 0) {
    console.log(chalk.green('   ✅ 타입 검사 통과: 별다른 unused/type 에러가 없습니다.'));
    return { ran: true, exitCode, errors: [] };
  }

  // 리포트 파일 저장
  const reportPath = path.join(projectRoot, REPORT_FILE_NAME);
  const header = [
    '# Nextify TypeScript Typecheck Report',
    `# generated at: ${new Date().toISOString()}`,
    `# project: ${projectRoot}`,
    `# exit code: ${exitCode}`,
    '#',
    '# 이 리포트는 자동 수정이 아니라 사용자 검토용입니다.',
    '# 결정론적 sweep으로 잡지 못한 잔여 unused/type 에러만 표시합니다.',
    '',
  ].join('\n');
  const body = (result.stdout || '') + (result.stderr || '');
  try {
    await fs.writeFile(reportPath, header + body, 'utf-8');
  } catch {
    // ignore write failure
  }

  // 콘솔 요약
  const total = errors.length;
  const grouped = formatGroupedSummary(errors);

  console.log('');
  console.log(chalk.yellow.bold(`   ⚠️  타입 검사 경고: ${total}개의 잠재적 빌드 에러가 감지되었습니다.`));
  console.log(chalk.gray('      (마이그레이션 결과물은 그대로 보존됩니다. 빌드 시 동일 에러가 발생할 수 있습니다.)'));
  console.log('');

  for (const g of grouped.slice(0, 8)) {
    const isKey = KEY_TS_ERROR_CODES.has(g.code);
    const tag = isKey ? chalk.red(`[${g.code}]`) : chalk.yellow(`[${g.code}]`);
    const line = `      ${tag} ${g.count}건 — 예: ${g.sample.file}:${g.sample.line}:${g.sample.column} ${g.sample.message}`;
    console.log(line);
  }
  if (grouped.length > 8) {
    console.log(chalk.gray(`      ... 그 외 ${grouped.length - 8}개 코드 종류`));
  }

  console.log('');
  console.log(chalk.cyan(`      📄 자세한 내용: ${reportPath}`));
  console.log(chalk.cyan(`      🛠  수동 점검: 프로젝트 루트에서 \`npx tsc --noEmit\`을 다시 실행해 위치를 확인하세요.`));
  console.log('');

  return { ran: true, exitCode, errors, reportPath };
}

module.exports = {
  runFinalTypecheckReport,
};
