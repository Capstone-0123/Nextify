// app/src/utils/project-info.cjs

const fs = require('fs-extra');
const path = require('path');

/**
 * 1. 패키지 매니저 감지 (Lock 파일 기준)
 */
function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * 2. 언어 감지 (JS vs TS)
 * tsconfig.json 존재 여부로 판단
 */
function detectLanguage(cwd) {
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return 'ts';
  }
  return 'js';
}

/**
 * 3. 빌드 도구 감지 (Vite vs CRA vs Other)
 * package.json의 의존성을 확인
 */
function detectBuildTool(cwd) {
  const pkgPath = path.join(cwd, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    return 'unknown';
  }

  try {
    const pkg = fs.readJsonSync(pkgPath);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['vite']) return 'vite';
    if (allDeps['react-scripts']) return 'cra'; // Create React App
    return 'other';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * 4. 모노레포 환경 감지
 * 워크스페이스 설정이나 툴 설정 파일 확인
 */
function detectMonorepo(cwd) {
  // pnpm
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return 'pnpm-workspace';

  // yarn/npm workspaces
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = fs.readJsonSync(pkgPath);
      if (pkg.workspaces) return 'workspaces';
    } catch (e) {}
  }

  // Turbo / Nx / Lerna
  if (fs.existsSync(path.join(cwd, 'turbo.json'))) return 'turborepo';
  if (fs.existsSync(path.join(cwd, 'nx.json'))) return 'nx';
  if (fs.existsSync(path.join(cwd, 'lerna.json'))) return 'lerna';

  return false;
}

/**
 * 5. 앱 타입 감지 (SPA vs Library)
 * index.html 존재 여부로 판단 (Vite SPA의 필수 조건)
 */
function detectAppType(cwd) {
  if (fs.existsSync(path.join(cwd, 'index.html'))) {
    return 'spa'; // Single Page Application
  }
  return 'library-or-server';
}

/**
 * 6. 설치 명령어 생성 헬퍼
 */
function getInstallCommand(pm) {
  switch (pm) {
    case 'yarn':
      return 'yarn';
    case 'pnpm':
      return 'pnpm install';
    case 'bun':
      return 'bun install';
    default:
      return 'npm install';
  }
}

module.exports = {
  detectPackageManager,
  detectLanguage,
  detectBuildTool,
  detectMonorepo,
  detectAppType,
  getInstallCommand,
};
