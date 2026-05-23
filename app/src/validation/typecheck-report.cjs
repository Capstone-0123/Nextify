<<<<<<< HEAD
'use strict';

// app/src/validation/typecheck-report.cjs
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
const {
  runStaticImportScan,
  writeStaticImportReport,
} = require('./static-import-scan.cjs');
const { sweepAfterAiApply } = require('../utils/post-ai-sweep.cjs');

const REPORT_FILE_NAME = 'nextify-typecheck-report.txt';
const TSCONFIG_FILE_NAME = 'tsconfig.json';
const TS_CONFIG_SUSPECT_CODES = new Set(['TS17004', 'TS6142', 'TS1259']);

// 사용자가 곧장 빌드 실패로 만나는 핵심 코드들
const KEY_TS_ERROR_CODES = new Set([
  'TS6133', // 'X' is declared but its value is never read.
  'TS6138', // Property 'X' is declared but its value is never read.
  'TS6196', // 'X' is declared but never used.
  'TS6192', // All imports in import declaration are unused.
  'TS2304', // Cannot find name 'X'.
  'TS2307', // Cannot find module 'X'.
  'TS2552', // Cannot find name 'X'. Did you mean 'Y'?
]);

const ERROR_LABEL_RULES = [
  {
    id: 'tsconfig-jsx-interop',
    when: (e) =>
      e.code === 'TS17004' ||
      e.code === 'TS6142' ||
      (e.code === 'TS1259' && /esModuleInterop/i.test(e.message || '')),
    lever: 'tsconfig_normalization',
    autoFixable: false,
  },
  {
    id: 'jsx-null-render',
    when: (e) =>
      e.code === 'TS2339' &&
      /Property 'null' does not exist on type 'JSX\.IntrinsicElements'/i.test(e.message || ''),
    lever: 'null_return_rewrite',
    autoFixable: true,
  },
  {
    id: 'router-hook-migration',
    when: (e) =>
      (e.code === 'TS2304' || e.code === 'TS2552') &&
      /Cannot find name ['"`](useLocation|useNavigate|useHistory)['"`]/i.test(e.message || ''),
    lever: 'router_hook_replacement',
    autoFixable: false,
  },
  {
    id: 'module-resolution',
    when: (e) =>
      e.code === 'TS2307' ||
      /Cannot find module/i.test(e.message || '') ||
      /Cannot find type definition file/i.test(e.message || ''),
    lever: 'alias_and_types_resolution',
    autoFixable: true,
  },
  {
    id: 'route-object-navigation',
    when: (e) =>
      e.code === 'TS2345' &&
      /Argument of type '\{ pathname: string; query:/i.test(e.message || '') &&
      /is not assignable to parameter of type 'string'/i.test(e.message || ''),
    lever: 'next_router_push_rewrite',
    autoFixable: false,
  },
  {
    id: 'style-namespace-missing',
    when: (e) =>
      (e.code === 'TS2304' || e.code === 'TS2552') &&
      /Cannot find name ['"`](R|styled)['"`]/i.test(e.message || ''),
    lever: 'style_symbol_restore',
    autoFixable: false,
  },
  {
    id: 'missing-identifier',
    when: (e) =>
      e.code === 'TS2304' || e.code === 'TS2552' || /Cannot find name/i.test(e.message || ''),
    lever: 'import_injection_or_symbol_fix',
    autoFixable: true,
  },
  {
    id: 'unused-declaration',
    when: (e) =>
      e.code === 'TS6133' ||
      e.code === 'TS6138' ||
      e.code === 'TS6192' ||
      e.code === 'TS6196',
    lever: 'unused_cleanup',
    autoFixable: true,
  },
  {
    id: 'router-migration',
    when: (e) =>
      /NavigateOptions/i.test(e.message || '') ||
      /state' does not exist in type 'NavigateOptions'/i.test(e.message || ''),
    lever: 'router_state_rewrite',
    autoFixable: false,
  },
  {
    id: 'jsx-component-type',
    when: (e) =>
      e.code === 'TS2786' ||
      e.code === 'TS2607' ||
      /cannot be used as a JSX component/i.test(e.message || ''),
    lever: 'react_next_type_alignment',
    autoFixable: false,
  },
];

function hasTsConfig(projectRoot) {
  return fs.existsSync(path.join(projectRoot, TSCONFIG_FILE_NAME));
}

/**
 * 프로젝트 안의 tsc 바이너리(있으면 가장 안정적)를 찾는다.
 * yarn / pnpm / npm 어떤 매니저로 설치됐든 typescript 가 devDependency 면
 * `node_modules/.bin/tsc(.cmd)` 가 존재한다.
 */
function resolveLocalTscBinary(projectRoot) {
  const isWin = process.platform === 'win32';
  const binNames = isWin ? ['tsc.cmd', 'tsc.CMD'] : ['tsc'];
  for (const name of binNames) {
    const p = path.join(projectRoot, 'node_modules', '.bin', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 패키지 매니저별로 tsc 를 실행할 명령을 만든다.
 * - npm  : npx -y tsc ...
 * - yarn : yarn tsc ... (1.x / 2+ 모두 동일)
 * - pnpm : pnpm exec tsc ...
 * - bun  : bunx tsc ...
 */
function buildPackageManagerTscCommand(projectRoot) {
  const isWin = process.platform === 'win32';
  const ext = (b) => (isWin ? `${b}.cmd` : b);

  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
    return { cmd: ext('yarn'), prefix: ['tsc'] };
  }
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return { cmd: ext('pnpm'), prefix: ['exec', 'tsc'] };
  }
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
    return { cmd: ext('bunx'), prefix: ['tsc'] };
  }
  // npm 또는 lockfile 없음
  return { cmd: ext('npx'), prefix: ['-y', 'tsc'] };
}

/**
 * tsc 실행. 표준 출력을 캡처하고 종료 코드를 반환.
 * - 우선순위 1: 프로젝트 로컬 tsc 바이너리(node_modules/.bin/tsc) 직접 호출 — 가장 안정적
 * - 우선순위 2: 감지된 패키지 매니저로 실행 (yarn tsc / pnpm exec tsc / bunx tsc / npx tsc)
 * - 큰 프로젝트도 여유롭게 (180s)
 */
function runTsc(projectRoot) {
  const tscArgs = ['--noEmit', '--pretty', 'false', '--project', TSCONFIG_FILE_NAME];
  const baseOptions = {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
    timeout: 180_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  };

  const local = resolveLocalTscBinary(projectRoot);
  if (local) {
    return spawnSync(local, tscArgs, baseOptions);
  }

  const { cmd, prefix } = buildPackageManagerTscCommand(projectRoot);
  return spawnSync(cmd, [...prefix, ...tscArgs], baseOptions);
}

function isProjectErrorFile(file) {
  if (!file || typeof file !== 'string') return false;
  return !file.replace(/\\/g, '/').includes('/node_modules/');
}

function splitErrorsByOrigin(errors) {
  const project = [];
  const external = [];
  for (const e of Array.isArray(errors) ? errors : []) {
    if (isProjectErrorFile(e.file)) project.push(e);
    else external.push(e);
  }
  return { project, external };
}

function countConfigSuspectErrors(errors) {
  let n = 0;
  for (const e of Array.isArray(errors) ? errors : []) {
    if (TS_CONFIG_SUSPECT_CODES.has(e.code)) n++;
  }
  return n;
}

function detectTsConfigHints(projectRoot) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(projectRoot, TSCONFIG_FILE_NAME), 'utf8');
  } catch {
    return [];
  }
  const hints = [];
  if (!/"jsx"\s*:\s*"(preserve|react-jsx|react-jsxdev)"/.test(text)) {
    hints.push('compilerOptions.jsx 누락/부정확');
  }
  if (!/"esModuleInterop"\s*:\s*true/.test(text)) {
    hints.push('compilerOptions.esModuleInterop=true 권장');
  }
  if (!/"skipLibCheck"\s*:\s*true/.test(text)) {
    hints.push('compilerOptions.skipLibCheck=true 권장');
  }
  if (!/"lib"\s*:\s*\[[^\]]*"(dom|dom\.iterable)"/is.test(text)) {
    hints.push('compilerOptions.lib 에 dom/dom.iterable 포함 권장');
  }
  return hints;
}

