const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { cloneProject } = require('./copy.cjs');

const REVIEW_ROOT_DIR = '.ai-migration';
/** Visual Studio Marketplace 확장 ID (`vsce publish` / `code --install-extension` 용). */
const REVIEW_EXTENSION_MARKET_ID = 'capstone0123.nextify-review';
/** Marketplace / 로컬 모두: `code --list-extensions` 에는 `publisher.nextify-review` 형태로 나옵니다. */
function extensionListIncludesNextifyReview(lines) {
  return lines.some((line) => {
    const s = String(line || '').trim().toLowerCase();
    return s === 'nextify-review' || s.endsWith('.nextify-review');
  });
}
const EXCLUDED_DIRS = new Set(['.git', '.next', 'dist', 'node_modules', REVIEW_ROOT_DIR]);

function getEditorCommands() {
  return process.platform === 'win32'
    ? ['code.cmd', 'code', 'code-insiders.cmd', 'code-insiders', 'cursor.cmd', 'cursor']
    : ['code', 'code-insiders', 'cursor'];
}

async function createStepReviewSession(projectRoot, stepName, executeStep) {
  const sessionRoot = path.join(projectRoot, REVIEW_ROOT_DIR, stepName);
  const previewRoot = path.join(os.tmpdir(), `nextify-preview-${stepName}-${crypto.randomUUID()}`);
  const filesRoot = path.join(sessionRoot, 'files');
  const placeholdersRoot = path.join(sessionRoot, 'placeholders');
  const manifestPath = path.join(sessionRoot, 'session.json');

  await fs.remove(sessionRoot);
  await fs.ensureDir(filesRoot);
  await fs.ensureDir(placeholdersRoot);
  await fs.remove(previewRoot);
  await cloneProject(projectRoot, previewRoot);

  const previousAssumeYes = process.env.NEXTIFY_ASSUME_YES;
  process.env.NEXTIFY_ASSUME_YES = '1';

  try {
    await executeStep(previewRoot);
    const changes = await buildChangeList(projectRoot, previewRoot, filesRoot, placeholdersRoot);

    const manifest = {
      version: 1,
      step: stepName,
      createdAt: new Date().toISOString(),
      reviewRoot: sessionRoot,
      filesRoot,
      placeholdersRoot,
      changes,
    };

    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    return {
      manifest,
      manifestPath,
      sessionRoot,
      firstChange: changes[0] || null,
    };
  } finally {
    if (previousAssumeYes === undefined) {
      delete process.env.NEXTIFY_ASSUME_YES;
    } else {
      process.env.NEXTIFY_ASSUME_YES = previousAssumeYes;
    }
    await fs.remove(previewRoot);
  }
}

async function buildChangeList(projectRoot, previewRoot, filesRoot, placeholdersRoot) {
  const originalFiles = await collectFiles(projectRoot);
  const previewFiles = await collectFiles(previewRoot);
  const relativePaths = [...new Set([...originalFiles.keys(), ...previewFiles.keys()])].sort();
  const changes = [];

  for (const relativePath of relativePaths) {
    const originalPath = originalFiles.get(relativePath);
    const previewPath = previewFiles.get(relativePath);
    const normalizedPath = relativePath.replace(/\\/g, '/');

    if (!originalPath && previewPath) {
      const migratedPath = await copyPreviewArtifact(previewPath, filesRoot, relativePath);
      const emptyBeforePath = await createEmptyPlaceholder(placeholdersRoot, relativePath, 'before');
      changes.push({
        id: normalizedPath,
        type: 'create',
        relativePath: normalizedPath,
        originalPath: path.join(projectRoot, relativePath),
        migratedPath,
        beforePath: emptyBeforePath,
        afterPath: migratedPath,
      });
      continue;
    }

    if (originalPath && !previewPath) {
      const emptyAfterPath = await createEmptyPlaceholder(placeholdersRoot, relativePath, 'after');
      changes.push({
        id: normalizedPath,
        type: 'delete',
        relativePath: normalizedPath,
        originalPath,
        migratedPath: null,
        beforePath: originalPath,
        afterPath: emptyAfterPath,
      });
      continue;
    }

    const [originalBuffer, previewBuffer] = await Promise.all([
      fs.readFile(originalPath),
      fs.readFile(previewPath),
    ]);

    if (originalBuffer.equals(previewBuffer)) {
      continue;
    }

    const migratedPath = await copyPreviewArtifact(previewPath, filesRoot, relativePath);
    changes.push({
      id: normalizedPath,
      type: 'modify',
      relativePath: normalizedPath,
      originalPath,
      migratedPath,
      beforePath: originalPath,
      afterPath: migratedPath,
    });
  }

  return changes;
}

