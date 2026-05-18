const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const chalk = require('chalk');
const os = require('os');
const { spawnSync } = require('child_process');

const { detectPackageManager } = require('../utils/project-info.cjs');
const { runCommand, startCommand } = require('../utils/exec.cjs');
const { cloneProject } = require('../utils/copy.cjs');

const CLI_PKG = require('../../package.json');
const REVIEW_ROOT_DIR = '.ai-migration';

const DEFAULT_LIGHTHOUSE_RUNS = 5;
const DEFAULT_LIGHTHOUSE_WARMUP_RUNS = 1;

// 마이그레이션 도구(app/) 루트. 이 파일은 app/src/step7/performance-report.cjs 이므로 두 단계 위가 app/.
const MIGRATOR_APP_ROOT = path.resolve(__dirname, '..', '..');
// lighthouse v12는 Node 18.18 이상을 요구합니다.
const LIGHTHOUSE_MIN_NODE_MAJOR = 18;
// require(esm)이 기본 동작하는 Node 버전 (Node 22.12+).
const REQUIRE_ESM_DEFAULT_MAJOR = 22;
const REQUIRE_ESM_DEFAULT_MINOR = 12;

function parseNodeVersion(versionString = process.version) {
  // process.version 예: 'v20.11.1'
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versionString);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function assertNodeVersionSupportsLighthouse() {
  const { major } = parseNodeVersion();
  if (major === 0) return; // 알 수 없으면 통과 (이후 단계에서 다른 에러로 잡힘)
  if (major < LIGHTHOUSE_MIN_NODE_MAJOR) {
    throw new Error(
      `Lighthouse 측정은 Node.js ${LIGHTHOUSE_MIN_NODE_MAJOR} 이상이 필요합니다.\n` +
        `현재 Node 버전: ${process.version}\n` +
        `해결: nvm/Volta/winget 등으로 Node LTS(권장: 22.x)를 설치한 뒤 다시 실행하세요.\n` +
        `  - nvm:   nvm install --lts && nvm use --lts\n` +
        `  - winget: winget install OpenJS.NodeJS.LTS\n`
    );
  }
}

/**
 * 마이그레이션 도구의 app/node_modules 안에 lighthouse 패키지가 실제로 풀려 있는지 확인.
 * package-lock.json은 있는데 node_modules가 비어있는 경우(npm install 미수행)도 잡습니다.
 */
async function lighthousePackageInstalled() {
  const pkgPath = path.join(MIGRATOR_APP_ROOT, 'node_modules', 'lighthouse', 'package.json');
  return fs.pathExists(pkgPath);
}

async function chromeLauncherPackageInstalled() {
  const pkgPath = path.join(MIGRATOR_APP_ROOT, 'node_modules', 'chrome-launcher', 'package.json');
  return fs.pathExists(pkgPath);
}

/**
 * app/ 디렉터리에서 npm install 1회 시도 (자동 복구).
 * 실패하면 사용자에게 수동 안내 메시지를 던집니다.
 */
async function tryAutoInstallMigratorDeps() {
  const pm = detectPackageManager(MIGRATOR_APP_ROOT) || 'npm';
  console.log(
    chalk.yellow(
      `\n⚠️  Lighthouse 측정을 위한 의존성(lighthouse, chrome-launcher)을 찾지 못했습니다.\n` +
        `   ${MIGRATOR_APP_ROOT} 에서 ${pm} install 을 자동 실행합니다...`
    )
  );
  try {
    if (pm === 'yarn') {
      await runCommand('yarn', ['install'], { cwd: MIGRATOR_APP_ROOT });
    } else if (pm === 'pnpm') {
      await runCommand('pnpm', ['install'], { cwd: MIGRATOR_APP_ROOT });
    } else if (pm === 'bun') {
      await runCommand('bun', ['install'], { cwd: MIGRATOR_APP_ROOT });
    } else {
      await runCommand('npm', ['install'], { cwd: MIGRATOR_APP_ROOT });
    }
    console.log(chalk.green('   ✔ 자동 설치 완료. 다시 시도합니다.\n'));
    return true;
  } catch (installErr) {
    throw new Error(
      `Lighthouse 의존성 자동 설치에 실패했습니다.\n` +
        `다음 명령을 직접 실행한 뒤 다시 시도하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  ${pm} install\n` +
        `(Windows PowerShell에서는 경로에 공백이 있어도 따옴표로 감싸세요)\n` +
        `자동 설치 오류: ${installErr.message}`
    );
  }
}

/**
 * lighthouse(ESM) + chrome-launcher(CJS) 의존성을 안전하게 로드.
 * - lighthouse는 v10+ 부터 ESM-only이므로 dynamic import() 사용.
 * - 모듈을 못 찾으면 1회에 한해 자동 설치 후 재시도.
 * - 실패 케이스별로 정확한 한국어 에러 메시지를 던집니다.
 */
