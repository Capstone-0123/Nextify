// src/utils/backup.cjs
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

const BACKUP_DIR = path.join(process.cwd(), '.nextify-backup');

// Step 1에서 수정하거나 삭제하는 파일 목록
const TARGET_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  '.gitignore',
  'index.html', // (혹시 건드린다면)
  'src/vite-env.d.ts',
  'src/vite-env.d.mts',
];

// Step 1에서 새로 생성하는 파일 목록 (롤백 시 삭제해야 함)
const NEW_FILES = ['next.config.mjs', 'next-env.d.ts'];

/**
 * 1. 현재 상태 백업
 */
async function backupFiles(cwd) {
  await fs.ensureDir(BACKUP_DIR);

  for (const file of TARGET_FILES) {
    const srcPath = path.join(cwd, file);
    const destPath = path.join(BACKUP_DIR, file);

    // 파일이 존재할 때만 백업
    if (fs.existsSync(srcPath)) {
      await fs.copy(srcPath, destPath);
    }
  }
}

/**
 * 2. 롤백 (원상복구)
 */
async function rollbackFiles(cwd) {
  // 2-1. 백업된 파일 원복
  if (fs.existsSync(BACKUP_DIR)) {
    const backupFiles = await fs.readdir(BACKUP_DIR);
    for (const file of backupFiles) {
      await fs.copy(path.join(BACKUP_DIR, file), path.join(cwd, file));
    }
  }

  // 2-2. 새로 생성된 파일 삭제
  for (const file of NEW_FILES) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) {
      await fs.remove(filePath);
    }
  }

  // 2-3. 백업 폴더 삭제
  await fs.remove(BACKUP_DIR);
  console.log(chalk.red('\n↺ 변경 사항이 취소되었습니다. (롤백 완료)'));
}

/**
 * 3. 확정 (백업 폴더 정리)
 */
async function clearBackup() {
  await fs.remove(BACKUP_DIR);
}

module.exports = { backupFiles, rollbackFiles, clearBackup };