async function collectFiles(rootDir, relativePrefix = '') {
  const files = new Map();

  if (!(await fs.pathExists(rootDir))) {
    return files;
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(rootDir, entry.name);
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;

    if (entry.isDirectory()) {
      const nestedFiles = await collectFiles(absolutePath, relativePath);
      for (const [key, value] of nestedFiles.entries()) {
        files.set(key, value);
      }
      continue;
    }

    if (entry.isFile()) {
      files.set(relativePath, absolutePath);
    }
  }

  return files;
}

async function copyPreviewArtifact(previewPath, filesRoot, relativePath) {
  const migratedPath = path.join(filesRoot, `${relativePath}.migrated`);
  await fs.ensureDir(path.dirname(migratedPath));
  await fs.copy(previewPath, migratedPath, { overwrite: true });
  return migratedPath;
}

async function createEmptyPlaceholder(placeholdersRoot, relativePath, side) {
  const placeholderPath = path.join(placeholdersRoot, `${relativePath}.${side}.empty`);
  await fs.ensureDir(path.dirname(placeholderPath));
  await fs.writeFile(placeholderPath, '', 'utf8');
  return placeholderPath;
}

function getDiffPaths(change) {
  if (change?.diffBeforePath && change?.diffAfterPath) {
    return { beforePath: change.diffBeforePath, afterPath: change.diffAfterPath };
  }
  // backward compatibility for legacy schema
  return { beforePath: change?.beforePath, afterPath: change?.afterPath };
}

function openReviewDiff(change) {
  if (!change) {
    return { opened: false, command: null, reason: 'no-change' };
  }

  const { beforePath, afterPath } = getDiffPaths(change);
  if (!beforePath || !afterPath) {
    return { opened: false, command: null, reason: 'missing-diff-path' };
  }

  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
    return { opened: false, command: null, reason: 'missing-diff-file' };
  }

  const commands = getEditorCommands();

  for (const binary of commands) {
    const result = spawnSync(binary, ['--reuse-window', '--diff', beforePath, afterPath], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      return { opened: true, command: binary };
    }
    if (result?.error?.code === 'ENOENT') {
      continue;
    }
  }

  return { opened: false, command: null, reason: 'open-command-failed' };
}

/**
 * 확장 디렉터리를 직접 스캔해 Nextify Review 확장이 설치된 에디터 종류를 반환합니다.
 * `<editorType>.extensions/<extensionId>-<version>` 폴더 유무로 판별합니다.
 * CLI `--list-extensions` 가 실패하는 환경(VS Code/Cursor 동시 설치, Cursor CLI PATH 미등록 등)의 폴백입니다.
 * @returns {{ found: boolean, editorType?: 'cursor'|'vscode'|'vscode-insiders' }}
 */
function findExtensionInFilesystem(extensionId) {
  const homedir = os.homedir();
  const idLower = extensionId.toLowerCase();
  const candidates = [
    { dir: path.join(homedir, '.cursor', 'extensions'), editorType: 'cursor' },
    { dir: path.join(homedir, '.vscode', 'extensions'), editorType: 'vscode' },
    { dir: path.join(homedir, '.vscode-insiders', 'extensions'), editorType: 'vscode-insiders' },
  ];

  for (const { dir, editorType } of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.some((name) => name.toLowerCase().startsWith(idLower + '-'))) {
      return { found: true, editorType };
    }
  }
  return { found: false };
}

/**
 * 에디터 타입에 맞는 CLI 후보 중 실제로 실행 가능한 첫 번째 바이너리를 반환합니다.
 */