async function loadLighthouseDeps({ allowAutoInstall = true } = {}) {
  if (!(await lighthousePackageInstalled()) || !(await chromeLauncherPackageInstalled())) {
    if (allowAutoInstall) {
      await tryAutoInstallMigratorDeps();
      return loadLighthouseDeps({ allowAutoInstall: false });
    }
    throw new Error(
      `lighthouse 또는 chrome-launcher 패키지가 ${MIGRATOR_APP_ROOT}/node_modules 에 없습니다.\n` +
        `해결: 다음 명령을 실행하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  rm -rf node_modules package-lock.json && npm install\n` +
        `(Windows PowerShell: Remove-Item -Recurse -Force node_modules, package-lock.json; npm install)`
    );
  }

  let lighthouseModule;
  let chromeLauncherModule;
  try {
    // lighthouse는 ESM이므로 반드시 dynamic import 사용 (require는 Node<22.12에서 ERR_REQUIRE_ESM).
    lighthouseModule = await import('lighthouse');
  } catch (e) {
    const code = e?.code || '';
    const msg = e?.message || String(e);
    if (code === 'ERR_REQUIRE_ESM' || /ERR_REQUIRE_ESM/.test(msg)) {
      throw new Error(
        `lighthouse는 ESM 전용 패키지인데 현재 환경에서 import에 실패했습니다.\n` +
          `현재 Node 버전: ${process.version}\n` +
          `해결: Node.js ${REQUIRE_ESM_DEFAULT_MAJOR}.${REQUIRE_ESM_DEFAULT_MINOR} 이상(LTS 22.x 권장)으로 업그레이드하세요.\n` +
          `원본 오류: ${msg}`
      );
    }
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/.test(msg)
    ) {
      if (allowAutoInstall) {
        await tryAutoInstallMigratorDeps();
        return loadLighthouseDeps({ allowAutoInstall: false });
      }
      throw new Error(
        `lighthouse 모듈을 가져오지 못했습니다.\n` +
          `해결:\n` +
          `  cd "${MIGRATOR_APP_ROOT}"\n` +
          `  npm install\n` +
          `원본 오류: ${msg}`
      );
    }
    throw new Error(
      `lighthouse 로드 중 알 수 없는 오류가 발생했습니다.\n` +
        `현재 Node 버전: ${process.version}\n` +
        `원본 오류: ${msg}`
    );
  }

  try {
    chromeLauncherModule = require('chrome-launcher');
  } catch (e) {
    if (allowAutoInstall) {
      await tryAutoInstallMigratorDeps();
      return loadLighthouseDeps({ allowAutoInstall: false });
    }
    throw new Error(
      `chrome-launcher 모듈을 가져오지 못했습니다.\n` +
        `해결:\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  npm install chrome-launcher\n` +
        `원본 오류: ${e?.message || String(e)}`
    );
  }

  const lighthouseRunner =
    (typeof lighthouseModule === 'function' && lighthouseModule) ||
    lighthouseModule?.default ||
    lighthouseModule?.lighthouse ||
    null;

  if (typeof lighthouseRunner !== 'function') {
    throw new Error(
      `lighthouse는 로드되었지만 실행 함수를 찾지 못했습니다 (모듈이 깨진 것으로 보입니다).\n` +
        `해결: app/ 의 의존성을 정리하고 다시 설치하세요.\n` +
        `  cd "${MIGRATOR_APP_ROOT}"\n` +
        `  rm -rf node_modules package-lock.json && npm install\n` +
        `(Windows PowerShell: Remove-Item -Recurse -Force node_modules, package-lock.json; npm install)`
    );
  }

  return { lighthouseRunner, chromeLauncher: chromeLauncherModule };
}

/**
 * 시스템에 설치된 Chrome/Chromium/Edge 경로를 찾아 반환. 없으면 null.
 */
function findChromeInstallation(chromeLauncher) {
  try {
    const Launcher = chromeLauncher?.Launcher || chromeLauncher?.default?.Launcher;
    if (Launcher && typeof Launcher.getInstallations === 'function') {
      const installs = Launcher.getInstallations();
      if (Array.isArray(installs) && installs.length > 0) return installs[0];
    }
  } catch {
    // chrome-launcher 내부 탐지 실패도 "Chrome 미설치"로 간주
  }
  return null;
}

function chromeMissingErrorMessage() {
  const platform = process.platform;
  const lines = [
    '시스템에 Chrome (또는 Chromium/Edge)이 설치되어 있지 않거나 자동 탐지에 실패했습니다.',
    'Lighthouse는 헤드리스 Chrome으로 측정하므로 Chrome 계열 브라우저 설치가 필수입니다.',
    '',
    '설치 방법:',
  ];
  if (platform === 'win32') {
    lines.push('  - 다운로드: https://www.google.com/chrome/');
    lines.push('  - 또는 winget: winget install Google.Chrome');
  } else if (platform === 'darwin') {
    lines.push('  - 다운로드: https://www.google.com/chrome/');
    lines.push('  - 또는 Homebrew: brew install --cask google-chrome');
  } else {
    lines.push('  - Ubuntu/Debian: sudo apt-get install -y google-chrome-stable 또는 chromium-browser');
    lines.push('  - Fedora/RHEL: sudo dnf install -y google-chrome-stable 또는 chromium');
  }
  lines.push('');
  lines.push('설치 후에도 같은 에러가 나면 환경변수 CHROME_PATH 에 실행 파일 경로를 지정하세요.');
  lines.push('  예) Windows PowerShell: $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"');
  return lines.join('\n');
}

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

