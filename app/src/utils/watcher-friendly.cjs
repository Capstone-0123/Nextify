'use strict';

// app/src/utils/watcher-friendly.cjs
// 마이그레이션 대상 프로젝트의 .vscode/settings.json에 워처-친화 설정을 보강합니다.
// - 매 단계마다 .ai-migration/stepN/before/ 등 풀 프로젝트 스냅샷이 누적되면
//   VS Code/Cursor의 파일 워처가 Windows의 동시 파일 핸들 한도(EMFILE)에 걸려
//   "EMFILE: too many open files" 무한 루프가 디버그 콘솔에 흐릅니다.
// - 이 유틸은 마이그레이션 시작 시점(Step1)에 1회 실행되어
//   `.ai-migration/`, `node_modules/`, `.next/`, `dist/` 등을 워처/검색에서 제외하도록
//   사용자 의도를 보존하면서 병합 추가합니다.

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

const SETTINGS_REL_PATH = path.join('.vscode', 'settings.json');

const WATCHER_EXCLUDES = {
  '**/.git/objects/**': true,
  '**/.git/subtree-cache/**': true,
  '**/node_modules/**': true,
  '**/.next/**': true,
  '**/dist/**': true,
  // .ai-migration/stepN/before|files|placeholders 는 프로젝트 전체 복사본 —
  // 이 세 폴더만 워처에서 제외해 EMFILE 를 방지합니다.
  // session.json 이 위치한 .ai-migration/stepN/ 직속은 제외하지 않습니다.
  '**/.ai-migration/*/before/**': true,
  '**/.ai-migration/*/files/**': true,
  '**/.ai-migration/*/placeholders/**': true,
};

const SEARCH_EXCLUDES = {
  '**/.ai-migration/*/before/**': true,
  '**/.ai-migration/*/files/**': true,
  '**/.ai-migration/*/placeholders/**': true,
  '**/node_modules/**': true,
  '**/.next/**': true,
  '**/dist/**': true,
};

// files.exclude 에 .ai-migration 을 추가하지 않습니다.
// files.exclude 는 vscode.workspace.findFiles() 에서도 적용되기 때문에
// 추가하면 Nextify Review 확장이 session.json 을 찾지 못합니다.
const FILES_EXCLUDES = {};

/**
 * JSON with comments에 가까운 VS Code settings.json을 안전하게 파싱.
 * - JSONC 트레일링 콤마/주석은 보존하지 못함. 일반 JSON으로 파싱이 실패하면 보강 시도하지 않고 종료.
 */
function safeReadJsonFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return null; // 파싱 불가 시 null
  }
}

function mergeFlat(target, source) {
  let modified = false;
  for (const [k, v] of Object.entries(source)) {
    if (target[k] !== v) {
      target[k] = v;
      modified = true;
    }
  }
  return modified;
}

/**
 * 마이그레이션 대상 프로젝트의 .vscode/settings.json에
 * files.watcherExclude / files.exclude / search.exclude 항목을 병합.
 * - 기존 사용자 설정은 그대로 보존. 키 충돌은 우리 값으로 덮지 않고 누락된 키만 추가.
 * - JSONC(주석/트레일링 콤마)인 경우 파싱 실패 시 변경하지 않고 안내 메시지만 출력.
 * @param {string} projectRoot
 * @returns {Promise<{ written: boolean, reason?: string }>}
 */
async function ensureWatcherFriendlySettings(projectRoot) {
  const vscodeDir = path.join(projectRoot, '.vscode');
  const settingsPath = path.join(projectRoot, SETTINGS_REL_PATH);

  try {
    await fs.ensureDir(vscodeDir);
  } catch {
    return { written: false, reason: 'cannot_create_vscode_dir' };
  }

  let settings;
  if (fs.existsSync(settingsPath)) {
    settings = safeReadJsonFile(settingsPath);
    if (settings === null) {
      // JSONC 등으로 파싱이 안 되면 사용자 파일을 망치지 않도록 보존하고 안내만.
      console.log(
        chalk.yellow(
          `   ⚠️  .vscode/settings.json 파싱 실패 — 워처 제외 설정 자동 추가를 건너뜁니다.\n` +
            `      EMFILE 로그가 거슬리면 직접 다음 키를 추가하세요:\n` +
            `      "files.watcherExclude": { "**/.ai-migration/*/before/**": true, "**/.ai-migration/*/files/**": true, "**/.ai-migration/*/placeholders/**": true, "**/node_modules/**": true, "**/.next/**": true, "**/dist/**": true }`
        )
      );
      return { written: false, reason: 'parse_failed' };
    }
  } else {
    settings = {};
  }

  // 누락된 키만 추가하는 안전 병합
  function ensureSubObject(key, defaults) {
    if (!settings[key] || typeof settings[key] !== 'object') {
      settings[key] = {};
    }
    let changed = false;
    for (const [k, v] of Object.entries(defaults)) {
      if (settings[key][k] === undefined) {
        settings[key][k] = v;
        changed = true;
      }
    }
    return changed;
  }

  let modified = false;
  modified = ensureSubObject('files.watcherExclude', WATCHER_EXCLUDES) || modified;
  modified = ensureSubObject('files.exclude', FILES_EXCLUDES) || modified;
  modified = ensureSubObject('search.exclude', SEARCH_EXCLUDES) || modified;

  if (!modified) {
    return { written: false, reason: 'already_configured' };
  }

  try {
    await fs.writeJson(settingsPath, settings, { spaces: 2 });
    console.log(
      chalk.gray(
        `   📝 ${path.relative(projectRoot, settingsPath).split(path.sep).join('/')}에 워처 제외 설정을 보강했습니다 (.ai-migration/, node_modules/ 등).`
      )
    );
    return { written: true };
  } catch (writeErr) {
    console.log(
      chalk.gray(
        `   ⚠️  .vscode/settings.json 쓰기 실패 — 무시하고 계속합니다: ${writeErr?.message || writeErr}`
      )
    );
    return { written: false, reason: 'write_failed' };
  }
}

module.exports = {
  ensureWatcherFriendlySettings,
};