function resolveEditorCommand(editorType) {
  const candidates =
    editorType === 'cursor'
      ? process.platform === 'win32'
        ? ['cursor.cmd', 'cursor']
        : ['cursor']
      : editorType === 'vscode-insiders'
        ? process.platform === 'win32'
          ? ['code-insiders.cmd', 'code-insiders']
          : ['code-insiders']
        : process.platform === 'win32'
          ? ['code.cmd', 'code']
          : ['code'];

  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['--version'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!r.error && r.status === 0) return cmd;
  }
  return candidates[0];
}

function getReviewExtensionStatus() {
  const commands = getEditorCommands();
  let firstEditorCommand = null;

  for (const binary of commands) {
    const result = spawnSync(binary, ['--list-extensions'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });

    if (result?.error?.code === 'ENOENT') {
      continue;
    }

    if (result.error || result.status !== 0) {
      continue;
    }

    if (!firstEditorCommand) {
      firstEditorCommand = binary;
    }

    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean);

    if (extensionListIncludesNextifyReview(lines)) {
      return {
        editorAvailable: true,
        installed: true,
        command: binary,
      };
    }
  }

  // CLI 스캔으로 찾지 못한 경우, 파일시스템을 직접 확인합니다.
  // VS Code와 Cursor가 동시에 설치된 환경에서 code.cmd 가 먼저 성공하고
  // cursor CLI 가 skip 되면 잘못된 command 가 반환되는 문제를 방지합니다.
  const fsResult = findExtensionInFilesystem(REVIEW_EXTENSION_MARKET_ID);
  if (fsResult.found) {
    const resolvedCmd = resolveEditorCommand(fsResult.editorType);
    return {
      editorAvailable: true,
      installed: true,
      command: resolvedCmd,
    };
  }

  if (firstEditorCommand) {
    return {
      editorAvailable: true,
      installed: false,
      command: firstEditorCommand,
      reason: 'extension-not-installed',
    };
  }

  return {
    editorAvailable: false,
    installed: false,
    command: null,
    reason: 'editor-not-found',
  };
}

function focusReviewPanel(extensionStatus = null) {
  const status = extensionStatus || getReviewExtensionStatus();
  if (!status?.installed || !status?.command) {
    return { opened: false, command: status?.command || null, reason: status?.reason || 'extension-not-installed' };
  }

  const result = spawnSync(status.command, ['--reuse-window', '--command', 'nextifyReview.focusPanel'], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (!result.error && result.status === 0) {
    return { opened: true, command: status.command };
  }
  return { opened: false, command: status.command, reason: 'focus-command-failed' };
}

/**
 * @param {string|null|undefined} commandHint `code` / `cursor` 등 에디터 CLI (PATH 상 실행 파일명)
 * @returns {{ installed: boolean, command: string|null, reason?: string, stderr?: string, stdout?: string }}
 */
function installReviewExtension(commandHint) {
  if (!commandHint) {
    return { installed: false, command: null, reason: 'no-command' };
  }

  const result = spawnSync(commandHint, ['--install-extension', REVIEW_EXTENSION_MARKET_ID, '--force'], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
  });

  if (result?.error?.code === 'ENOENT') {
    return { installed: false, command: commandHint, reason: 'ENOENT' };
  }

  if (!result.error && result.status === 0) {
    return { installed: true, command: commandHint };
  }

  return {
    installed: false,
    command: commandHint,
    reason: 'install-failed',
    stderr: String(result?.stderr || ''),
    stdout: String(result?.stdout || ''),
  };
}