/**
 * 자식 프로세스의 stdout/stderr 파이프를 능동적으로 비웁니다.
 * stdio: 'pipe' 인 채로 아무도 읽지 않으면 OS 파이프 버퍼(Windows에서 수 KB)가 차서
 * 자식이 다음 write에서 멈춰버릴 수 있습니다 (서버가 'Ready' 후에도 응답 못하는 증상으로 보임).
 */
function drainChildStdio(child) {
  if (!child) return;
  if (child.stdout && typeof child.stdout.resume === 'function') {
    child.stdout.on('data', () => {});
    child.stdout.resume();
  }
  if (child.stderr && typeof child.stderr.resume === 'function') {
    child.stderr.on('data', () => {});
    child.stderr.resume();
  }
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
      const child = startCommand(cmd, args, { cwd: projectRoot, stdio: 'pipe' });
      drainChildStdio(child);
      return child;
    }
    // fallback: try npx vite preview
    const child = startCommand(
      'npx',
      ['vite', 'preview', '--port', String(port), '--strictPort'],
      { cwd: projectRoot, stdio: 'pipe' }
    );
    drainChildStdio(child);
    return child;
  }

  // next start: -p 플래그를 패키지 매니저로 넘기지 않고 PORT 환경 변수로 전달합니다.
  // 이유:
  //  - yarn berry(2+)는 `-p` 를 자기 자신의 `--project` 옵션으로 가로채서
  //    `yarn run start -- -p 3000` 호출 시 "Invalid project directory ...\\-p" 에러로 실패합니다.
  //    (Windows + cmd.exe 환경에서 재현. PowerShell에서 손으로 입력하면 동작해 헷갈리기 쉽습니다.)
  //  - npm 은 `--` 를, yarn 은 `--` 가 필요 없는 등 패키지 매니저별 인자 전달 방식이 달라
  //    플래그 충돌을 피하려면 환경 변수가 가장 안전합니다.
  // Next.js 는 PORT 환경 변수를 기본 지원합니다 (next start 문서 참고).
  const nextEnv = { ...process.env, PORT: String(port) };
  if (scripts.start) {
    const child = startCommand(cmd, [...run('start')], {
      cwd: projectRoot,
      stdio: 'pipe',
      env: nextEnv,
    });
    drainChildStdio(child);
    return child;
  }
  const child = startCommand('npx', ['next', 'start'], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: nextEnv,
  });
  drainChildStdio(child);
  return child;
}

async function runLighthouseOnce(url) {
  // 1) Node 버전 사전 체크 (lighthouse v12는 Node 18+ 필요)
  assertNodeVersionSupportsLighthouse();

  // 2) lighthouse(ESM) + chrome-launcher 로드 (필요 시 자동 npm install 1회 시도)
  const { lighthouseRunner, chromeLauncher } = await loadLighthouseDeps();

  // 3) Chrome 사전 탐지
  const chromePath = findChromeInstallation(chromeLauncher);
  if (!chromePath) {
    throw new Error(chromeMissingErrorMessage());
  }

  const baseTmp = path.join(os.tmpdir(), 'nextify-lighthouse');
  await fs.ensureDir(baseTmp);
  const userDataDir = await fs.mkdtemp(path.join(baseTmp, 'profile-'));

  // 4) Chrome 실행 (실패하면 별도 가이드)
  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromePath,
      chromeFlags: [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
      ],
    });
  } catch (launchErr) {
    throw new Error(
      `Chrome 헤드리스 실행에 실패했습니다.\n` +
        `시도한 Chrome 경로: ${chromePath}\n` +
        `현재 OS: ${process.platform}\n` +
        `해결 가이드:\n` +
        `  - 다른 Chrome 인스턴스가 실행 중이면 종료한 뒤 다시 시도하세요.\n` +
        `  - 백신/회사 보안 정책이 Chrome 헤드리스를 차단하는지 확인하세요.\n` +
        `  - Linux 서버라면 의존 라이브러리(libnss3, libgbm1 등) 설치 여부를 확인하세요.\n` +
        `원본 오류: ${launchErr?.message || String(launchErr)}`
    );
  }
  try {
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

function renderTargetDetail(target) {
  const summary = target?.lighthouse?.summary || {};
  const sizeLabel = target.kind === 'vite' ? 'Dist size dir' : 'Static size dir';
  return `### ${target.label}

- Root: \`${target.projectRoot}\`
- URL: \`${target.url}\`
- ${sizeLabel}: \`${target.jsPayload?.directory || 'N/A'}\` (${target.jsPayload?.human || 'N/A'})
- Lighthouse finalUrl: \`${target.lighthouse?.finalUrl || 'N/A'}\`
- FCP median/mean/stddev: ${formatMsToSeconds(summary.fcpMs?.median)} / ${formatMsToSeconds(summary.fcpMs?.mean)} / ${formatStddevSeconds(summary.fcpMs)} (range: ${formatRangeSeconds(summary.fcpMs)})
- LCP median/mean/stddev: ${formatMsToSeconds(summary.lcpMs?.median)} / ${formatMsToSeconds(summary.lcpMs?.mean)} / ${formatStddevSeconds(summary.lcpMs)} (range: ${formatRangeSeconds(summary.lcpMs)})
- SEO median/mean/stddev: ${formatScore(summary.seoScore?.median)} / ${formatScore(summary.seoScore?.mean)} / ${formatStddevScore(summary.seoScore)} (range: ${formatScoreRange(summary.seoScore)})
- FCP run-by-run: ${renderRunBreakdown(target.lighthouse?.runs, 'fcpMs', (v) => formatMsToSeconds(v))}
- LCP run-by-run: ${renderRunBreakdown(target.lighthouse?.runs, 'lcpMs', (v) => formatMsToSeconds(v))}
`;
}

// ---------------------------------------------------------------------------
// 변경 통계 / 헤더 / 단계 요약 헬퍼들
// ---------------------------------------------------------------------------

function safeReadJsonSync(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readJsonSync(filePath);
  } catch {
    return null;
  }
}

