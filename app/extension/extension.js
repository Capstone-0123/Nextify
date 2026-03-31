const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

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
    this.lastMissingSessionKey = null;
    this.lastFocusedManifestPath = null;

    this.isLoading = false;
    this.refreshInFlight = false;
    this.refreshPending = false;
    this.refreshTimer = null;

    this.scheduleRefresh = this.scheduleRefresh.bind(this);
  }

  attach(context) {
    this.focusPanel = this.focusPanel.bind(this);
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
      vscode.commands.registerCommand('nextifyReview.focusPanel', this.focusPanel),
      vscode.commands.registerCommand('nextifyReview.refreshSession', this.refreshSession),
      vscode.commands.registerCommand('nextifyReview.openChange', this.openChange),
      vscode.commands.registerCommand('nextifyReview.acceptChange', this.acceptChange),
      vscode.commands.registerCommand('nextifyReview.rejectChange', this.rejectChange),
      vscode.commands.registerCommand('nextifyReview.acceptAll', this.acceptAll),
      vscode.commands.registerCommand('nextifyReview.discardSession', this.discardSession),
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/.ai-migration/**/session.json');
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidChange(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
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
    // Refresh 호출이 중첩되면, 마지막 이벤트 1회만 처리하도록 coalesce합니다.
    if (this.refreshInFlight) {
      this.refreshPending = true;
      this.scheduleRefresh();
      return;
    }

    this.refreshInFlight = true;
    this.isLoading = true;
    this.refreshPending = false;
    this.render();
    try {
      const workspaceRoots = getWorkspaceRoots();
      if (workspaceRoots.length === 0) {
        this.session = null;
        this.currentChangeId = null;
        this.lastFocusedManifestPath = null;
        return;
      }

      const manifestPath = await getLatestSessionManifestPath(workspaceRoots);
      if (!manifestPath || !fs.existsSync(manifestPath)) {
        this.session = null;
        this.currentChangeId = null;
        this.lastFocusedManifestPath = null;
        this.notifyMissingSessionOnce(workspaceRoots.join('|'));
        return;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      this.session = { ...manifest, manifestPath };
      this.currentChangeId = this.session.changes[0]?.id || null;
      this.lastMissingSessionKey = null;

      if (this.lastFocusedManifestPath !== manifestPath) {
        this.lastFocusedManifestPath = manifestPath;
        await this.focusPanel({ quiet: true });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Nextify Review 세션을 읽지 못했습니다: ${error.message}`);
      this.session = null;
      this.currentChangeId = null;
    } finally {
      this.isLoading = false;
      this.refreshInFlight = false;
      this.render();

      if (this.refreshPending) {
        this.refreshPending = false;
        this.scheduleRefresh(0);
      }
    }
  }

  scheduleRefresh(delayMs = 250) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // scheduleRefresh는 항상 refreshSession 실행을 목표로 합니다.
      // 중복 호출은 refreshSession 내부 coalesce로 흡수됩니다.
      this.refreshSession().catch(() => {
        // ignore
      });
    }, delayMs);
  }

  async focusPanel(options = {}) {
    try {
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('nextifyReview.panel.focus');
      if (!options.quiet) {
        vscode.window.setStatusBarMessage('Nextify Review 패널로 이동했습니다.', 2500);
      }
    } catch (error) {
      if (!options.quiet) {
        vscode.window.showWarningMessage(`Nextify Review 패널 포커스 실패: ${error.message}`);
      }
    }
  }

  notifyMissingSessionOnce(markerValue) {
    const marker = String(markerValue || '');
    if (this.lastMissingSessionKey === marker) {
      return;
    }
    this.lastMissingSessionKey = marker;
    vscode.window.setStatusBarMessage(
      'Nextify Review: 활성 세션이 없습니다. `migrate-next` 실행 후 패널을 확인하세요.',
      4000,
    );
  }

  async openChange(changeId) {
    const change = this.getChange(changeId);
    if (!change) {
      vscode.window.showInformationMessage('열 수 있는 변경 파일이 없습니다.');
      return;
    }

    this.currentChangeId = change.id;

    const beforePath = change.diffBeforePath || change.beforePath;
    const afterPath = change.diffAfterPath || change.afterPath;
    if (!beforePath || !afterPath) {
      vscode.window.showErrorMessage(`diff 경로를 찾지 못했습니다: ${change.relativePath}`);
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(beforePath),
      vscode.Uri.file(afterPath),
      `Nextify ${this.session?.step || 'review'} Review: ${change.relativePath}`,
    );

    this.render();
  }

  async acceptChange(changeId) {
    const change = this.getChange(changeId);
    if (!change || !this.session) {
      return;
    }

    try {
      // Snapshot schema (new): step already applied to workspace; accept => keep current state.
      // Legacy schema: preview files need to be copied into originalPath.
      if (change.type === 'delete') {
        const targetPath = change.targetPath || change.originalPath;
        if (targetPath && fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { force: true });
        }
      } else if (change.migratedPath && change.originalPath) {
        // legacy create/modify accept
        fs.mkdirSync(path.dirname(change.originalPath), { recursive: true });
        fs.copyFileSync(change.migratedPath, change.originalPath);
      }

      this.removeChange(change.id);
      // NOTE:
      // 현재 step 동안 Gemini follow-up 질문을 위해 before/after 근거 아티팩트를 유지합니다.
      // 개별 파일 아티팩트 cleanup은 step 전환 시점(오케스트레이터)에서 수행합니다.
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
      const isSnapshotSchema = !!(change?.targetPath && change?.diffBeforePath && change?.diffAfterPath);
      // Snapshot schema (new): reject => restore beforeSnapshot to the current workspace.
      // - create: remove the file created by the step
      // - modify/delete: copy snapshot -> targetPath
      if (isSnapshotSchema) {
        if (change.type === 'create') {
          if (change.targetPath && fs.existsSync(change.targetPath)) {
            fs.rmSync(change.targetPath, { force: true });
          }
        } else {
          if (!change.beforeSnapshotPath) {
            throw new Error(`beforeSnapshotPath가 없어 복원할 수 없습니다: ${change.relativePath}`);
          }
          fs.mkdirSync(path.dirname(change.targetPath), { recursive: true });
          fs.copyFileSync(change.beforeSnapshotPath, change.targetPath);
        }
      }

      this.removeChange(change.id);
      // NOTE:
      // 현재 step 동안 Gemini follow-up 질문을 위해 before/after 근거 아티팩트를 유지합니다.
      // 개별 파일 아티팩트 cleanup은 step 전환 시점(오케스트레이터)에서 수행합니다.
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
        // Legacy schema accept
        if (!change.beforeSnapshotPath && change.migratedPath && change.originalPath && change.type !== 'delete') {
          fs.mkdirSync(path.dirname(change.originalPath), { recursive: true });
          fs.copyFileSync(change.migratedPath, change.originalPath);
        }

        // Both schemas: delete accept should ensure the file is removed.
        if (change.type === 'delete') {
          const targetPath = change.targetPath || change.originalPath;
          if (targetPath && fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { force: true });
          }
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

    // Snapshot schema (new): discard => reject all pending changes to restore the original snapshot state.
    // Legacy schema: step already ran in preview clone, so removing reviewRoot is sufficient.
    if (this.session.changes?.some((c) => c.diffBeforePath && c.diffAfterPath)) {
      for (const change of [...this.session.changes]) {
        if (change.type === 'create') {
          if (fs.existsSync(change.targetPath)) {
            fs.rmSync(change.targetPath, { force: true });
          }
        } else {
          fs.mkdirSync(path.dirname(change.targetPath), { recursive: true });
          fs.copyFileSync(change.beforeSnapshotPath, change.targetPath);
        }
        cleanupChangeArtifacts(change, this.session.reviewRoot);
      }
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
    const hasSession = !!this.session;
    const pendingCount = Array.isArray(changes) ? changes.length : 0;

    const sessionMeta = this.isLoading
      ? 'Loading session...'
      : this.session
        ? `Step ${escapeHtml(this.session.step.replace('step', ''))} · ${pendingCount} pending`
        : 'No active .ai-migration session';

    const items = this.isLoading
      ? '<div class="empty">Loading session...</div>'
      : pendingCount
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
        : '<div class="empty">`migrate-next` 실행 후 Nextify Review 패널에서 세션을 확인하세요.</div>';

    const disabled = this.isLoading ? 'disabled' : '';
    const openCurrentDisabled = this.isLoading || !hasSession ? 'disabled' : '';
    const acceptAllDisabled = this.isLoading || !hasSession || pendingCount === 0 ? 'disabled' : '';
    const discardDisabled = this.isLoading || !hasSession ? 'disabled' : '';

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
    button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
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
    <button data-command="refresh" ${disabled}>Refresh</button>
    <button data-command="openChange" data-change-id="${escapeHtml(current?.id || '')}" ${openCurrentDisabled}>
      Open Current
    </button>
  </div>
  <div class="toolbar">
    <button data-command="acceptAll" ${acceptAllDisabled}>Accept All</button>
    <button data-command="discardSession" ${discardDisabled}>Discard Session</button>
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

function getWorkspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function cleanupChangeArtifacts(change, reviewRoot) {
  // Snapshot schema artifacts (within reviewRoot)
  safeRemoveInsideReview(change.beforeSnapshotPath, reviewRoot);
  safeRemoveInsideReview(change.diffBeforePath, reviewRoot);
  safeRemoveInsideReview(change.diffAfterPath, reviewRoot);

  // Legacy schema artifacts (within reviewRoot)
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

async function getLatestSessionManifestPath(workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  if (roots.length === 0) return null;

  // VSCode workspace 범위 전체에서 세션 파일을 직접 검색하면
  // 루트/하위/멀티루트/복사본 경로 케이스를 가장 안정적으로 처리할 수 있습니다.
  const uris = await vscode.workspace.findFiles('**/.ai-migration/**/session.json');
  if (!uris || uris.length === 0) {
    return null;
  }

  let latest = null;
  let latestMtimeMs = -1;
  let latestStepNum = -1;
  for (const uri of uris) {
    try {
      const st = fs.statSync(uri.fsPath);
      const stepNum = extractStepNumberFromManifestPath(uri.fsPath);
      const isBetterStep = stepNum > latestStepNum;
      const isSameStepAndNewer = stepNum === latestStepNum && st.mtimeMs > latestMtimeMs;

      // 우선순위:
      // 1) step 번호가 더 큰 세션
      // 2) step 번호가 같으면 수정시각이 더 최신인 세션
      if (isBetterStep || isSameStepAndNewer) {
        latestStepNum = stepNum;
        latestMtimeMs = st.mtimeMs;
        latest = uri.fsPath;
      }
    } catch {
      // ignore invalid candidate
    }
  }
  return latest;
}

function extractStepNumberFromManifestPath(manifestPath) {
  const normalized = String(manifestPath || '').replace(/\\/g, '/');
  const match = normalized.match(/\/\.ai-migration\/step(\d+)\/session\.json$/i);
  return match ? Number(match[1]) : -1;
}

module.exports = {
  activate,
  deactivate,
};