function classifyError(error) {
  for (const rule of ERROR_LABEL_RULES) {
    try {
      if (rule.when(error)) {
        return {
          label: rule.id,
          lever: rule.lever,
          autoFixable: rule.autoFixable,
        };
      }
    } catch {
      // ignore faulty rules
    }
  }
  return {
    label: 'unknown',
    lever: 'manual_triage',
    autoFixable: false,
  };
}

function buildLabelSummary(errors) {
  const byLabel = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    const c = classifyError(e);
    const key = c.label;
    if (!byLabel.has(key)) {
      byLabel.set(key, {
        label: c.label,
        lever: c.lever,
        autoFixable: c.autoFixable,
        count: 0,
        sample: e,
      });
    }
    byLabel.get(key).count += 1;
  }
  const rows = [...byLabel.values()];
  rows.sort((a, b) => b.count - a.count);
  return rows;
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
    return { ok: false, reason: 'spawn_error', message: e?.message, stderr: '' };
  }
  if (result.error) {
    return {
      ok: false,
      reason: 'tsc_unavailable',
      message: result.error.message,
      stderr: result.stderr || '',
    };
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
 * 콘솔 진단용 — 어떤 경로로 tsc 를 호출하는지 사람이 읽기 좋은 요약 문자열로 반환.
 * @param {string} projectRoot
 */
function describeTscInvocation(projectRoot) {
  const local = resolveLocalTscBinary(projectRoot);
  if (local) {
    return `local binary (${path.relative(projectRoot, local) || local})`;
  }
  const { cmd, prefix } = buildPackageManagerTscCommand(projectRoot);
  return `${cmd} ${prefix.join(' ')}`;
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

  /** @type {{ ran: boolean, reason?: string, scannedFiles: number, missing: Array<{ file: string, line: number, spec: string }> }} */
  let staticImportScan = { ran: false, scannedFiles: 0, missing: [] };

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
            `   typecheck 직전 src/ 결정론 sweep: ${r.removedTargets.length}건 정리 (${r.changedFiles.length}개 파일)`,
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
    // 진단: 어떤 명령으로 시도했는지·이유 요약을 노출해 사용자가
    // 환경(yarn berry/PnP 등) 문제를 바로 파악할 수 있게 한다.
    const hint = describeTscInvocation(projectRoot);
    if (hint) {
      console.log(chalk.gray(`      ↳ 실행 방식: ${hint}`));
    }
    if (first.stderr) {
      const head = String(first.stderr).split(/\r?\n/).filter(Boolean).slice(0, 3);
      for (const line of head) {
        console.log(chalk.gray(`      ↳ stderr: ${line}`));
      }
    }
    return { ran: false, reason: first.reason };
  }

  if (first.exitCode === 0 && first.errors.length === 0) {
    console.log(chalk.green('   ✅ 타입 검사 통과: 별다른 unused/type 에러가 없습니다.'));
    try {
      staticImportScan = await runStaticImportScan(projectRoot);
      if (staticImportScan.ran && staticImportScan.missing.length > 0) {
        const rp = await writeStaticImportReport(projectRoot, staticImportScan);
        console.log(
          chalk.yellow(
            `   ⚠️  정적 import/에셋: 디스크에 없는 경로 ${staticImportScan.missing.length}건 (빌드 시 Module not found 가능)`,
          ),
        );
        if (rp) console.log(chalk.cyan(`      📄 ${rp}`));
        console.log(
          chalk.gray(
            '      declare module 와일드카드로 tsc 는 통과해도 번들러는 실패할 수 있습니다.',
          ),
        );
      }
    } catch (e) {
      console.log(
        chalk.gray(`   ⚠️  정적 import 스캔(무시): ${e?.message || e}`),
      );
    }
    return {
      ran: true,
      exitCode: 0,
      errors: [],
      autofixed: 0,
      aiFixed: 0,
      staticImportScan,
    };
  }

  const firstSplit = splitErrorsByOrigin(first.errors);
  if (firstSplit.external.length > 0) {
    console.log(
      chalk.gray(
        `   ℹ️  외부 라이브러리(node_modules) 에러 ${firstSplit.external.length}건은 자동 수정 대상에서 제외`,
      ),
    );
  }
  const suspectCount = countConfigSuspectErrors(first.errors);
  const suspectRatio = first.errors.length > 0 ? suspectCount / first.errors.length : 0;
  const tsconfigHints = detectTsConfigHints(projectRoot);
  if (suspectRatio >= 0.6 && tsconfigHints.length > 0) {
    console.log(
      chalk.yellow(
        `   ⚠️  tsconfig 설정 의심: 에러의 ${Math.round(suspectRatio * 100)}%가 JSX/interop/lib 계열`,
      ),
    );
    for (const hint of tsconfigHints) {
      console.log(chalk.yellow(`      - ${hint}`));
    }
  }

  console.log(
    chalk.gray(
      `   1차 검사: ${first.errors.length}개 에러 — 자동 수정 시도 시작`,
    ),
  );

  // ── 2) 결정론적 autofix ──────────────────────────────────────────────
  let autofixSummary = { totalFixed: 0, fixedFiles: [] };
  if (autofix) {
    try {
      autofixSummary = await autofixErrors(projectRoot, firstSplit.project);
      if (autofixSummary.totalFixed > 0) {
        console.log(
          chalk.cyan(
            `   패턴 기반 자동 수정: ${autofixSummary.totalFixed}건 (${autofixSummary.fixedFiles.length}개 파일)`,
          ),
        );
      } else {
        console.log(chalk.gray('   패턴 기반 자동 수정 대상 없음'));
      }
    } catch (e) {
      console.log(
        chalk.gray(`   ⚠️ 패턴 기반 자동 수정 중 오류(무시): ${e?.message || e}`),
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
          `   2차 검사: ${secondErrors.length}개 잔여 (패턴 기반 자동 수정으로 ${delta >= 0 ? delta : 0}건 해소)`,
        ),
      );
    }
  }

  try {
    staticImportScan = await runStaticImportScan(projectRoot);
    if (staticImportScan.ran && staticImportScan.missing.length > 0) {
      const rp = await writeStaticImportReport(projectRoot, staticImportScan);
      console.log(
        chalk.yellow(
          `   ⚠️  정적 import/에셋: 디스크에 없는 경로 ${staticImportScan.missing.length}건 (빌드 시 Module not found 가능)`,
        ),
      );
      if (rp) console.log(chalk.cyan(`      📄 ${rp}`));
      console.log(
        chalk.gray(
          '      declare module 와일드카드로 tsc 는 통과해도 번들러는 실패할 수 있습니다.',
        ),
      );
    }
  } catch (e) {
    console.log(
      chalk.gray(`   ⚠️  정적 import 스캔(무시): ${e?.message || e}`),
    );
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

  const secondSplit = splitErrorsByOrigin(secondErrors);
  if (aiFix && secondSplit.project.length > 0) {
    if (!process.env.GEMINI_API_KEY) {
      console.log(
        chalk.gray(
          '   ℹ️  GEMINI_API_KEY 없음 — AI 보정 단계는 건너뜁니다.',
        ),
      );
    } else {
      console.log(
        chalk.cyan(
          `   🤖 AI 보정 시도: 프로젝트 잔여 ${secondSplit.project.length}건을 파일당 1회씩, 최대 ${aiFixBudget}개 파일 의뢰`,
        ),
      );
      try {
        aiSummary = await aiFixRemainingErrors(projectRoot, secondSplit.project, {
          budget: aiFixBudget,
        });
      } catch (e) {
        console.log(
          chalk.gray(`   ⚠️ Gemini 수정 중 오류(무시): ${e?.message || e}`),
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
                `   ⚠️ Gemini 수정이 오히려 에러를 늘려 ${rolledBack.length}건 되돌림`,
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
                `   Gemini 수정 결과: ${aiSummary.filesChanged.length}개 파일 변경, ${aiDelta >= 0 ? aiDelta : 0}건 해소`,
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
      summary.push(`      • 패턴 기반 자동 수정: ${autofixSummary.totalFixed}건`);
    }
    if (aiSummary.filesChanged.length > 0) {
      summary.push(`      • Gemini 수정: ${aiSummary.filesChanged.length}개 파일`);
    }
    if (aiSummary.rolledBack.length > 0) {
      summary.push(`      • 회귀 롤백: ${aiSummary.rolledBack.length}개 파일`);
    }
    console.log(chalk.green(summary.join('\n')));
    if (staticImportScan.ran && staticImportScan.missing.length > 0) {
      console.log(
        chalk.yellow(
          `   ⚠️  정적 import/에셋 미해결 ${staticImportScan.missing.length}건 — ${path.join(projectRoot, 'nextify-static-import-report.txt')}`,
        ),
      );
    }
    return {
      ran: true,
      exitCode: 0,
      errors: [],
      autofixed: autofixSummary.totalFixed,
      aiFixed: aiSummary.filesChanged.length,
      rolledBack: aiSummary.rolledBack.length,
      elapsedMs,
      staticImportScan,
    };
  }

  // 잔여 에러 리포트 파일 저장
  const finalSplit = splitErrorsByOrigin(finalErrors);
  const labelSummary = buildLabelSummary(finalSplit.project);
  const reportPath = path.join(projectRoot, REPORT_FILE_NAME);
  const header = [
    '# Nextify TypeScript Typecheck Report',
    `# generated at: ${new Date().toISOString()}`,
    `# project: ${projectRoot}`,
    `# exit code: ${finalExit}`,
    `# elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
    `# autofix(deterministic): ${autofixSummary.totalFixed} fixes / ${autofixSummary.fixedFiles.length} files`,
    `# ai-fix: ${aiSummary.filesChanged.length} files changed, ${aiSummary.rolledBack.length} rolled back`,
    `# errors(project): ${finalSplit.project.length}`,
    `# errors(external/node_modules): ${finalSplit.external.length}`,
    `# labels(project): ${labelSummary.length}`,
    `# static import / asset unresolved: ${staticImportScan.missing.length} (see nextify-static-import-report.txt)`,
    '#',
    '# 이 리포트는 결정론적 + AI 자동 수정 후에도 남은 에러만 표시합니다.',
    '# 위치를 직접 확인하려면 프로젝트 루트에서 `npx tsc --noEmit` 을 다시 실행하세요.',
    '# 아래 [Label Summary]는 우선순위와 자동화 가능성을 빠르게 판단하기 위한 분류입니다.',
    '',
    '# [Label Summary]',
    ...labelSummary.slice(0, 12).map(
      (x) =>
        `# - ${x.label} | lever=${x.lever} | autoFixable=${x.autoFixable ? 'yes' : 'no'} | count=${x.count} | sample=${x.sample.file}:${x.sample.line}:${x.sample.column}`,
    ),
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
  if (labelSummary.length > 0) {
    console.log(chalk.gray('      [라벨/레버 매칭 상위]'));
    for (const x of labelSummary.slice(0, 5)) {
      console.log(
        chalk.gray(
          `      - ${x.label} → ${x.lever} (${x.count}건, auto=${x.autoFixable ? 'yes' : 'no'})`,
        ),
      );
    }
  }
  const stageLine = [];
  if (autofixSummary.totalFixed > 0) {
    stageLine.push(`패턴 기반 자동 수정 ${autofixSummary.totalFixed}건 해소`);
  }
  if (aiSummary.filesChanged.length > 0) {
    stageLine.push(`Gemini 수정 ${aiSummary.filesChanged.length}개 파일`);
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
  if (staticImportScan.ran && staticImportScan.missing.length > 0) {
    console.log(
      chalk.yellow(
        `      ⚠️  정적 import/에셋 미해결 ${staticImportScan.missing.length}건 — ${path.join(projectRoot, 'nextify-static-import-report.txt')}`,
      ),
    );
  }
  console.log('');

  return {
    ran: true,
    exitCode: finalExit,
    errors: finalErrors,
    autofixed: autofixSummary.totalFixed,
    aiFixed: aiSummary.filesChanged.length,
    rolledBack: aiSummary.rolledBack.length,
    labelSummary,
    reportPath,
    elapsedMs,
    staticImportScan,
  };
}

module.exports = {
  runFinalTypecheckReport,
};
=======
'use strict';

// app/src/validation/typecheck-report.cjs
// 마이그레이션 단계 이후 프로젝트에서 `tsc --noEmit` 을 실행해
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
const {
  runStaticImportScan,
  writeStaticImportReport,
} = require('./static-import-scan.cjs');
const { sweepAfterAiApply } = require('../utils/post-ai-sweep.cjs');
const { stripImportExtensions } = require('../utils/strip-import-extensions.cjs');

const REPORT_FILE_NAME = 'nextify-typecheck-report.txt';
const TSCONFIG_FILE_NAME = 'tsconfig.json';
const TS_CONFIG_SUSPECT_CODES = new Set(['TS17004', 'TS6142', 'TS1259']);

// 사용자가 곧장 빌드 실패로 만나는 핵심 코드들
const KEY_TS_ERROR_CODES = new Set([
  'TS6133', // 'X' is declared but its value is never read.
  'TS6138', // Property 'X' is declared but its value is never read.
  'TS6196', // 'X' is declared but never used.
  'TS6192', // All imports in import declaration are unused.
  'TS2304', // Cannot find name 'X'.
  'TS2307', // Cannot find module 'X'.
  'TS2552', // Cannot find name 'X'. Did you mean 'Y'?
]);

const ERROR_LABEL_RULES = [
  {
    id: 'tsconfig-jsx-interop',
    when: (e) =>
      e.code === 'TS17004' ||
      e.code === 'TS6142' ||
      (e.code === 'TS1259' && /esModuleInterop/i.test(e.message || '')),
    lever: 'tsconfig_normalization',
    autoFixable: false,
  },
  {
    id: 'jsx-null-render',
    when: (e) =>
      e.code === 'TS2339' &&
      /Property 'null' does not exist on type 'JSX\.IntrinsicElements'/i.test(e.message || ''),
    lever: 'null_return_rewrite',
    autoFixable: true,
  },
  {
    id: 'router-hook-migration',
    when: (e) =>
      (e.code === 'TS2304' || e.code === 'TS2552') &&
      /Cannot find name ['"`](useLocation|useNavigate|useHistory)['"`]/i.test(e.message || ''),
    lever: 'router_hook_replacement',
    autoFixable: false,
  },
  {
    id: 'module-resolution',
    when: (e) =>
      e.code === 'TS2307' ||
      /Cannot find module/i.test(e.message || '') ||
      /Cannot find type definition file/i.test(e.message || ''),
    lever: 'alias_and_types_resolution',
    autoFixable: true,
  },
  {
    id: 'route-object-navigation',
    when: (e) =>
      e.code === 'TS2345' &&
      /Argument of type '\{ pathname: string; query:/i.test(e.message || '') &&
      /is not assignable to parameter of type 'string'/i.test(e.message || ''),
    lever: 'next_router_push_rewrite',
    autoFixable: false,
  },
  {
    id: 'style-namespace-missing',
    when: (e) =>
      (e.code === 'TS2304' || e.code === 'TS2552') &&
      /Cannot find name ['"`](R|styled)['"`]/i.test(e.message || ''),
    lever: 'style_symbol_restore',
    autoFixable: false,
  },
  {
    id: 'missing-identifier',
    when: (e) =>
      e.code === 'TS2304' || e.code === 'TS2552' || /Cannot find name/i.test(e.message || ''),
    lever: 'import_injection_or_symbol_fix',
    autoFixable: true,
  },
  {
    id: 'unused-declaration',
    when: (e) =>
      e.code === 'TS6133' ||
      e.code === 'TS6138' ||
      e.code === 'TS6192' ||
      e.code === 'TS6196',
    lever: 'unused_cleanup',
    autoFixable: true,
  },
  {
    id: 'router-migration',
    when: (e) =>
      /NavigateOptions/i.test(e.message || '') ||
      /state' does not exist in type 'NavigateOptions'/i.test(e.message || ''),
    lever: 'router_state_rewrite',
    autoFixable: false,
  },
  {
    id: 'jsx-component-type',
    when: (e) =>
      e.code === 'TS2786' ||
      e.code === 'TS2607' ||
      /cannot be used as a JSX component/i.test(e.message || ''),
    lever: 'react_next_type_alignment',
    autoFixable: false,
  },
];

function hasTsConfig(projectRoot) {
  return fs.existsSync(path.join(projectRoot, TSCONFIG_FILE_NAME));
}

/**
 * 프로젝트 안의 tsc 바이너리(있으면 가장 안정적)를 찾는다.
 * yarn / pnpm / npm 어떤 매니저로 설치됐든 typescript 가 devDependency 면
 * `node_modules/.bin/tsc(.cmd)` 가 존재한다.
 */
function resolveLocalTscBinary(projectRoot) {
  const isWin = process.platform === 'win32';
  const binNames = isWin ? ['tsc.cmd', 'tsc.CMD'] : ['tsc'];
  for (const name of binNames) {
    const p = path.join(projectRoot, 'node_modules', '.bin', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 패키지 매니저별로 tsc 를 실행할 명령을 만든다.
 * - npm  : npx -y tsc ...
 * - yarn : yarn tsc ... (1.x / 2+ 모두 동일)
 * - pnpm : pnpm exec tsc ...
 * - bun  : bunx tsc ...
 */
function buildPackageManagerTscCommand(projectRoot) {
  const isWin = process.platform === 'win32';
  const ext = (b) => (isWin ? `${b}.cmd` : b);

  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
    return { cmd: ext('yarn'), prefix: ['tsc'] };
  }
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return { cmd: ext('pnpm'), prefix: ['exec', 'tsc'] };
  }
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
    return { cmd: ext('bunx'), prefix: ['tsc'] };
  }
  // npm 또는 lockfile 없음
  return { cmd: ext('npx'), prefix: ['-y', 'tsc'] };
}

function getBuildCommand(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn build';
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm build';
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun run build';
  return 'npm run build';
}

/**
 * tsc 실행. 표준 출력을 캡처하고 종료 코드를 반환.
 * - 우선순위 1: 프로젝트 로컬 tsc 바이너리(node_modules/.bin/tsc) 직접 호출 — 가장 안정적
 * - 우선순위 2: 감지된 패키지 매니저로 실행 (yarn tsc / pnpm exec tsc / bunx tsc / npx tsc)
 * - 큰 프로젝트도 여유롭게 (180s)
 */
function runTsc(projectRoot) {
  const tscArgs = ['--noEmit', '--pretty', 'false', '--project', TSCONFIG_FILE_NAME];
  const baseOptions = {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
    timeout: 180_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  };

  const local = resolveLocalTscBinary(projectRoot);
  if (local) {
    return spawnSync(local, tscArgs, baseOptions);
  }

  const { cmd, prefix } = buildPackageManagerTscCommand(projectRoot);
  return spawnSync(cmd, [...prefix, ...tscArgs], baseOptions);
}

function isProjectErrorFile(file) {
  if (!file || typeof file !== 'string') return false;
  return !file.replace(/\\/g, '/').includes('/node_modules/');
}

function splitErrorsByOrigin(errors) {
  const project = [];
  const external = [];
  for (const e of Array.isArray(errors) ? errors : []) {
    if (isProjectErrorFile(e.file)) project.push(e);
    else external.push(e);
  }
  return { project, external };
}

function countConfigSuspectErrors(errors) {
  let n = 0;
  for (const e of Array.isArray(errors) ? errors : []) {
    if (TS_CONFIG_SUSPECT_CODES.has(e.code)) n++;
  }
  return n;
}

function detectTsConfigHints(projectRoot) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(projectRoot, TSCONFIG_FILE_NAME), 'utf8');
  } catch {
    return [];
  }
  const hints = [];
  if (!/"jsx"\s*:\s*"(preserve|react-jsx|react-jsxdev)"/.test(text)) {
    hints.push('compilerOptions.jsx 누락/부정확');
  }
  if (!/"esModuleInterop"\s*:\s*true/.test(text)) {
    hints.push('compilerOptions.esModuleInterop=true 권장');
  }
  if (!/"skipLibCheck"\s*:\s*true/.test(text)) {
    hints.push('compilerOptions.skipLibCheck=true 권장');
  }
  if (!/"lib"\s*:\s*\[[^\]]*"(dom|dom\.iterable)"/is.test(text)) {
    hints.push('compilerOptions.lib 에 dom/dom.iterable 포함 권장');
  }
  return hints;
}

function classifyError(error) {
  for (const rule of ERROR_LABEL_RULES) {
    try {
      if (rule.when(error)) {
        return {
          label: rule.id,
          lever: rule.lever,
          autoFixable: rule.autoFixable,
        };
      }
    } catch {
      // ignore faulty rules
    }
  }
  return {
    label: 'unknown',
    lever: 'manual_triage',
    autoFixable: false,
  };
}

function buildLabelSummary(errors) {
  const byLabel = new Map();
  for (const e of Array.isArray(errors) ? errors : []) {
    const c = classifyError(e);
    const key = c.label;
    if (!byLabel.has(key)) {
      byLabel.set(key, {
        label: c.label,
        lever: c.lever,
        autoFixable: c.autoFixable,
        count: 0,
        sample: e,
      });
    }
    byLabel.get(key).count += 1;
  }
  const rows = [...byLabel.values()];
  rows.sort((a, b) => b.count - a.count);
  return rows;
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
    return { ok: false, reason: 'spawn_error', message: e?.message, stderr: '' };
  }
  if (result.error) {
    return {
      ok: false,
      reason: 'tsc_unavailable',
      message: result.error.message,
      stderr: result.stderr || '',
    };
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
 * 콘솔 진단용 — 어떤 경로로 tsc 를 호출하는지 사람이 읽기 좋은 요약 문자열로 반환.
 * @param {string} projectRoot
 */
function describeTscInvocation(projectRoot) {
  const local = resolveLocalTscBinary(projectRoot);
  if (local) {
    return `local binary (${path.relative(projectRoot, local) || local})`;
  }
  const { cmd, prefix } = buildPackageManagerTscCommand(projectRoot);
  return `${cmd} ${prefix.join(' ')}`;
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

  /** @type {{ ran: boolean, reason?: string, scannedFiles: number, missing: Array<{ file: string, line: number, spec: string }> }} */
  let staticImportScan = { ran: false, scannedFiles: 0, missing: [] };

  if (!hasTsConfig(projectRoot)) {
    return { ran: false, reason: 'no_tsconfig' };
  }

  // ── 0) TypeScript 검증 전 import 경로 보정 ───────────────────────────
  // Vite 코드에 남은 './File.tsx' 형태는 Next.js/tsc에서 TS5097/TS2867을 만들 수 있습니다.
  try {
    const stripResult = await stripImportExtensions(projectRoot);
    if (stripResult.totalReplacements > 0) {
      console.log(
        chalk.gray(
          `   TypeScript 검증 전 import 경로를 정리했습니다. (${stripResult.totalReplacements}건, ${stripResult.changedFiles.length}개 파일)`,
        ),
      );
    }
  } catch (e) {
    console.log(
      chalk.gray(`   ⚠️  TypeScript 검증 전 import 경로 정리 중 오류가 발생했습니다. 마이그레이션은 계속 진행합니다: ${e?.message || e}`),
    );
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
          chalk.gray(
            `   타입 검사 전, 마이그레이션 과정에서 남은 불필요한 임시 코드를 정리했습니다. (${r.removedTargets.length}건, ${r.changedFiles.length}개 파일)`,
          ),
        );
      }
    }
  } catch (e) {
    console.log(
      chalk.gray(`   ⚠️  타입 검사 전 임시 코드 정리 중 오류가 발생했습니다. 마이그레이션은 계속 진행합니다: ${e?.message || e}`),
    );
  }

  // ── 1차 tsc ──────────────────────────────────────────────────────────
  console.log(chalk.gray('   TypeScript 타입 검사 중...'));
  const t0 = Date.now();
  const first = runTscAndParse(projectRoot);
  if (!first.ok) {
    console.log(chalk.yellow('   TypeScript 검증을 실행하지 못했습니다.'));
    console.log(chalk.gray('   마이그레이션 결과는 유지됩니다.'));
    console.log(chalk.gray(`   의존성 설치 후 \`${getBuildCommand(projectRoot)}\`로 직접 확인하세요.`));
    return { ran: false, reason: first.reason };
  }

  if (first.exitCode === 0 && first.errors.length === 0) {
    console.log(chalk.green('   TypeScript 검증 완료: 문제 없음'));
    try {
      staticImportScan = await runStaticImportScan(projectRoot);
      if (staticImportScan.ran && staticImportScan.missing.length > 0) {
        const rp = await writeStaticImportReport(projectRoot, staticImportScan);
        console.log(
          chalk.yellow(
            `   ⚠️  정적 import/에셋: 디스크에 없는 경로 ${staticImportScan.missing.length}건 (빌드 시 Module not found 가능)`,
          ),
        );
        if (rp) console.log(chalk.cyan(`      📄 ${rp}`));
        console.log(
          chalk.gray(
            '      declare module 와일드카드로 tsc 는 통과해도 번들러는 실패할 수 있습니다.',
          ),
        );
      }
    } catch (e) {
      console.log(
        chalk.gray(`   ⚠️  정적 import 스캔(무시): ${e?.message || e}`),
      );
    }
    return {
      ran: true,
      exitCode: 0,
      errors: [],
      autofixed: 0,
      aiFixed: 0,
      staticImportScan,
    };
  }

  const firstSplit = splitErrorsByOrigin(first.errors);
  if (firstSplit.external.length > 0) {
    console.log(
      chalk.gray(
        `   ℹ️  외부 라이브러리(node_modules) 에러 ${firstSplit.external.length}건은 자동 수정 대상에서 제외`,
      ),
    );
  }
  const suspectCount = countConfigSuspectErrors(first.errors);
  const suspectRatio = first.errors.length > 0 ? suspectCount / first.errors.length : 0;
  const tsconfigHints = detectTsConfigHints(projectRoot);
  if (suspectRatio >= 0.6 && tsconfigHints.length > 0) {
    console.log(
      chalk.yellow(
        `   ⚠️  tsconfig 설정 의심: 에러의 ${Math.round(suspectRatio * 100)}%가 JSX/interop/lib 계열`,
      ),
    );
    for (const hint of tsconfigHints) {
      console.log(chalk.yellow(`      - ${hint}`));
    }
  }

  console.log(
    chalk.gray(
      `   1차 검사: ${first.errors.length}개 에러 — 자동 수정 시도 시작`,
    ),
  );

  // ── 2) 결정론적 autofix ──────────────────────────────────────────────
  let autofixSummary = { totalFixed: 0, fixedFiles: [] };
  if (autofix) {
    try {
      autofixSummary = await autofixErrors(projectRoot, firstSplit.project);
      if (autofixSummary.totalFixed > 0) {
        console.log(
          chalk.white(
            `   패턴 기반 자동 수정: ${autofixSummary.totalFixed}건 (${autofixSummary.fixedFiles.length}개 파일)`,
          ),
        );
      } else {
        console.log(chalk.gray('   패턴 기반 자동 수정 대상 없음'));
      }
    } catch (e) {
      console.log(
        chalk.gray(`   ⚠️ 패턴 기반 자동 수정 중 오류(무시): ${e?.message || e}`),
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
          `   2차 검사: ${secondErrors.length}개 잔여 (패턴 기반 자동 수정으로 ${delta >= 0 ? delta : 0}건 해소)`,
        ),
      );
    }
  }

  try {
    staticImportScan = await runStaticImportScan(projectRoot);
    if (staticImportScan.ran && staticImportScan.missing.length > 0) {
      const rp = await writeStaticImportReport(projectRoot, staticImportScan);
      console.log(
        chalk.yellow(
          `   ⚠️  정적 import/에셋: 디스크에 없는 경로 ${staticImportScan.missing.length}건 (빌드 시 Module not found 가능)`,
        ),
      );
      if (rp) console.log(chalk.cyan(`      📄 ${rp}`));
      console.log(
        chalk.gray(
          '      declare module 와일드카드로 tsc 는 통과해도 번들러는 실패할 수 있습니다.',
        ),
      );
    }
  } catch (e) {
    console.log(
      chalk.gray(`   ⚠️  정적 import 스캔(무시): ${e?.message || e}`),
    );
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

  const secondSplit = splitErrorsByOrigin(secondErrors);
  if (aiFix && secondSplit.project.length > 0) {
    if (!process.env.GEMINI_API_KEY) {
      console.log(
        chalk.gray(
          '   ℹ️  GEMINI_API_KEY 없음 — AI 보정 단계는 건너뜁니다.',
        ),
      );
    } else {
      console.log(
        chalk.white(
          `   🤖 AI 보정 시도: 프로젝트 잔여 ${secondSplit.project.length}건을 파일당 1회씩, 최대 ${aiFixBudget}개 파일 의뢰`,
        ),
      );
      try {
        aiSummary = await aiFixRemainingErrors(projectRoot, secondSplit.project, {
          budget: aiFixBudget,
        });
      } catch (e) {
        console.log(
          chalk.gray(`   ⚠️ Gemini 수정 중 오류(무시): ${e?.message || e}`),
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
                `   ⚠️ Gemini 수정이 오히려 에러를 늘려 ${rolledBack.length}건 되돌림`,
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
              chalk.white(
                `   Gemini 수정 결과: ${aiSummary.filesChanged.length}개 파일 변경, ${aiDelta >= 0 ? aiDelta : 0}건 해소`,
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
      `   TypeScript 검증 완료: 문제 없음 (총 ${(elapsedMs / 1000).toFixed(1)}s)`,
    ];
    if (autofixSummary.totalFixed > 0) {
      summary.push(`      • 자동 수정으로 일부 타입 오류를 정리했습니다. (${autofixSummary.totalFixed}건)`);
    }
    if (aiSummary.filesChanged.length > 0) {
      summary.push(`      • Gemini 수정: ${aiSummary.filesChanged.length}개 파일`);
    }
    if (aiSummary.rolledBack.length > 0) {
      summary.push(`      • 회귀 롤백: ${aiSummary.rolledBack.length}개 파일`);
    }
    console.log(chalk.green(summary.join('\n')));
    if (staticImportScan.ran && staticImportScan.missing.length > 0) {
      console.log(
        chalk.yellow(
          `   ⚠️  정적 import/에셋 미해결 ${staticImportScan.missing.length}건 — ${path.join(projectRoot, 'nextify-static-import-report.txt')}`,
        ),
      );
    }
    return {
      ran: true,
      exitCode: 0,
      errors: [],
      autofixed: autofixSummary.totalFixed,
      aiFixed: aiSummary.filesChanged.length,
      rolledBack: aiSummary.rolledBack.length,
      elapsedMs,
      staticImportScan,
    };
  }

  // 잔여 에러 리포트 파일 저장
  const finalSplit = splitErrorsByOrigin(finalErrors);
  const labelSummary = buildLabelSummary(finalSplit.project);
  const reportPath = path.join(projectRoot, REPORT_FILE_NAME);
  const header = [
    '# Nextify TypeScript Typecheck Report',
    `# generated at: ${new Date().toISOString()}`,
    `# project: ${projectRoot}`,
    `# exit code: ${finalExit}`,
    `# elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
    `# autofix(deterministic): ${autofixSummary.totalFixed} fixes / ${autofixSummary.fixedFiles.length} files`,
    `# ai-fix: ${aiSummary.filesChanged.length} files changed, ${aiSummary.rolledBack.length} rolled back`,
    `# errors(project): ${finalSplit.project.length}`,
    `# errors(external/node_modules): ${finalSplit.external.length}`,
    `# labels(project): ${labelSummary.length}`,
    `# static import / asset unresolved: ${staticImportScan.missing.length} (see nextify-static-import-report.txt)`,
    '#',
    '# 이 리포트는 결정론적 + AI 자동 수정 후에도 남은 에러만 표시합니다.',
    '# 위치를 직접 확인하려면 프로젝트 루트에서 `npx tsc --noEmit` 을 다시 실행하세요.',
    '# 아래 [Label Summary]는 우선순위와 자동화 가능성을 빠르게 판단하기 위한 분류입니다.',
    '',
    '# [Label Summary]',
    ...labelSummary.slice(0, 12).map(
      (x) =>
        `# - ${x.label} | lever=${x.lever} | autoFixable=${x.autoFixable ? 'yes' : 'no'} | count=${x.count} | sample=${x.sample.file}:${x.sample.line}:${x.sample.column}`,
    ),
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
      '   TypeScript 검증 완료: 추가 확인 필요',
    ),
  );
  console.log(chalk.gray(`      남은 항목: ${total}건`));
  if (labelSummary.length > 0) {
    console.log(chalk.gray('      [라벨/레버 매칭 상위]'));
    for (const x of labelSummary.slice(0, 5)) {
      console.log(
        chalk.gray(
          `      - ${x.label} → ${x.lever} (${x.count}건, auto=${x.autoFixable ? 'yes' : 'no'})`,
        ),
      );
    }
  }
  const stageLine = [];
  if (autofixSummary.totalFixed > 0) {
    stageLine.push(`패턴 기반 자동 수정 ${autofixSummary.totalFixed}건 해소`);
  }
  if (aiSummary.filesChanged.length > 0) {
    stageLine.push(`Gemini 수정 ${aiSummary.filesChanged.length}개 파일`);
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
  console.log(chalk.white(`      자세한 내용은 ${REPORT_FILE_NAME}에서 확인하세요.`));
  console.log(
    chalk.gray(
      `      🛠  수동 점검: 프로젝트 루트에서 \`npx tsc --noEmit\` 을 다시 실행해 위치를 확인하세요.`,
    ),
  );
  console.log(
    chalk.gray(
      `      ⏱  타입 검사+자동 수정 총 소요: ${(elapsedMs / 1000).toFixed(1)}s`,
    ),
  );
  if (staticImportScan.ran && staticImportScan.missing.length > 0) {
    console.log(
      chalk.yellow(
        `      ⚠️  정적 import/에셋 미해결 ${staticImportScan.missing.length}건 — ${path.join(projectRoot, 'nextify-static-import-report.txt')}`,
      ),
    );
  }
  console.log('');

  return {
    ran: true,
    exitCode: finalExit,
    errors: finalErrors,
    autofixed: autofixSummary.totalFixed,
    aiFixed: aiSummary.filesChanged.length,
    rolledBack: aiSummary.rolledBack.length,
    labelSummary,
    reportPath,
    elapsedMs,
    staticImportScan,
  };
}

module.exports = {
  runFinalTypecheckReport,
};
>>>>>>> 6c524aa49a0153b30ef6bcc09e3aae86d25705e1