function getGitShortHash(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: false,
      windowsHide: true,
      timeout: 3000,
    });
    if (!r.error && r.status === 0) {
      const out = String(r.stdout || '').trim();
      return out || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function detectNpmVersion() {
  try {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(cmd, ['--version'], {
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: false,
      windowsHide: true,
      timeout: 3000,
    });
    if (!r.error && r.status === 0) {
      const out = String(r.stdout || '').trim();
      return out || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function describeOs() {
  const platform = process.platform;
  const release = os.release();
  if (platform === 'win32') {
    // Node 가 보는 release 는 NT 버전(10.0.x). 그대로 보여줌.
    return `Windows ${release}`;
  }
  if (platform === 'darwin') return `macOS ${release}`;
  if (platform === 'linux') return `Linux ${release}`;
  return `${platform} ${release}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return null;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}초`;
  return `${m}분 ${String(s).padStart(2, '0')}초`;
}

function formatLocalIsoLike(date) {
  // 사용자가 예시로 준 형식: YYYY-MM-DDTHH:MM:SS+09:00 (로컬 타임존)
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzh = pad(Math.floor(Math.abs(tzMin) / 60));
  const tzm = pad(Math.abs(tzMin) % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${tzh}:${tzm}`;
}

function buildReportHeader({ now, toolVersion, toolCommit, project, elapsedMs }) {
  const nodeV = process.version;
  const npmV = detectNpmVersion();
  const osLabel = describeOs();
  const elapsedLabel = formatDurationMs(elapsedMs);

  const lines = [];
  lines.push(`생성 시각: ${formatLocalIsoLike(now)}`);
  lines.push(
    `도구 버전: nextify-cli ${toolVersion}${toolCommit ? ` (commit ${toolCommit})` : ''}`,
  );
  if (project && project.name) {
    lines.push(
      `대상 프로젝트: ${project.name}${project.commit ? ` (commit ${project.commit})` : ''}`,
    );
  }
  const envParts = [`Node ${nodeV}`];
  if (npmV) envParts.push(`npm ${npmV}`);
  envParts.push(osLabel);
  lines.push(`실행 환경: ${envParts.join(' / ')}`);
  if (elapsedLabel) {
    lines.push(`총 실행 시간: ${elapsedLabel}`);
  }
  return lines.join('  \n');
}

const STEP_DESCRIPTIONS = [
  { step: 1, title: 'Vite 환경 → Next 환경 (설정/스크립트/엔트리)' },
  { step: 2, title: '라우팅 구조 변환 (React Router → App Router)' },
  { step: 3, title: '라우팅 페이지 변환 (page.tsx/layout.tsx 생성)' },
  { step: 4, title: '스타일/리소스/공개 자산 이전' },
  { step: 5, title: "'use client' 처리 · Zustand 등 전역 상태 마이그레이션" },
  { step: 6, title: '환경 변수 / 의존성 검토 가이드' },
  { step: 7, title: 'next/image · next/font · 동적 import · 타입 보정' },
];

function renderStepsSummaryTable({ finalStepNumber }) {
  const lines = [];
  lines.push('| Step | 내용 | 결과 |');
  lines.push('|------|------|------|');
  for (const s of STEP_DESCRIPTIONS) {
    let status;
    if (finalStepNumber == null) {
      status = '✅ Pass';
    } else if (s.step <= finalStepNumber) {
      status = '✅ Pass';
    } else {
      status = '⏭️ Skipped';
    }
    lines.push(`| Step ${s.step} | ${s.title} | ${status} |`);
  }
  return lines.join('\n');
}

function categorizeFile(relPath) {
  if (!relPath) return null;
  const p = String(relPath).replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() || '';

  // Config (먼저 검사 — config 파일이 styles/utils 분류와 충돌 안 하도록)
  if (
    base.startsWith('next.config.') ||
    base.startsWith('tsconfig') ||
    base === 'package.json' ||
    base === 'package-lock.json' ||
    base === '.eslintrc' || base.startsWith('.eslintrc.') ||
    base === '.prettierrc' || base.startsWith('.prettierrc.') ||
    base === '.gitignore' ||
    base === 'postcss.config.js' || base === 'postcss.config.mjs' ||
    base === 'tailwind.config.js' || base === 'tailwind.config.ts' ||
    base === 'vite.config.ts' || base === 'vite.config.js'
  ) {
    return 'config';
  }

  // Routes (app router)
  if (
    p.startsWith('app/') ||
    p.startsWith('src/app/') ||
    p.startsWith('pages/') ||
    p.startsWith('src/pages/')
  ) {
    return 'routes';
  }

  // Styles
  if (/\.(css|scss|sass|less|styl)$/.test(base)) {
    return 'styles';
  }

  // Components
  if (p.includes('/components/') || p.startsWith('components/')) {
    return 'components';
  }

  // Utils / Types
  if (
    p.includes('/utils/') || p.startsWith('utils/') ||
    p.includes('/types/') || p.startsWith('types/') ||
    p.includes('/lib/') || p.startsWith('lib/') ||
    p.includes('/hooks/') || p.startsWith('hooks/')
  ) {
    return 'utils';
  }

  return null;
}

function isClientComponent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const head = fs.readFileSync(filePath, 'utf-8').slice(0, 512);
    return /^['"]use client['"];?/m.test(head);
  } catch {
    return false;
  }
}

function isLikelyComponentFile(relPath) {
  if (!relPath) return false;
  const p = String(relPath).replace(/\\/g, '/');
  if (!/\.(tsx|jsx)$/.test(p)) return false;
  return true;
}

function countLines(text) {
  if (!text) return 0;
  // 마지막 줄에 개행이 없어도 1 라인으로 카운트.
  const n = text.split('\n').length;
  return n;
}

function looksLikeRouteFile(relPath) {
  if (!relPath) return false;
  const p = String(relPath).replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop() || '';
  if (!(p.startsWith('app/') || p.startsWith('src/app/'))) return false;
  return (
    base === 'page.tsx' || base === 'page.jsx' || base === 'page.ts' || base === 'page.js' ||
    base === 'layout.tsx' || base === 'layout.jsx' ||
    base === 'route.ts' || base === 'route.js'
  );
}

function computeChangeStats(manifest, projectRoot) {
  const empty = {
    available: false,
    created: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    plusLOC: 0,
    minusLOC: 0,
    byCategory: {
      routes: { created: 0, modified: 0, deleted: 0 },
      components: { created: 0, modified: 0, deleted: 0 },
      config: { created: 0, modified: 0, deleted: 0 },
      styles: { created: 0, modified: 0, deleted: 0 },
      utils: { created: 0, modified: 0, deleted: 0 },
    },
    useClientCount: 0,
    totalComponentCount: 0,
    newRouteFileCount: 0,
    totalProjectFiles: null,
    changedFiles: 0,
  };

  if (!manifest || !Array.isArray(manifest.changes)) {
    return empty;
  }

  const stats = { ...empty, available: true, byCategory: JSON.parse(JSON.stringify(empty.byCategory)) };
  const seenAfterPaths = new Set();

  for (const change of manifest.changes) {
    const type = change.type;
    const rel = change.relativePath || change.afterRelativePath || change.beforeRelativePath || '';

    if (type === 'create') stats.created++;
    else if (type === 'modify') stats.modified++;
    else if (type === 'delete') stats.deleted++;
    else if (type === 'rename' || type === 'move') stats.renamed++;

    // LOC 카운트 (베스트-에포트). before/after 스냅샷이 없으면 스킵.
    const beforeCandidates = [
      change.beforeAbsolutePath,
      change.beforePath,
      change.beforeSnapshotPath,
      change.diffBeforePath,
    ];
    const afterCandidates = [
      change.afterAbsolutePath,
      change.afterPath,
      change.diffAfterPath,
    ];
    let beforeText = '';
    let afterText = '';
    for (const p of beforeCandidates) {
      if (p && fs.existsSync(p)) {
        try { beforeText = fs.readFileSync(p, 'utf-8'); break; } catch { /* */ }
      }
    }
    for (const p of afterCandidates) {
      if (p && fs.existsSync(p)) {
        try { afterText = fs.readFileSync(p, 'utf-8'); break; } catch { /* */ }
      }
    }

    const beforeLines = countLines(beforeText);
    const afterLines = countLines(afterText);

    if (type === 'create') {
      stats.plusLOC += afterLines;
    } else if (type === 'delete') {
      stats.minusLOC += beforeLines;
    } else if (type === 'modify' || type === 'rename' || type === 'move') {
      const diff = afterLines - beforeLines;
      if (diff > 0) stats.plusLOC += diff;
      else stats.minusLOC += -diff;
    }

    const cat = categorizeFile(rel);
    if (cat && stats.byCategory[cat]) {
      if (type === 'create') stats.byCategory[cat].created++;
      else if (type === 'modify') stats.byCategory[cat].modified++;
      else if (type === 'delete') stats.byCategory[cat].deleted++;
    }

    if (rel && (type === 'create' || type === 'modify')) {
      seenAfterPaths.add(rel.replace(/\\/g, '/'));
    }
    if (type === 'create' && looksLikeRouteFile(rel)) {
      stats.newRouteFileCount++;
    }
  }

  stats.changedFiles = seenAfterPaths.size;

  // use client 카운트 — 프로젝트 루트에서 .tsx/.jsx 컴포넌트 후보를 훑음.
  if (projectRoot) {
    try {
      const scanRoots = [
        path.join(projectRoot, 'app'),
        path.join(projectRoot, 'src'),
        path.join(projectRoot, 'components'),
      ].filter((p) => fs.existsSync(p));

      const componentFiles = [];
      const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__nextify_snapshots', REVIEW_ROOT_DIR, '.nextify', 'dist', 'build']);

      function walk(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (SKIP_DIRS.has(ent.name)) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile() && /\.(tsx|jsx)$/.test(ent.name)) {
            componentFiles.push(full);
          }
        }
      }
      for (const r of scanRoots) walk(r);

      stats.totalComponentCount = componentFiles.length;
      for (const f of componentFiles) {
        if (isClientComponent(f)) stats.useClientCount++;
      }
    } catch {
      /* ignore */
    }

    // 전체 프로젝트 파일 수 (대략) — 변경 파일 비율 계산용.
    try {
      const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '__nextify_snapshots', REVIEW_ROOT_DIR, '.nextify', 'dist', 'build']);
      let count = 0;
      function walkAll(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (SKIP_DIRS.has(ent.name)) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walkAll(full);
          else if (ent.isFile()) count++;
        }
      }
      walkAll(projectRoot);
      stats.totalProjectFiles = count;
    } catch {
      /* ignore */
    }
  }

  // (silence unused warning)
  void isLikelyComponentFile;

  return stats;
}

function findLatestSessionManifest(projectRoot) {
  // 가장 최근 step 의 session.json 을 찾아 반환. 없으면 null.
  try {
    const root = path.join(projectRoot, REVIEW_ROOT_DIR);
    if (!fs.existsSync(root)) return null;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const stepDirs = entries
      .filter((e) => e.isDirectory() && /^step\d+$/.test(e.name))
      .map((e) => ({ name: e.name, num: Number(e.name.replace('step', '')) }))
      .sort((a, b) => b.num - a.num);
    for (const sd of stepDirs) {
      const sessionPath = path.join(root, sd.name, 'session.json');
      if (fs.existsSync(sessionPath)) {
        const manifest = safeReadJsonSync(sessionPath);
        if (manifest) {
          return { manifest, sessionPath, stepNumber: sd.num };
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function renderChangeStatsTable(stats) {
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const netFiles = (stats.created || 0) - (stats.deleted || 0);
  const netSign = netFiles >= 0 ? '+' : '−';
  return [
    '| 항목 | 개수 |',
    '| --- | ---: |',
    `| Created | ${fmtNum(stats.created)} |`,
    `| Modified | ${fmtNum(stats.modified)} |`,
    `| Deleted | ${fmtNum(stats.deleted)} |`,
    `| Renamed/Moved | ${fmtNum(stats.renamed)} |`,
    `| +LOC | ${fmtNum(stats.plusLOC)} |`,
    `| −LOC | ${fmtNum(stats.minusLOC)} |`,
    `| Net files (Created − Deleted) | ${netSign}${fmtNum(Math.abs(netFiles))} |`,
  ].join('\n');
}

function renderCategoryTable(byCategory) {
  const rows = [
    { key: 'routes', label: 'Routes (`app/`)' },
    { key: 'components', label: 'Components' },
    { key: 'config', label: 'Config (`next.config.*`, `tsconfig.*` 등)' },
    { key: 'styles', label: 'Styles' },
    { key: 'utils', label: 'Utils / Types' },
  ];
  const lines = ['| 카테고리 | Created | Modified | Deleted |', '| --- | ---: | ---: | ---: |'];
  for (const r of rows) {
    const v = byCategory[r.key] || { created: 0, modified: 0, deleted: 0 };
    lines.push(`| ${r.label} | ${v.created} | ${v.modified} | ${v.deleted} |`);
  }
  return lines.join('\n');
}

function renderAdditionalStats(stats) {
  const lines = [];
  if (stats.totalComponentCount > 0 || stats.useClientCount > 0) {
    lines.push(`> \`use client\` 표시된 컴포넌트: ${stats.useClientCount} / ${stats.totalComponentCount}  `);
  }
  if (stats.newRouteFileCount > 0) {
    lines.push(`> 새로 생성된 라우트 파일: ${stats.newRouteFileCount}  `);
  }
  if (stats.totalProjectFiles && stats.changedFiles) {
    const ratio = (stats.changedFiles / stats.totalProjectFiles) * 100;
    lines.push(
      `> 변경 파일 비율: ${stats.changedFiles} / ${stats.totalProjectFiles} (${ratio.toFixed(1)}%)`,
    );
  }
  return lines.join('\n');
}

function renderMarkdownReport({
  targets,
  failures,
  manifestInfo,
  changeStats,
  toolVersion,
  toolCommit,
  project,
  startedAt,
  now,
}) {
  const rows = targets.map((t) => pickSummaryRow(t));
  const summaryRows = rows.length
    ? rows
        .map(
          (row) =>
            `| ${row.label} | ${row.fcp} | ${row.fcpStability} | ${row.lcp} | ${row.lcpStability} | ${row.seo} | ${row.seoStability} | ${row.js} |`,
        )
        .join('\n')
    : '| (no successful targets) | N/A | N/A | N/A | N/A | N/A | N/A | N/A |';
  const detailSection = targets.length
    ? targets.map((target) => renderTargetDetail(target)).join('\n')
    : '- 성공적으로 측정된 타깃이 없습니다.';
  const failureSection =
    Array.isArray(failures) && failures.length > 0
      ? failures
          .map((item) => `- ${item.label}: ${item.errorMessage}`)
          .join('\n')
      : '- 없음';

  const reportNow = now || new Date();
  const elapsedMs = startedAt ? reportNow.getTime() - startedAt : null;

  const header = buildReportHeader({
    now: reportNow,
    toolVersion,
    toolCommit,
    project,
    elapsedMs,
  });

  const finalStepNumber = manifestInfo?.stepNumber ?? null;
  const stepsTable = renderStepsSummaryTable({ finalStepNumber });

  const hasChangeStats = changeStats && changeStats.available;
  const changeStatsBlock = hasChangeStats
    ? `## 변경 파일 통계

${renderChangeStatsTable(changeStats)}

### 카테고리별 변경

${renderCategoryTable(changeStats.byCategory)}
${renderAdditionalStats(changeStats) ? `\n${renderAdditionalStats(changeStats)}\n` : ''}`
    : `## 변경 파일 통계

> session.json 을 찾지 못해 변경 통계를 표시할 수 없습니다. (\`.ai-migration/stepN/session.json\` 필요)
`;

  return `# Nextify Migration Report

${header}

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

## 변환 요약 (Step 1 ~ Step 7)

${stepsTable}

${changeStatsBlock}
## 결과 요약 (${targets.length}-way, successful targets)

| Target | FCP (median) | FCP σ | LCP (median) | LCP σ | SEO (median) | SEO σ | Total JS payload size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${summaryRows}

## 실패 항목

${failureSection}

---

<details>
<summary><b>📊 측정 상세 보기</b></summary>

${detailSection}
</details>
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

/**
 * pre-step7 스냅샷의 next.config.mjs 에 "측정 전용 빌드 완화" 옵션을 주입합니다.
 *
 * 이유:
 * - step7 의 마지막 단계는 "TypeScript 타입 검사 + AI 자동 수정" 입니다.
 *   이 보정은 메인 폴더(step1~7)에만 적용되고, pre-step7 스냅샷에는 잔존 타입
 *   에러가 남습니다 (예: 사용 안 되는 React Router 코드의 children prop 누락).
 * - 그 결과 step1~6 baseline 측정 시 `next build` 가 type check 단계에서 실패하여
 *   Lighthouse 측정 자체가 불가능해집니다.
 * - 측정 목적상 type/eslint 정합성은 무관하므로 (런타임 perf 만 보면 됨) 빌드
 *   시점의 type/eslint 검사만 우회합니다. 멱등 — 이미 적용돼 있으면 skip.
 */
async function injectMeasurementBuildOverrides(snapshotRoot) {
  const configPath = path.join(snapshotRoot, 'next.config.mjs');
  if (!(await fs.pathExists(configPath))) {
    const fresh = `// [Nextify] pre-step7 측정 전용 빌드 완화 옵션\n` +
      `/* __nextifyMeasurementOverridesApplied */\n` +
      `const nextConfig = {\n` +
      `  typescript: { ignoreBuildErrors: true },\n` +
      `};\n` +
      `export default nextConfig;\n`;
    await fs.writeFile(configPath, fresh, 'utf-8');
    return;
  }

  let content = await fs.readFile(configPath, 'utf-8');
  if (content.includes('__nextifyMeasurementOverridesApplied')) {
    return;
  }

  const marker = '/* __nextifyMeasurementOverridesApplied */';
  // 1순위: `export default <name>;` 패턴을 찾아서 wrapper spread 로 변환.
  //   기존 nextConfig 의 모든 옵션(rewrites, headers 등)을 보존하면서
  //   typescript 무시 옵션만 덮어씁니다. (Next 16 부터 next.config 의 eslint 옵션은
  //   "Unrecognized key(s) in object: 'eslint'" 경고로 거부되므로 사용하지 않음)
  const exportNamed = content.match(/export\s+default\s+(\w+)\s*;?\s*$/m);
  if (exportNamed) {
    const varName = exportNamed[1];
    const replacement =
      `${marker}\n` +
      `export default {\n` +
      `  ...${varName},\n` +
      `  typescript: { ignoreBuildErrors: true },\n` +
      `};\n`;
    content = content.replace(exportNamed[0], replacement);
    await fs.writeFile(configPath, content, 'utf-8');
    return;
  }

  // 2순위: `export default { ... }` 인라인 객체 — 객체 시작 직후에 옵션 삽입.
  const exportInline = content.match(/export\s+default\s*\{/);
  if (exportInline) {
    const insertAt = exportInline.index + exportInline[0].length;
    const inject =
      `\n  ${marker}\n` +
      `  typescript: { ignoreBuildErrors: true },\n`;
    content = content.slice(0, insertAt) + inject + content.slice(insertAt);
    await fs.writeFile(configPath, content, 'utf-8');
    return;
  }

  console.warn(
    chalk.yellow(
      `   ⚠️  pre-step7 스냅샷의 next.config.mjs 에 측정 완화 옵션을 자동 주입하지 못했습니다. ` +
        `step1~6 baseline 빌드가 type 에러로 실패할 수 있습니다.`,
    ),
  );
}

async function createPreStep7Snapshot(projectRoot) {
  // IMPORTANT: 스냅샷을 프로젝트 "밖"에 둬야 fs-extra가 "자기 하위로 복사"를 막지 않습니다.
  const resolvedProjectRoot = path.resolve(projectRoot);
  const parentDir = path.dirname(resolvedProjectRoot);
  const projectName = path.basename(resolvedProjectRoot);

  const snapshotRoot = path.join(parentDir, `${projectName}__nextify_snapshots`, 'pre-step7');
  if (await fs.pathExists(snapshotRoot)) {
    await injectMeasurementBuildOverrides(snapshotRoot);
    return snapshotRoot;
  }
  await fs.ensureDir(path.dirname(snapshotRoot));
  await cloneProject(projectRoot, snapshotRoot);
  await injectMeasurementBuildOverrides(snapshotRoot);
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
  startedAt,
}) {
  const reportStartedAt = startedAt || Date.now();
  const meta = await readNextifyMeta(projectRoot);
  const baselineFromMeta = meta?.sourceViteProjectRoot;

  const viteRootResolved = baselineViteRoot || baselineFromMeta;
  if (!viteRootResolved) {
    throw new Error(
      'Vite 원본 경로를 찾지 못했습니다. step1을 copy 모드로 실행했는지 확인하거나, step7 실행 시 --baseline <viteRoot> 옵션을 주세요.'
    );
  }

  const preRootResolved = preStep7Root || (await createPreStep7Snapshot(projectRoot));

  const targets = [];
  const failures = [];
  const measurePlans = [
    { label: 'Vite+React (baseline)', projectRoot: viteRootResolved, kind: 'vite' },
    { label: 'Next.js (step1~6)', projectRoot: preRootResolved, kind: 'next' },
    { label: 'Next.js (step1~7)', projectRoot, kind: 'next' },
  ];

  for (const plan of measurePlans) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const measured = await measureTarget({
        label: plan.label,
        projectRoot: plan.projectRoot,
        kind: plan.kind,
        lighthouseRuns,
        warmupRuns,
      });
      targets.push(measured);
    } catch (error) {
      failures.push({
        label: plan.label,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      console.log(chalk.yellow(`⚠️  [레포트] ${plan.label} 측정 실패: ${failures[failures.length - 1].errorMessage}`));
    }
  }

  // ------------------------------------------------------------------
  // 변경 통계 / 환경 정보 수집 (실패해도 레포트 본문 생성은 계속)
  // ------------------------------------------------------------------
  const manifestInfo = findLatestSessionManifest(projectRoot);
  const changeStats = computeChangeStats(manifestInfo?.manifest, projectRoot);

  const toolVersion = CLI_PKG && CLI_PKG.version ? String(CLI_PKG.version) : '0.0.0';
  const toolCommit = getGitShortHash(MIGRATOR_APP_ROOT);

  let project = null;
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = safeReadJsonSync(pkgPath);
    if (pkg && pkg.name) {
      project = { name: pkg.name, commit: getGitShortHash(projectRoot) };
    } else {
      project = { name: path.basename(projectRoot), commit: getGitShortHash(projectRoot) };
    }
  } catch {
    project = { name: path.basename(projectRoot), commit: null };
  }

  const md = renderMarkdownReport({
    targets,
    failures,
    manifestInfo,
    changeStats,
    toolVersion,
    toolCommit,
    project,
    startedAt: reportStartedAt,
    now: new Date(),
  });
  await fs.writeFile(outputMarkdownPath, md, 'utf-8');

  await ensureNextifyMeta(projectRoot, {
    lastPerformanceReport: {
      outputMarkdownPath,
      generatedAt: new Date().toISOString(),
      baselineViteRoot: viteRootResolved,
      preStep7Root: preRootResolved,
      successfulTargets: targets.length,
      failedTargets: failures.length,
    },
  });

  if (failures.length > 0) {
    console.log(chalk.yellow(`\n⚠️  부분 성능 레포트 생성 완료: ${outputMarkdownPath}`));
    console.log(chalk.gray(`   - 성공: ${targets.length}, 실패: ${failures.length}\n`));
    return;
  }

  console.log(chalk.green(`\n✅ 성능 레포트 생성 완료: ${outputMarkdownPath}\n`));
}

module.exports = {
  generatePerformanceReport,
  createPreStep7Snapshot,
  ensureNextifyMeta,
};

