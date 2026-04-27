const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const chalk = require('chalk');
const os = require('os');

const { detectPackageManager } = require('../utils/project-info.cjs');
const { runCommand, startCommand } = require('../utils/exec.cjs');
const { cloneProject } = require('../utils/copy.cjs');

const DEFAULT_LIGHTHOUSE_RUNS = 5;
const DEFAULT_LIGHTHOUSE_WARMUP_RUNS = 1;

async function getFreePort(preferred = 4173) {
  function canListen(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  }

  for (let port = preferred; port < preferred + 200; port++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canListen(port);
    if (ok) return port;
  }
  throw new Error('사용 가능한 포트를 찾지 못했습니다.');
}

async function waitForHttpReady(url, timeoutMs = 120_000) {
  const start = Date.now();
  // Node 18+ has fetch; Node 16 might not. Use http module fallback.
  const http = require('http');
  const https = require('https');

  const u = new URL(url);
  const candidates = [];
  // Prefer localhost first (often what dev servers bind to)
  if (u.hostname !== 'localhost') {
    const u2 = new URL(url);
    u2.hostname = 'localhost';
    candidates.push(u2.toString());
  }
  candidates.push(url);
  // Also try 127.0.0.1 as fallback
  if (u.hostname !== '127.0.0.1') {
    const u3 = new URL(url);
    u3.hostname = '127.0.0.1';
    candidates.push(u3.toString());
  }

  while (Date.now() - start < timeoutMs) {
    try {
      for (const candidateUrl of candidates) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const client = candidateUrl.startsWith('https:') ? https : http;
          const req = client.get(candidateUrl, (res) => {
            res.resume();
            resolve();
          });
          req.on('error', reject);
          req.setTimeout(3000, () => {
            req.destroy(new Error('timeout'));
          });
        });
        return;
      }
      return;
    } catch (e) {
      // keep polling
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`서버 준비 대기 시간 초과: ${url}`);
}

async function directorySizeBytes(dirPath) {
  if (!(await fs.pathExists(dirPath))) return 0;

  const stat = await fs.stat(dirPath);
  if (stat.isFile()) return stat.size;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const p = path.join(dirPath, entry.name);
    // eslint-disable-next-line no-await-in-loop
    total += await directorySizeBytes(p);
  }
  return total;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function readPackageJson(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(pkgPath))) throw new Error(`package.json 없음: ${projectRoot}`);
  return fs.readJson(pkgPath);
}

function getPmRunCommand(pm) {
  if (pm === 'yarn') return { cmd: 'yarn', run: (script) => ['run', script] };
  if (pm === 'pnpm') return { cmd: 'pnpm', run: (script) => ['run', script] };
  if (pm === 'bun') return { cmd: 'bun', run: (script) => ['run', script] };
  return { cmd: 'npm', run: (script) => ['run', script] };
}

async function ensureDependenciesInstalled(projectRoot) {
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  if (await fs.pathExists(nodeModulesPath)) return;

  console.log(chalk.gray(`의존성 설치가 필요합니다: ${projectRoot}`));

  const pm = detectPackageManager(projectRoot);
  if (pm === 'yarn') {
    await runCommand('yarn', ['install'], { cwd: projectRoot });
    return;
  }
  if (pm === 'pnpm') {
    await runCommand('pnpm', ['install'], { cwd: projectRoot });
    return;
  }
  if (pm === 'bun') {
    await runCommand('bun', ['install'], { cwd: projectRoot });
    return;
  }
  await runCommand('npm', ['install'], { cwd: projectRoot });
}

async function runBuild(projectRoot, kind) {
  await ensureDependenciesInstalled(projectRoot);
  const pm = detectPackageManager(projectRoot);
  const { cmd, run } = getPmRunCommand(pm);

  if (kind === 'vite') {
    await runCommand(cmd, [...run('build')], { cwd: projectRoot });
    return;
  }
  await runCommand(cmd, [...run('build')], { cwd: projectRoot });
}

