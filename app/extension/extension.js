const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SESSION_RELATIVE_PATH = path.join('.ai-migration', 'step1', 'session.json');

function activate(context) {
  const controller = new NextifyReviewController();
  controller.attach(context);
}

function deactivate() {}

class NextifyReviewController {
  constructor() {
    this.view = null;
    this.session = null;
    this.currentChangeId = null;
  }

  attach(context) {
    this.refreshSession = this.refreshSession.bind(this);
    this.openChange = this.openChange.bind(this);
    this.acceptChange = this.acceptChange.bind(this);
    this.rejectChange = this.rejectChange.bind(this);
    this.acceptAll = this.acceptAll.bind(this);
    this.discardSession = this.discardSession.bind(this);

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('nextifyReview.panel', this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('nextifyReview.refreshSession', this.refreshSession),
      vscode.commands.registerCommand('nextifyReview.openChange', this.openChange),
      vscode.commands.registerCommand('nextifyReview.acceptChange', this.acceptChange),
      vscode.commands.registerCommand('nextifyReview.rejectChange', this.rejectChange),
      vscode.commands.registerCommand('nextifyReview.acceptAll', this.acceptAll),
      vscode.commands.registerCommand('nextifyReview.discardSession', this.discardSession),
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/.ai-migration/**/session.json');
    watcher.onDidCreate(() => this.refreshSession());
    watcher.onDidChange(() => this.refreshSession());
    watcher.onDidDelete(() => this.refreshSession());
    context.subscriptions.push(watcher);

    this.refreshSession();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'refresh':
          await this.refreshSession();
          break;
        case 'openChange':
          await this.openChange(message.changeId);
          break;
        case 'acceptChange':
          await this.acceptChange(message.changeId);
          break;
        case 'rejectChange':
          await this.rejectChange(message.changeId);
          break;
        case 'acceptAll':
          await this.acceptAll();
          break;
        case 'discardSession':
          await this.discardSession();
          break;
        default:
          break;
      }
    });

    this.render();
  }

  async refreshSession() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.session = null;
      this.currentChangeId = null;
      this.render();
      return;
    }

    const manifestPath = path.join(workspaceRoot, SESSION_RELATIVE_PATH);
    if (!fs.existsSync(manifestPath)) {
      this.session = null;
      this.currentChangeId = null;
      this.render();
      return;
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      this.session = { ...manifest, manifestPath };
      this.currentChangeId = this.session.changes[0]?.id || null;
    } catch (error) {
      vscode.window.showErrorMessage(`Nextify Review 세션을 읽지 못했습니다: ${error.message}`);
      this.session = null;
      this.currentChangeId = null;
    }

    this.render();
  }

  async openChange(changeId) {
    const change = this.getChange(changeId);
    if (!change) {
      vscode.window.showInformationMessage('열 수 있는 변경 파일이 없습니다.');
      return;
    }

    this.currentChangeId = change.id;

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(change.beforePath),
      vscode.Uri.file(change.afterPath),
      `Nextify Step 1 Review: ${change.relativePath}`,
    );

    this.render();
  }

  async acceptChange(changeId) {
    const change = this.getChange(changeId);
    if (!change || !this.session) {
      return;
    }

    try {
      if (change.type === 'delete') {
        if (fs.existsSync(change.originalPath)) {
          fs.rmSync(change.originalPath, { force: true });
        }
      } else {
        fs.mkdirSync(path.dirname(change.originalPath), { recursive: true });
        fs.copyFileSync(change.migratedPath, change.originalPath);
      }

      this.removeChange(change.id);
      cleanupChangeArtifacts(change, this.session.reviewRoot);
      this.persistOrCleanupSession();
      vscode.window.setStatusBarMessage(`Nextify Review: ${change.relativePath} 적용 완료`, 2500);
      await this.openFirstPendingChange();
    } catch (error) {
      vscode.window.showErrorMessage(`변경 적용 실패: ${error.message}`);
    }
  }

  async rejectChange(changeId) {
    const change = this.getChange(changeId);
    if (!change || !this.session) {
      return;
    }

    try {
      this.removeChange(change.id);
      cleanupChangeArtifacts(change, this.session.reviewRoot);
      this.persistOrCleanupSession();
      vscode.window.setStatusBarMessage(`Nextify Review: ${change.relativePath} 변경을 유지하지 않았습니다.`, 2500);
      await this.openFirstPendingChange();
    } catch (error) {
      vscode.window.showErrorMessage(`변경 제외 실패: ${error.message}`);
    }
  }

  async acceptAll() {
    if (!this.session || this.session.changes.length === 0) {
      vscode.window.showInformationMessage('적용할 변경이 없습니다.');
      return;
    }

    try {
      for (const change of [...this.session.changes]) {
        if (change.type === 'delete') {
          if (fs.existsSync(change.originalPath)) {
            fs.rmSync(change.originalPath, { force: true });
          }
        } else {
          fs.mkdirSync(path.dirname(change.originalPath), { recursive: true });
          fs.copyFileSync(change.migratedPath, change.originalPath);
        }
        cleanupChangeArtifacts(change, this.session.reviewRoot);
      }

      const reviewRoot = this.session.reviewRoot;
      removeDirectory(reviewRoot);
      this.session = null;
      this.currentChangeId = null;
      this.render();
      vscode.window.showInformationMessage('Nextify Review 변경을 모두 적용했습니다.');
    } catch (error) {
      vscode.window.showErrorMessage(`전체 적용 실패: ${error.message}`);
    }
  }

  async discardSession() {
    if (!this.session) {
      return;
    }

    removeDirectory(this.session.reviewRoot);
    this.session = null;
    this.currentChangeId = null;
    this.render();
    vscode.window.showInformationMessage('Nextify Review 세션을 삭제했습니다.');
  }

  async openFirstPendingChange() {
    if (!this.session || this.session.changes.length === 0) {
      this.render();
      return;
    }

    this.currentChangeId = this.session.changes[0].id;
    await this.openChange(this.currentChangeId);
  }

  getChange(changeId) {
    if (!this.session) {
      return null;
    }

    const targetId = changeId || this.currentChangeId;
    if (!targetId) {
      return this.session.changes[0] || null;
    }

    return this.session.changes.find((change) => change.id === targetId) || null;
  }

  removeChange(changeId) {
    if (!this.session) {
      return;
    }

    this.session.changes = this.session.changes.filter((change) => change.id !== changeId);
    this.currentChangeId = this.session.changes[0]?.id || null;
  }

  persistOrCleanupSession() {
    if (!this.session) {
      return;
    }

    if (this.session.changes.length === 0) {
      removeDirectory(this.session.reviewRoot);
      this.session = null;
      this.currentChangeId = null;
      this.render();
      vscode.window.showInformationMessage('모든 리뷰 항목이 처리되어 .ai-migration 세션을 정리했습니다.');
      return;
    }

    const nextManifest = {
      version: this.session.version,
      step: this.session.step,
      createdAt: this.session.createdAt,
      reviewRoot: this.session.reviewRoot,
      filesRoot: this.session.filesRoot,
      placeholdersRoot: this.session.placeholdersRoot,
      changes: this.session.changes,
    };

    fs.writeFileSync(this.session.manifestPath, JSON.stringify(nextManifest, null, 2));
    this.render();
  }

  render() {
    if (!this.view) {
      return;
    }

    const current = this.getChange(this.currentChangeId);
    const changes = this.session?.changes || [];
    const sessionMeta = this.session
      ? `Step ${escapeHtml(this.session.step.replace('step', ''))} · ${changes.length} pending`
      : 'No active .ai-migration session';

    const items = changes.length
      ? changes
          .map((change) => {
            const activeClass = current?.id === change.id ? 'change active' : 'change';
            return `
              <div class="${activeClass}">
                <button class="link" data-command="openChange" data-change-id="${escapeHtml(change.id)}">
                  ${escapeHtml(change.relativePath)}
                </button>
                <div class="badges">
                  <span class="badge">${escapeHtml(change.type)}</span>
                </div>
                <div class="row">
                  <button data-command="acceptChange" data-change-id="${escapeHtml(change.id)}">Accept</button>
                  <button data-command="rejectChange" data-change-id="${escapeHtml(change.id)}">Reject</button>
                </div>
              </div>
            `;
          })
          .join('')
      : '<div class="empty">`migrate-next step1 --review` 실행 후 세션이 여기에 표시됩니다.</div>';

    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 10px;
    }
    .toolbar, .row {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr 1fr;
      margin-bottom: 8px;
    }
    .summary {
      font-size: 12px;
      margin-bottom: 12px;
      color: var(--vscode-descriptionForeground);
    }
    button {
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    button.link {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      border: 0;
      padding: 0;
      text-align: left;
    }
    .change {
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
    }
    .change.active {
      border-color: var(--vscode-focusBorder);
    }
    .badge {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 11px;
      margin: 6px 0 8px;
    }
    .empty {
      border: 1px dashed var(--vscode-editorWidget-border, transparent);
      border-radius: 6px;
      padding: 12px 8px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button data-command="refresh">Refresh</button>
    <button data-command="openChange" data-change-id="${escapeHtml(current?.id || '')}">Open Current</button>
  </div>
  <div class="toolbar">
    <button data-command="acceptAll">Accept All</button>
    <button data-command="discardSession">Discard Session</button>
  </div>
  <div class="summary">${sessionMeta}</div>
  ${items}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({
          type: button.dataset.command,
          changeId: button.dataset.changeId,
        });
      });
    });
  </script>
</body>
</html>`;
  }
}

function getWorkspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function cleanupChangeArtifacts(change, reviewRoot) {
  safeRemoveInsideReview(change.migratedPath, reviewRoot);
  safeRemoveInsideReview(change.beforePath, reviewRoot);
  safeRemoveInsideReview(change.afterPath, reviewRoot);
}

function safeRemoveInsideReview(targetPath, reviewRoot) {
  if (!targetPath || !reviewRoot) {
    return;
  }

  const resolvedReviewRoot = path.resolve(reviewRoot);
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedTarget.startsWith(resolvedReviewRoot)) {
    return;
  }

  if (fs.existsSync(resolvedTarget)) {
    fs.rmSync(resolvedTarget, { force: true, recursive: false });
  }
}

function removeDirectory(directoryPath) {
  if (directoryPath && fs.existsSync(directoryPath)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  activate,
  deactivate,
};
