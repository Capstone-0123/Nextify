'use strict';

// app/src/step7/typecheck-report.cjs
// Step 7 마지막에 마이그레이션된 프로젝트에서 `tsc --noEmit` 을 실행해
// 잠재적 빌드 에러를 처리하는 통합 흐름:
//   1) tsc 1차 → 에러 수집
//   2) 결정론적 autofix (typecheck-autofix.cjs)  — 토큰 비용 0
//   3) tsc 2차 → 잔여 확인
//   4) AI 좁은-컨텍스트 1회 재호출 (typecheck-ai-fix.cjs) — 옵션 가능, 토큰 사용
//   5) tsc 3차 → 회귀 감지 시 백업으로 롤백
//   6) tsc 4차 (롤백 발생 시에만) → 최종 잔여
//   7) 잔여를 사용자에게 친절하게 리포트
//
// 모든 패스는 best-effort. 어떤 단계가 실패해도 마이그레이션 결과물은 보존되고,
// 사용자에게는 정확한 위치/원인이 안내된다.

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');

const { autofixErrors } = require('./typecheck-autofix.cjs');
const {
  aiFixRemainingErrors,
  rollbackRegressions,
  DEFAULT_AI_FIX_BUDGET,
} = require('./typecheck-ai-fix.cjs');
const { sweepAfterAiApply } = require('../utils/post-ai-sweep.cjs');

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
 * - npx tsc --noEmit --pretty false 사용해 stable 한 텍스트 결과 보장
 * - 큰 프로젝트도 여유롭게 (180s)
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
 * 라인 형식: `src/hooks/useMovies.ts(24,5): error TS6133: 'initialScrollY' is declared but its value is never read.`
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
 * tsc 한 번 실행하고 에러 배열을 반환.
 * - 실행 자체가 실패하면 null 을 반환해 호출자가 흐름을 중단할 수 있게 한다.
 */