async function buildSnapshotChangeList(projectRoot, snapshotRoot, placeholdersRoot) {
  const beforeFiles = await collectFiles(snapshotRoot);
  const afterFiles = await collectFiles(projectRoot);
  const relativePaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
  const changes = [];

  for (const relativePath of relativePaths) {
    const beforePath = beforeFiles.get(relativePath);
    const afterPath = afterFiles.get(relativePath);
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const targetPath = path.join(projectRoot, relativePath);

    if (!beforePath && afterPath) {
      const emptyBeforePath = await createEmptyPlaceholder(placeholdersRoot, relativePath, 'before');
      changes.push({
        id: normalizedPath,
        type: 'create',
        relativePath: normalizedPath,
        targetPath,
        beforeSnapshotPath: null,
        afterPath,
        diffBeforePath: emptyBeforePath,
        diffAfterPath: afterPath,
      });
      continue;
    }

    if (beforePath && !afterPath) {
      const emptyAfterPath = await createEmptyPlaceholder(placeholdersRoot, relativePath, 'after');
      changes.push({
        id: normalizedPath,
        type: 'delete',
        relativePath: normalizedPath,
        targetPath,
        beforeSnapshotPath: beforePath,
        afterPath: null,
        diffBeforePath: beforePath,
        diffAfterPath: emptyAfterPath,
      });
      continue;
    }

    const [beforeBuffer, afterBuffer] = await Promise.all([
      fs.readFile(beforePath),
      fs.readFile(afterPath),
    ]);

    if (beforeBuffer.equals(afterBuffer)) {
      continue;
    }

    changes.push({
      id: normalizedPath,
      type: 'modify',
      relativePath: normalizedPath,
      targetPath,
      beforeSnapshotPath: beforePath,
      afterPath,
      diffBeforePath: beforePath,
      diffAfterPath: afterPath,
    });
  }

  return changes;
}

async function createSnapshotReviewSession(projectRoot, stepName, executeStep) {
  const sessionRoot = path.join(projectRoot, REVIEW_ROOT_DIR, stepName);
  const beforeRoot = path.join(sessionRoot, 'before');
  const placeholdersRoot = path.join(sessionRoot, 'placeholders');
  const manifestPath = path.join(sessionRoot, 'session.json');
  const beforeTempRoot = path.join(os.tmpdir(), `nextify-before-${stepName}-${crypto.randomUUID()}`);

  await fs.remove(sessionRoot);
  await fs.ensureDir(sessionRoot);
  await fs.ensureDir(placeholdersRoot);
  await fs.remove(beforeRoot);
  await fs.ensureDir(beforeRoot);

  // 1) before snapshot
  // NOTE:
  // projectRoot 하위(.ai-migration/...)로 직접 copy하면
  // "Cannot copy ... to a subdirectory of itself" 에러가 발생할 수 있으므로
  // 먼저 OS temp에 복제한 뒤 sessionRoot로 이동합니다.
  await fs.remove(beforeTempRoot);
  await cloneProject(projectRoot, beforeTempRoot);
  await fs.remove(beforeRoot);
  await fs.move(beforeTempRoot, beforeRoot, { overwrite: true });

  // 2) execute step on real workspace
  const previousAssumeYes = process.env.NEXTIFY_ASSUME_YES;
  process.env.NEXTIFY_ASSUME_YES = '1';
  try {
    await executeStep(projectRoot);

    // 3) compute diff between snapshot and current workspace
    const changes = await buildSnapshotChangeList(projectRoot, beforeRoot, placeholdersRoot);

    if (changes.length === 0) {
      await fs.remove(sessionRoot);
      return {
        manifest: {
          version: 1,
          step: stepName,
          createdAt: new Date().toISOString(),
          reviewRoot: sessionRoot,
          changes: [],
        },
        manifestPath: null,
        firstChange: null,
      };
    }

    const manifest = {
      version: 1,
      step: stepName,
      createdAt: new Date().toISOString(),
      reviewRoot: sessionRoot,
      beforeRoot,
      placeholdersRoot,
      changes,
    };

    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    return {
      manifest,
      manifestPath,
      firstChange: changes[0] || null,
    };
  } finally {
    if (previousAssumeYes === undefined) {
      delete process.env.NEXTIFY_ASSUME_YES;
    } else {
      process.env.NEXTIFY_ASSUME_YES = previousAssumeYes;
    }
    await fs.remove(beforeTempRoot);
  }
}

module.exports = {
  REVIEW_ROOT_DIR,
  REVIEW_EXTENSION_MARKET_ID,
  createStepReviewSession,
  createSnapshotReviewSession,
  openReviewDiff,
  getEditorCommands,
  getReviewExtensionStatus,
  focusReviewPanel,
  installReviewExtension,
};
