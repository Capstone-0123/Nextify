const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { cloneProject } = require('./copy.cjs');

const REVIEW_ROOT_DIR = '.ai-migration';
const EXCLUDED_DIRS = new Set(['.git', '.next', 'dist', 'node_modules', REVIEW_ROOT_DIR]);

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

function openReviewDiff(change) {
  if (!change) {
    return { opened: false, command: null };
  }

  const commands = ['code', 'cursor'];

  for (const binary of commands) {
    const result = spawnSync(binary, ['--diff', change.beforePath, change.afterPath], {
      shell: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      return { opened: true, command: binary };
    }
  }

  return { opened: false, command: null };
}

module.exports = {
  REVIEW_ROOT_DIR,
  createStepReviewSession,
  openReviewDiff,
};