function runTscAndParse(projectRoot) {
  let result;
  try {
    result = runTsc(projectRoot);
  } catch (e) {
    return { ok: false, reason: 'spawn_error', message: e?.message };
  }
  if (result.error) {
    return { ok: false, reason: 'tsc_unavailable', message: result.error.message };
  }
  const exitCode = typeof result.status === 'number' ? result.status : -1;
  const errors = parseTscErrors(result.stdout, result.stderr);
  return {
    ok: true,
    exitCode,
    errors,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * 마이그레이션된 프로젝트의 tsc 잔여 에러를 결정론·AI 단계로 자동 수정 후 리포트.
 *
 * @param {string} projectRoot
 * @param {{
 *   autofix?: boolean,        // 결정론적 autofix on/off (기본 true)
 *   aiFix?: boolean,          // AI 1회 재호출 on/off (기본 true, GEMINI_API_KEY 없으면 자동 off)
 *   aiFixBudget?: number,     // AI 호출 최대 파일 수 (기본 5)
 * }} [options]
 * @returns {Promise<object>}
 */
async function runFinalTypecheckReport(projectRoot, options = {}) {
  const {
    autofix = true,
    aiFix = true,
    aiFixBudget = DEFAULT_AI_FIX_BUDGET,
  } = options;

  if (!hasTsConfig(projectRoot)) {
    return { ran: false, reason: 'no_tsconfig' };
  }

  // ── 0) 결정론적 src/ 전체 sweep (typecheck 직전 안전망) ─────────────
  // step5/7 의 여러 Gemini 호출에서 sweep 가 누락된 파일이 있을 수 있고,
  // 호출 순서로 인해 dead 가 된 후 sweep 가 한 번도 안 도는 경우(예: layout.tsx
  // 의 import Image 가 다른 단계 적용 후에야 unused 가 되는 케이스)도 있습니다.
  // typecheck 직전에 결정론적으로 한 번 정리해 ai-fix budget 을 보존합니다.
  try {
    const srcDir = path.join(projectRoot, 'src');
    if (await fs.pathExists(srcDir)) {
      const allRel = [];
      const walk = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (['node_modules', '.next', '.git', 'dist', 'build'].includes(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full);
          } else if (/\.(t|j)sx?$/.test(e.name)) {
            allRel.push(path.relative(projectRoot, full).split(path.sep).join('/'));
          }
        }
      };
      await walk(srcDir);
      const r = await sweepAfterAiApply(projectRoot, allRel);
      if (r.removedTargets.length > 0) {
        console.log(
          chalk.cyan(
            `   🧹 typecheck 직전 src/ 결정론 sweep: ${r.removedTargets.length}건 정리 (${r.changedFiles.length}개 파일)`,
          ),
        );
      }
    }
  } catch (e) {
    console.log(
      chalk.gray(`   ⚠️  typecheck 직전 sweep 중 오류(무시): ${e?.message || e}`),
    );
  }

  // ── 1차 tsc ──────────────────────────────────────────────────────────
  console.log(chalk.gray('   ⏳ TypeScript 타입 검사 중 (tsc --noEmit) ...'));
  const t0 = Date.now();
  const first = runTscAndParse(projectRoot);
  if (!first.ok) {
    console.log(
      chalk.gray(`   ⚠️  타입 검사를 건너뜁니다: ${first.message || first.reason}`),
    );
    return { ran: false, reason: first.reason };
  }

  if (first.exitCode === 0 && first.errors.length === 0) {
    console.log(chalk.green('   ✅ 타입 검사 통과: 별다른 unused/type 에러가 없습니다.'));
    return { ran: true, exitCode: 0, errors: [], autofixed: 0, aiFixed: 0 };
  }

  console.log(
    chalk.gray(
      `   📋 1차 검사: ${first.errors.length}개 에러 — 자동 수정 시도 시작`,
    ),
  );

  // ── 2) 결정론적 autofix ──────────────────────────────────────────────
  let autofixSummary = { totalFixed: 0, fixedFiles: [] };
  if (autofix) {
    try {
      autofixSummary = await autofixErrors(projectRoot, first.errors);
      if (autofixSummary.totalFixed > 0) {
        console.log(
          chalk.cyan(
            `   🛠  결정론적 자동 수정: ${autofixSummary.totalFixed}건 (${autofixSummary.fixedFiles.length}개 파일) — 토큰 비용 0`,
          ),
        );
      } else {
        console.log(chalk.gray('   ℹ️  결정론적 자동 수정 대상 없음'));
      }
    } catch (e) {
      console.log(
        chalk.gray(`   ⚠️  결정론적 자동 수정 중 오류(무시): ${e?.message || e}`),
      );
    }
  }

  // ── 2.5) 결정론적 수정 후 재검사 (AI 호출 전 잔여 확정) ──────────────
  let secondErrors = first.errors;
  let secondExit = first.exitCode;
  let secondStdout = first.stdout;
  let secondStderr = first.stderr;
  if (autofixSummary.totalFixed > 0) {
    const second = runTscAndParse(projectRoot);
    if (second.ok) {
      secondErrors = second.errors;
      secondExit = second.exitCode;
      secondStdout = second.stdout;
      secondStderr = second.stderr;
      const delta = first.errors.length - secondErrors.length;
      console.log(
        chalk.gray(
          `   📋 2차 검사: ${secondErrors.length}개 잔여 (자동 수정으로 ${delta >= 0 ? delta : 0}건 해소)`,
        ),
      );
    }
  }

  // ── 3) AI 좁은-컨텍스트 1회 재호출 (옵션) ────────────────────────────
  let aiSummary = {
    ran: false,
    filesAttempted: [],
    filesChanged: [],
    skipped: [],
    rolledBack: [],
  };
  let finalErrors = secondErrors;
  let finalExit = secondExit;
  let finalStdout = secondStdout;
  let finalStderr = secondStderr;

  if (aiFix && secondErrors.length > 0) {
    if (!process.env.GEMINI_API_KEY) {
      console.log(
        chalk.gray(
          '   ℹ️  GEMINI_API_KEY 없음 — AI 보정 단계는 건너뜁니다.',
        ),
      );
    } else {
      console.log(
        chalk.cyan(
          `   🤖 AI 보정 시도: 잔여 ${secondErrors.length}건을 파일당 1회씩, 최대 ${aiFixBudget}개 파일 의뢰`,
        ),
      );
      try {
        aiSummary = await aiFixRemainingErrors(projectRoot, secondErrors, {
          budget: aiFixBudget,
        });
      } catch (e) {
        console.log(
          chalk.gray(`   ⚠️  AI 보정 중 오류(무시): ${e?.message || e}`),
        );
      }

      if (aiSummary.ran && aiSummary.filesAttempted.length > 0) {
        // ── 4) AI 호출 후 tsc 3차 → 회귀 롤백 ────────────────────────
        const third = runTscAndParse(projectRoot);
        if (third.ok) {
          const beforeAi = secondErrors;
          const afterAi = third.errors;

          // 회귀 (해당 파일의 에러가 더 늘어난 경우) 롤백
          let rolledBack = [];
          try {
            rolledBack = await rollbackRegressions(
              projectRoot,
              aiSummary.filesAttempted,
              beforeAi,
              afterAi,
            );
          } catch {
            rolledBack = [];
          }
          aiSummary.rolledBack = rolledBack;

          if (rolledBack.length > 0) {
            console.log(
              chalk.yellow(
                `   ↩️  AI 보정 회귀 ${rolledBack.length}건 감지 → 백업으로 롤백`,
              ),
            );
            // 롤백했으니 한 번 더 tsc 4차 실행
            const fourth = runTscAndParse(projectRoot);
            if (fourth.ok) {
              finalErrors = fourth.errors;
              finalExit = fourth.exitCode;
              finalStdout = fourth.stdout;
              finalStderr = fourth.stderr;
            } else {
              finalErrors = afterAi;
              finalExit = third.exitCode;
              finalStdout = third.stdout;
              finalStderr = third.stderr;
            }
          } else {
            finalErrors = afterAi;
            finalExit = third.exitCode;
            finalStdout = third.stdout;
            finalStderr = third.stderr;
          }

          const aiDelta = beforeAi.length - finalErrors.length;
          if (aiSummary.filesChanged.length > 0) {
            console.log(
              chalk.cyan(
                `   🤖 AI 보정 결과: ${aiSummary.filesChanged.length}개 파일 변경, ${aiDelta >= 0 ? aiDelta : 0}건 해소`,
              ),
            );
          }
        }
      }
    }
  }

  const elapsedMs = Date.now() - t0;

  // ── 5) 최종 리포트 ──────────────────────────────────────────────────
  if (finalErrors.length === 0 && finalExit === 0) {
    const summary = [
      `   ✅ 타입 검사 통과 (총 ${(elapsedMs / 1000).toFixed(1)}s)`,
    ];
    if (autofixSummary.totalFixed > 0) {
      summary.push(`      • 결정론적 자동 수정: ${autofixSummary.totalFixed}건`);
    }
    if (aiSummary.filesChanged.length > 0) {
      summary.push(`      • AI 보정: ${aiSummary.filesChanged.length}개 파일`);
    }
    if (aiSummary.rolledBack.length > 0) {
      summary.push(`      • 회귀 롤백: ${aiSummary.rolledBack.length}개 파일`);
    }
    console.log(chalk.green(summary.join('\n')));
    return {
      ran: true,
      exitCode: 0,
      errors: [],
      autofixed: autofixSummary.totalFixed,
      aiFixed: aiSummary.filesChanged.length,
      rolledBack: aiSummary.rolledBack.length,
      elapsedMs,
    };
  }

  // 잔여 에러 리포트 파일 저장
  const reportPath = path.join(projectRoot, REPORT_FILE_NAME);
  const header = [
    '# Nextify TypeScript Typecheck Report',
    `# generated at: ${new Date().toISOString()}`,
    `# project: ${projectRoot}`,
    `# exit code: ${finalExit}`,
    `# elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
    `# autofix(deterministic): ${autofixSummary.totalFixed} fixes / ${autofixSummary.fixedFiles.length} files`,
    `# ai-fix: ${aiSummary.filesChanged.length} files changed, ${aiSummary.rolledBack.length} rolled back`,
    '#',
    '# 이 리포트는 결정론적 + AI 자동 수정 후에도 남은 에러만 표시합니다.',
    '# 위치를 직접 확인하려면 프로젝트 루트에서 `npx tsc --noEmit` 을 다시 실행하세요.',
    '',
  ].join('\n');
  const body = (finalStdout || '') + (finalStderr || '');
  try {
    await fs.writeFile(reportPath, header + body, 'utf-8');
  } catch {
    // ignore write failure
  }

  // 콘솔 요약
  const total = finalErrors.length;
  const grouped = formatGroupedSummary(finalErrors);

  console.log('');
  console.log(
    chalk.yellow.bold(
      `   ⚠️  타입 검사 경고: ${total}개의 잠재적 빌드 에러가 남아있습니다.`,
    ),
  );
  const stageLine = [];
  if (autofixSummary.totalFixed > 0) {
    stageLine.push(`결정론 ${autofixSummary.totalFixed}건 해소`);
  }
  if (aiSummary.filesChanged.length > 0) {
    stageLine.push(`AI ${aiSummary.filesChanged.length}개 파일 보정`);
  }
  if (aiSummary.rolledBack.length > 0) {
    stageLine.push(`회귀 ${aiSummary.rolledBack.length}개 롤백`);
  }
  if (stageLine.length > 0) {
    console.log(chalk.gray(`      (적용 단계: ${stageLine.join(' / ')})`));
  }
  console.log(
    chalk.gray(
      '      (마이그레이션 결과물은 그대로 보존됩니다. 빌드 시 동일 에러가 발생할 수 있습니다.)',
    ),
  );
  console.log('');

  for (const g of grouped.slice(0, 8)) {
    const isKey = KEY_TS_ERROR_CODES.has(g.code);
    const tag = isKey ? chalk.red(`[${g.code}]`) : chalk.yellow(`[${g.code}]`);
    const line = `      ${tag} ${g.count}건 — 예: ${g.sample.file}:${g.sample.line}:${g.sample.column} ${g.sample.message}`;
    console.log(line);
  }
  if (grouped.length > 8) {
    console.log(
      chalk.gray(`      ... 그 외 ${grouped.length - 8}개 코드 종류`),
    );
  }

  console.log('');
  console.log(chalk.cyan(`      📄 자세한 내용: ${reportPath}`));
  console.log(
    chalk.cyan(
      `      🛠  수동 점검: 프로젝트 루트에서 \`npx tsc --noEmit\` 을 다시 실행해 위치를 확인하세요.`,
    ),
  );
  console.log(
    chalk.gray(
      `      ⏱  타입 검사+자동 수정 총 소요: ${(elapsedMs / 1000).toFixed(1)}s`,
    ),
  );
  console.log('');

  return {
    ran: true,
    exitCode: finalExit,
    errors: finalErrors,
    autofixed: autofixSummary.totalFixed,
    aiFixed: aiSummary.filesChanged.length,
    rolledBack: aiSummary.rolledBack.length,
    reportPath,
    elapsedMs,
  };
}

module.exports = {
  runFinalTypecheckReport,
};