async function startServer(projectRoot, kind, port) {
  await ensureDependenciesInstalled(projectRoot);
  const pm = detectPackageManager(projectRoot);
  const { cmd, run } = getPmRunCommand(pm);

  const pkg = await readPackageJson(projectRoot);
  const scripts = pkg.scripts || {};

  if (kind === 'vite') {
    if (scripts.preview) {
      const args =
        pm === 'yarn'
          ? [...run('preview'), '--port', String(port), '--strictPort']
          : [...run('preview'), '--', '--port', String(port), '--strictPort'];
      return startCommand(cmd, args, { cwd: projectRoot, stdio: 'pipe' });
    }
    // fallback: try npx vite preview
    return startCommand('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  }

  // next
  if (scripts.start) {
    return startCommand(cmd, [...run('start'), '--', '-p', String(port)], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  }
  return startCommand('npx', ['next', 'start', '-p', String(port)], { cwd: projectRoot, stdio: 'pipe' });
}

async function runLighthouseOnce(url) {
  let lighthouseRunner;
  let chromeLauncher;
  try {
    // Lazy-load so step1~6 don't require these deps.
    const lighthouseModule = require('lighthouse');
    lighthouseRunner =
      (typeof lighthouseModule === 'function' && lighthouseModule) ||
      lighthouseModule?.default ||
      lighthouseModule?.lighthouse;
    chromeLauncher = require('chrome-launcher');
  } catch (e) {
    throw new Error(
      `성능 레포트 생성에 필요한 의존성이 없습니다. app 폴더에서 의존성을 설치하세요.\n` +
        `예: (app 디렉터리에서) npm install\n` +
        `원본 오류: ${e.message}`
    );
  }

  const baseTmp = path.join(os.tmpdir(), 'nextify-lighthouse');
  await fs.ensureDir(baseTmp);
  const userDataDir = await fs.mkdtemp(path.join(baseTmp, 'profile-'));

  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userDataDir}`,
    ],
  });
  try {
    if (typeof lighthouseRunner !== 'function') {
      throw new Error('lighthouse 모듈 로드 실패: 실행 함수를 찾지 못했습니다.');
    }

    const options = {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'seo'],
    };
    const runnerResult = await lighthouseRunner(url, options);
    const lhr = runnerResult.lhr;

    const fcpMs = lhr.audits['first-contentful-paint']?.numericValue ?? null;
    const lcpMs = lhr.audits['largest-contentful-paint']?.numericValue ?? null;
    const seoScore = lhr.categories?.seo?.score ?? null;
    const perfScore = lhr.categories?.performance?.score ?? null;

    return {
      fcpMs,
      lcpMs,
      seoScore: seoScore == null ? null : Math.round(seoScore * 100),
      perfScore: perfScore == null ? null : Math.round(perfScore * 100),
      fetchedAt: new Date().toISOString(),
      finalUrl: lhr.finalUrl,
    };
  } finally {
    try {
      await chrome.kill();
    } catch (e) {
      // Windows에서 임시 디렉토리 정리 시 EPERM가 간헐적으로 발생할 수 있어 무시합니다.
    }
    try {
      await fs.remove(userDataDir);
    } catch (e) {
      // ignore
    }
  }
}

function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function standardDeviation(values) {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function summarizeNumeric(values) {
  if (!values.length) {
    return {
      count: 0,
      median: null,
      mean: null,
      min: null,
      max: null,
      stddev: null,
    };
  }

  return {
    count: values.length,
    median: median(values),
    mean: mean(values),
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: standardDeviation(values),
  };
}

function aggregateLighthouseRuns(runs) {
  const fcpValues = runs.map((run) => run.fcpMs).filter((v) => v != null);
  const lcpValues = runs.map((run) => run.lcpMs).filter((v) => v != null);
  const seoValues = runs.map((run) => run.seoScore).filter((v) => v != null);
  const perfValues = runs.map((run) => run.perfScore).filter((v) => v != null);

  return {
    fcpMs: summarizeNumeric(fcpValues),
    lcpMs: summarizeNumeric(lcpValues),
    seoScore: summarizeNumeric(seoValues),
    perfScore: summarizeNumeric(perfValues),
  };
}

async function runLighthouseSeries(url, { runs = DEFAULT_LIGHTHOUSE_RUNS, warmupRuns = DEFAULT_LIGHTHOUSE_WARMUP_RUNS } = {}) {
  const warmups = Math.max(0, Number(warmupRuns) || 0);
  const measuredRuns = Math.max(1, Number(runs) || 1);
  const totalRuns = warmups + measuredRuns;
  const collectedRuns = [];
  let lastFinalUrl = url;

  for (let i = 0; i < totalRuns; i++) {
    const isWarmup = i < warmups;
    const runIndex = i + 1;
    console.log(
      chalk.gray(
        `[Lighthouse] ${isWarmup ? 'warmup' : 'measure'} ${runIndex}/${totalRuns} - ${url}`
      )
    );
    // eslint-disable-next-line no-await-in-loop
    const result = await runLighthouseOnce(url);
    lastFinalUrl = result.finalUrl || lastFinalUrl;

    if (!isWarmup) {
      collectedRuns.push({
        run: collectedRuns.length + 1,
        ...result,
      });
    }
  }

  return {
    runs: collectedRuns,
    summary: aggregateLighthouseRuns(collectedRuns),
    finalUrl: lastFinalUrl,
    measuredRuns,
    warmups,
  };
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  if (!child || !child.pid) return;
  if (child.exitCode != null) return;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

async function stopServerProcess(server) {
  if (!server || !server.pid) return;
  if (server.exitCode != null) return;

  try {
    if (process.platform === 'win32') {
      await runCommand('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      await waitForProcessExit(server, 2000);
      return;
    }

    server.kill('SIGTERM');
    await waitForProcessExit(server, 3000);
    if (server.exitCode == null) {
      server.kill('SIGKILL');
      await waitForProcessExit(server, 2000);
    }
  } catch (e) {
    // 이미 종료된 프로세스 등의 케이스는 무시
  }
}

async function measureTarget({ label, projectRoot, kind, lighthouseRuns, warmupRuns }) {
  console.log(chalk.gray(`\n[측정] ${label}`));
  await runBuild(projectRoot, kind);

  const port = await getFreePort(kind === 'vite' ? 4173 : 3000);
  const url = `http://localhost:${port}/`;
  const server = await startServer(projectRoot, kind, port);

  try {
    await waitForHttpReady(url);
    const lighthouseResult = await runLighthouseSeries(url, {
      runs: lighthouseRuns,
      warmupRuns,
    });

    const sizeDir =
      kind === 'vite'
        ? path.join(projectRoot, 'dist')
        : path.join(projectRoot, '.next', 'static');
    const bytes = await directorySizeBytes(sizeDir);

    return {
      label,
      kind,
      projectRoot,
      url,
      lighthouse: lighthouseResult,
      jsPayload: {
        directory: sizeDir,
        bytes,
        human: formatBytes(bytes),
      },
    };
  } finally {
    await stopServerProcess(server);
  }
}

function formatMsToSeconds(ms) {
  if (ms == null) return 'N/A';
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRangeSeconds(metricSummary) {
  if (!metricSummary || metricSummary.min == null || metricSummary.max == null) return 'N/A';
  return `${(metricSummary.min / 1000).toFixed(2)} ~ ${(metricSummary.max / 1000).toFixed(2)} s`;
}

function formatStddevSeconds(metricSummary) {
  if (!metricSummary || metricSummary.stddev == null) return 'N/A';
  return `${(metricSummary.stddev / 1000).toFixed(2)} s`;
}

function formatStddevScore(metricSummary) {
  if (!metricSummary || metricSummary.stddev == null) return 'N/A';
  return `${metricSummary.stddev.toFixed(2)}`;
}

function formatScore(value) {
  if (value == null) return 'N/A';
  return `${Math.round(value)}/100`;
}

function formatScoreRange(metricSummary) {
  if (!metricSummary || metricSummary.min == null || metricSummary.max == null) return 'N/A';
  return `${Math.round(metricSummary.min)} ~ ${Math.round(metricSummary.max)}`;
}

function pickSummaryRow(target) {
  const summary = target.lighthouse?.summary || {};
  return {
    label: target.label,
    fcp: formatMsToSeconds(summary.fcpMs?.median),
    fcpStability: formatStddevSeconds(summary.fcpMs),
    lcp: formatMsToSeconds(summary.lcpMs?.median),
    lcpStability: formatStddevSeconds(summary.lcpMs),
    seo: formatScore(summary.seoScore?.median),
    seoStability: formatStddevScore(summary.seoScore),
    js: target.jsPayload?.human ?? 'N/A',
  };
}

function renderRunBreakdown(runs, metricKey, formatter) {
  if (!runs || runs.length === 0) return 'N/A';
  return runs
    .map((run, i) => `${i + 1}:${formatter(run[metricKey])}`)
    .join(', ');
}

function renderMarkdownReport({ vite, nextPre7, nextPost7 }) {
  const rows = [vite, nextPre7, nextPost7].map((t) => pickSummaryRow(t));

  const now = new Date().toISOString();
  const measurementConfig = vite.lighthouse || {};
  const measuredRuns = measurementConfig.measuredRuns ?? DEFAULT_LIGHTHOUSE_RUNS;
  const warmupRuns = measurementConfig.warmups ?? DEFAULT_LIGHTHOUSE_WARMUP_RUNS;

  return `# Nextify Performance Report

생성 시각: ${now}

## 비교 대상

- Vite + React (원본)
- Next.js (1~6단계, 성능 최적화 미적용)
- Next.js (7단계 적용, 성능 최적화 적용)

## 측정 지표

- FCP (First Contentful Paint, median)
- LCP (Largest Contentful Paint, median)
- SEO Score (Lighthouse, median)
- FCP/LCP/SEO 표준편차(작을수록 안정적)
- Total JS payload size (폴더 용량)

## 측정 설정

- Lighthouse warmup runs: ${warmupRuns}
- Lighthouse measured runs: ${measuredRuns}
- Summary 기준: median (표준편차/범위 함께 표시)

## 결과 요약 (3-way 비교)

| Target | FCP (median) | FCP σ | LCP (median) | LCP σ | SEO (median) | SEO σ | Total JS payload size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${rows[0].label} | ${rows[0].fcp} | ${rows[0].fcpStability} | ${rows[0].lcp} | ${rows[0].lcpStability} | ${rows[0].seo} | ${rows[0].seoStability} | ${rows[0].js} |
| ${rows[1].label} | ${rows[1].fcp} | ${rows[1].fcpStability} | ${rows[1].lcp} | ${rows[1].lcpStability} | ${rows[1].seo} | ${rows[1].seoStability} | ${rows[1].js} |
| ${rows[2].label} | ${rows[2].fcp} | ${rows[2].fcpStability} | ${rows[2].lcp} | ${rows[2].lcpStability} | ${rows[2].seo} | ${rows[2].seoStability} | ${rows[2].js} |

## 측정 상세

### ${vite.label}

- Root: \`${vite.projectRoot}\`
- URL: \`${vite.url}\`
- Dist size dir: \`${vite.jsPayload.directory}\` (${vite.jsPayload.human})
- Lighthouse finalUrl: \`${vite.lighthouse.finalUrl}\`
- FCP median/mean/stddev: ${formatMsToSeconds(vite.lighthouse.summary.fcpMs.median)} / ${formatMsToSeconds(vite.lighthouse.summary.fcpMs.mean)} / ${formatStddevSeconds(vite.lighthouse.summary.fcpMs)} (range: ${formatRangeSeconds(vite.lighthouse.summary.fcpMs)})
- LCP median/mean/stddev: ${formatMsToSeconds(vite.lighthouse.summary.lcpMs.median)} / ${formatMsToSeconds(vite.lighthouse.summary.lcpMs.mean)} / ${formatStddevSeconds(vite.lighthouse.summary.lcpMs)} (range: ${formatRangeSeconds(vite.lighthouse.summary.lcpMs)})
- SEO median/mean/stddev: ${formatScore(vite.lighthouse.summary.seoScore.median)} / ${formatScore(vite.lighthouse.summary.seoScore.mean)} / ${formatStddevScore(vite.lighthouse.summary.seoScore)} (range: ${formatScoreRange(vite.lighthouse.summary.seoScore)})
- FCP run-by-run: ${renderRunBreakdown(vite.lighthouse.runs, 'fcpMs', (v) => formatMsToSeconds(v))}
- LCP run-by-run: ${renderRunBreakdown(vite.lighthouse.runs, 'lcpMs', (v) => formatMsToSeconds(v))}

### ${nextPre7.label}

- Root: \`${nextPre7.projectRoot}\`
- URL: \`${nextPre7.url}\`
- Static size dir: \`${nextPre7.jsPayload.directory}\` (${nextPre7.jsPayload.human})
- Lighthouse finalUrl: \`${nextPre7.lighthouse.finalUrl}\`
- FCP median/mean/stddev: ${formatMsToSeconds(nextPre7.lighthouse.summary.fcpMs.median)} / ${formatMsToSeconds(nextPre7.lighthouse.summary.fcpMs.mean)} / ${formatStddevSeconds(nextPre7.lighthouse.summary.fcpMs)} (range: ${formatRangeSeconds(nextPre7.lighthouse.summary.fcpMs)})
- LCP median/mean/stddev: ${formatMsToSeconds(nextPre7.lighthouse.summary.lcpMs.median)} / ${formatMsToSeconds(nextPre7.lighthouse.summary.lcpMs.mean)} / ${formatStddevSeconds(nextPre7.lighthouse.summary.lcpMs)} (range: ${formatRangeSeconds(nextPre7.lighthouse.summary.lcpMs)})
- SEO median/mean/stddev: ${formatScore(nextPre7.lighthouse.summary.seoScore.median)} / ${formatScore(nextPre7.lighthouse.summary.seoScore.mean)} / ${formatStddevScore(nextPre7.lighthouse.summary.seoScore)} (range: ${formatScoreRange(nextPre7.lighthouse.summary.seoScore)})
- FCP run-by-run: ${renderRunBreakdown(nextPre7.lighthouse.runs, 'fcpMs', (v) => formatMsToSeconds(v))}
- LCP run-by-run: ${renderRunBreakdown(nextPre7.lighthouse.runs, 'lcpMs', (v) => formatMsToSeconds(v))}

### ${nextPost7.label}

- Root: \`${nextPost7.projectRoot}\`
- URL: \`${nextPost7.url}\`
- Static size dir: \`${nextPost7.jsPayload.directory}\` (${nextPost7.jsPayload.human})
- Lighthouse finalUrl: \`${nextPost7.lighthouse.finalUrl}\`
- FCP median/mean/stddev: ${formatMsToSeconds(nextPost7.lighthouse.summary.fcpMs.median)} / ${formatMsToSeconds(nextPost7.lighthouse.summary.fcpMs.mean)} / ${formatStddevSeconds(nextPost7.lighthouse.summary.fcpMs)} (range: ${formatRangeSeconds(nextPost7.lighthouse.summary.fcpMs)})
- LCP median/mean/stddev: ${formatMsToSeconds(nextPost7.lighthouse.summary.lcpMs.median)} / ${formatMsToSeconds(nextPost7.lighthouse.summary.lcpMs.mean)} / ${formatStddevSeconds(nextPost7.lighthouse.summary.lcpMs)} (range: ${formatRangeSeconds(nextPost7.lighthouse.summary.lcpMs)})
- SEO median/mean/stddev: ${formatScore(nextPost7.lighthouse.summary.seoScore.median)} / ${formatScore(nextPost7.lighthouse.summary.seoScore.mean)} / ${formatStddevScore(nextPost7.lighthouse.summary.seoScore)} (range: ${formatScoreRange(nextPost7.lighthouse.summary.seoScore)})
- FCP run-by-run: ${renderRunBreakdown(nextPost7.lighthouse.runs, 'fcpMs', (v) => formatMsToSeconds(v))}
- LCP run-by-run: ${renderRunBreakdown(nextPost7.lighthouse.runs, 'lcpMs', (v) => formatMsToSeconds(v))}
`;
}

async function ensureNextifyMeta(projectRoot, metaPatch) {
  const dir = path.join(projectRoot, '.nextify');
  const metaPath = path.join(dir, 'meta.json');
  await fs.ensureDir(dir);

  let meta = {};
  if (await fs.pathExists(metaPath)) {
    try {
      meta = await fs.readJson(metaPath);
    } catch (e) {
      meta = {};
    }
  }

  const merged = { ...meta, ...metaPatch };
  await fs.writeJson(metaPath, merged, { spaces: 2 });
  return merged;
}

async function readNextifyMeta(projectRoot) {
  const metaPath = path.join(projectRoot, '.nextify', 'meta.json');
  if (!(await fs.pathExists(metaPath))) return null;
  try {
    return await fs.readJson(metaPath);
  } catch (e) {
    return null;
  }
}

async function createPreStep7Snapshot(projectRoot) {
  // IMPORTANT: 스냅샷을 프로젝트 "밖"에 둬야 fs-extra가 "자기 하위로 복사"를 막지 않습니다.
  const resolvedProjectRoot = path.resolve(projectRoot);
  const parentDir = path.dirname(resolvedProjectRoot);
  const projectName = path.basename(resolvedProjectRoot);

  const snapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'pre-step7');
  if (await fs.pathExists(snapshotRoot)) {
    return snapshotRoot;
  }
  await fs.ensureDir(path.dirname(snapshotRoot));
  await cloneProject(projectRoot, snapshotRoot);
  await ensureNextifyMeta(projectRoot, {
    preStep7SnapshotRoot: snapshotRoot,
  });
  return snapshotRoot;
}

async function generatePerformanceReport({
  projectRoot,
  baselineViteRoot,
  preStep7Root,
  outputMarkdownPath,
  lighthouseRuns,
  warmupRuns,
}) {
  const meta = await readNextifyMeta(projectRoot);
  const baselineFromMeta = meta?.sourceViteProjectRoot;

  const viteRootResolved = baselineViteRoot || baselineFromMeta;
  if (!viteRootResolved) {
    throw new Error(
      'Vite 원본 경로를 찾지 못했습니다. step1을 copy 모드로 실행했는지 확인하거나, step7 실행 시 --baseline <viteRoot> 옵션을 주세요.'
    );
  }

  const preRootResolved = preStep7Root || (await createPreStep7Snapshot(projectRoot));

  const vite = await measureTarget({
    label: 'Vite+React (baseline)',
    projectRoot: viteRootResolved,
    kind: 'vite',
    lighthouseRuns,
    warmupRuns,
  });
  const nextPre7 = await measureTarget({
    label: 'Next.js (step1~6)',
    projectRoot: preRootResolved,
    kind: 'next',
    lighthouseRuns,
    warmupRuns,
  });
  const nextPost7 = await measureTarget({
    label: 'Next.js (step1~7)',
    projectRoot,
    kind: 'next',
    lighthouseRuns,
    warmupRuns,
  });

  const md = renderMarkdownReport({ vite, nextPre7, nextPost7 });
  await fs.writeFile(outputMarkdownPath, md, 'utf-8');

  await ensureNextifyMeta(projectRoot, {
    lastPerformanceReport: {
      outputMarkdownPath,
      generatedAt: new Date().toISOString(),
      baselineViteRoot: viteRootResolved,
      preStep7Root: preRootResolved,
    },
  });

  console.log(chalk.green(`\n✅ 성능 레포트 생성 완료: ${outputMarkdownPath}\n`));
}

module.exports = {
  generatePerformanceReport,
  createPreStep7Snapshot,
  ensureNextifyMeta,
};

