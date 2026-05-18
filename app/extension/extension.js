const vscode = require('vscode');
const fs = require('fs');

function activate(context) {
  const controller = new NextifyReviewController();
  controller.attach(context);
}

function deactivate() {}

/**
 * @param {Array<{ relativePath: string }>} changes
 */
function buildChangeTreeRoot(changes) {
  const root = { subdirs: new Map(), files: [] };
  for (const change of changes) {
    const parts = String(change.relativePath || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        node.files.push({ name: seg, change });
      } else {
        if (!node.subdirs.has(seg)) {
          node.subdirs.set(seg, { subdirs: new Map(), files: [] });
        }
        node = node.subdirs.get(seg);
      }
    }
  }
  return root;
}

/**
 * @param {{ subdirs: Map, files: Array }} node
 * @param {number} depth
 * @param {string|null|undefined} currentChangeId
 */
function renderTreeContentHtml(node, depth, currentChangeId) {
  const indentPx = 10;
  const pad = depth * indentPx;
  let html = '';

  const dirEntries = [...node.subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [dirName, child] of dirEntries) {
    const inner = renderTreeContentHtml(child, depth + 1, currentChangeId);
    html += `
<details class="tree-dir" open>
  <summary class="tree-summary" style="padding-left:${pad}px">${escapeHtml(dirName)}</summary>
  <div class="tree-children">${inner}</div>
</details>`;
  }

  const fileEntries = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of fileEntries) {
    const c = f.change;
    const id = escapeHtml(c.id);
    const type = escapeHtml(c.type || 'unknown');
    const activeClass = currentChangeId && c.id === currentChangeId ? ' active' : '';
    html += `
<div class="tree-file${activeClass}" style="padding-left:${pad + indentPx}px">
  <button type="button" class="link file-link" data-command="openChange" data-change-id="${id}">${escapeHtml(f.name)}</button>
  <button type="button" class="badge-btn" data-command="openChange" data-change-id="${id}" title="diff 열기">${type}</button>
</div>`;
  }

  return html;
}

class NextifyReviewController {
  constructor() {
    this.view = null;
    this.session = null;
    this.currentChangeId = null;
    this.lastMissingSessionKey = null;
    this.lastNoWorkspaceKey = null;
    this.lastFocusedManifestPath = null;
    /** @type{'no_workspace'|'no_session'|null} */
    this.panelEmptyReason = null;
    this.sessionCandidateCount = 0;

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
    this.copySessionPath = this.copySessionPath.bind(this);
    this.copyBeforePath = this.copyBeforePath.bind(this);
    this.copyAfterPath = this.copyAfterPath.bind(this);

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('nextifyReview.panel', this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('nextifyReview.focusPanel', this.focusPanel),
      vscode.commands.registerCommand('nextifyReview.refreshSession', this.refreshSession),
      vscode.commands.registerCommand('nextifyReview.openChange', this.openChange),
      vscode.commands.registerCommand('nextifyReview.copySessionPath', this.copySessionPath),
      vscode.commands.registerCommand('nextifyReview.copyBeforePath', this.copyBeforePath),
      vscode.commands.registerCommand('nextifyReview.copyAfterPath', this.copyAfterPath),
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
        case 'copySessionPath':
          await this.copySessionPath();
          break;
        case 'copyBeforePath':
          await this.copyBeforePath();
          break;
        case 'copyAfterPath':
          await this.copyAfterPath();
          break;
        default:
          break;
      }
    });

    this.render();
  }

  async refreshSession() {
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
        this.panelEmptyReason = 'no_workspace';
        this.sessionCandidateCount = 0;
        this.notifyNoWorkspaceOnce();
        return;
      }

      this.lastNoWorkspaceKey = null;
      const { manifestPath, totalCandidates } = await pickLatestSessionManifest(workspaceRoots);
      this.sessionCandidateCount = totalCandidates;
      if (!manifestPath || !fs.existsSync(manifestPath)) {
        this.session = null;
        this.currentChangeId = null;
        this.lastFocusedManifestPath = null;
        this.panelEmptyReason = 'no_session';
        this.notifyMissingSessionOnce(workspaceRoots.join('|'));
        return;
      }

      this.panelEmptyReason = null;
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
      this.panelEmptyReason = 'no_session';
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
      'Nextify Review: 활성 세션이 없습니다. 해당 프로젝트 루트에서 migrate-next 실행 후 패널을 새로고침하세요.',
      4000,
    );
  }

  notifyNoWorkspaceOnce() {
    if (this.lastNoWorkspaceKey === 'no-workspace') {
      return;
    }
    this.lastNoWorkspaceKey = 'no-workspace';
    vscode.window.setStatusBarMessage(
      'Nextify Review: 열린 워크스페이스 폴더가 없습니다. 폴더를 연 뒤 다시 확인하세요.',
      5000,
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

  async copySessionPath() {
    const p = this.session?.manifestPath;
    if (!p) {
      vscode.window.showInformationMessage('복사할 세션 경로가 없습니다.');
      return;
    }
    await vscode.env.clipboard.writeText(p);
    vscode.window.setStatusBarMessage('Nextify Review: session.json 경로를 복사했습니다.', 2500);
  }

  async copyBeforePath() {
    const change = this.getChange(this.currentChangeId);
    if (!change) {
      vscode.window.showInformationMessage('선택된 변경 파일이 없습니다.');
      return;
    }
    const beforePath = change.diffBeforePath || change.beforePath;
    if (!beforePath) {
      vscode.window.showInformationMessage(`before 경로가 없습니다: ${change.relativePath}`);
      return;
    }
    await vscode.env.clipboard.writeText(beforePath);
    vscode.window.setStatusBarMessage(`Nextify Review: BEFORE 경로 복사 완료 (${change.relativePath})`, 3000);
  }

  async copyAfterPath() {
    const change = this.getChange(this.currentChangeId);
    if (!change) {
      vscode.window.showInformationMessage('선택된 변경 파일이 없습니다.');
      return;
    }
    const afterPath = change.diffAfterPath || change.afterPath;
    if (!afterPath) {
      vscode.window.showInformationMessage(`after 경로가 없습니다: ${change.relativePath}`);
      return;
    }
    await vscode.env.clipboard.writeText(afterPath);
    vscode.window.setStatusBarMessage(`Nextify Review: AFTER 경로 복사 완료 (${change.relativePath})`, 3000);
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

  render() {
    if (!this.view) {
      return;
    }

    const current = this.getChange(this.currentChangeId);
    const changes = this.session?.changes || [];
    const hasSession = !!this.session;
    const pendingCount = Array.isArray(changes) ? changes.length : 0;

    const sessionMeta = this.isLoading
      ? '세션 불러오는 중…'
      : this.session
        ? `Step ${escapeHtml(String(this.session.step).replace('step', ''))} · ${pendingCount}개 변경(view-only)`
        : this.panelEmptyReason === 'no_workspace'
          ? '열린 워크스페이스 폴더가 없습니다'
          : '활성 .ai-migration 세션이 없습니다';

    const treeRoot = buildChangeTreeRoot(changes);
    const treeHtml = pendingCount
      ? renderTreeContentHtml(treeRoot, 0, current?.id)
      : '';

    let emptyInner;
    if (this.panelEmptyReason === 'no_workspace') {
      emptyInner =
        '워크스페이스에 폴더를 연 뒤(파일 → 폴더 열기), 프로젝트 루트에서 <code>migrate-next</code> 또는 CLI로 생성된 <code>.ai-migration/.../session.json</code>이 보이도록 하세요.';
    } else {
      emptyInner =
        '이 폴더에서 <code>.ai-migration/.../session.json</code>을 찾지 못했습니다. 해당 프로젝트 루트에서 <code>migrate-next</code>를 실행한 뒤 새로고침하세요.';
    }

    const items = this.isLoading
      ? '<div class="empty">세션 불러오는 중…</div>'
      : pendingCount
        ? `<div class="tree-root" role="tree">${treeHtml}</div>`
        : `<div class="empty">${emptyInner}</div>`;

    const multiSessionHint =
      !this.isLoading && this.session && this.sessionCandidateCount > 1
        ? '같은 창에서 <code>session.json</code> 후보가 여러 개면 <strong>step 번호가 가장 큰</strong> 파일을 사용합니다. '
        : '';
    const disabled = this.isLoading ? 'disabled' : '';
    const openCurrentDisabled = this.isLoading || !hasSession || !current ? 'disabled' : '';
    const copyPathDisabled = this.isLoading || !hasSession ? 'disabled' : '';
    const copySelectedPathDisabled = this.isLoading || !hasSession || !current ? 'disabled' : '';

    this.view.webview.html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 10px;
    }
    .toolbar {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr 1fr;
      margin-bottom: 8px;
    }
    .toolbar-row2 {
      grid-template-columns: 1fr;
    }
    .summary {
      font-size: 12px;
      margin-bottom: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .hint {
      font-size: 11px;
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
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
      font-size: inherit;
      font-family: inherit;
    }
    button.file-link {
      margin-right: 8px;
    }
    .tree-root {
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      padding: 4px 0;
      max-height: 70vh;
      overflow: auto;
    }
    details.tree-dir {
      margin: 0;
    }
    summary.tree-summary {
      cursor: pointer;
      list-style: none;
      font-weight: 500;
      padding: 2px 4px;
      user-select: none;
    }
    summary.tree-summary::-webkit-details-marker {
      display: none;
    }
    summary.tree-summary::before {
      content: '▾ ';
      opacity: 0.7;
      font-size: 10px;
    }
    details.tree-dir:not([open]) > summary.tree-summary::before {
      content: '▸ ';
    }
    .tree-children {
      margin: 0;
    }
    .tree-file {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px 8px;
      padding: 3px 4px;
      border-radius: 4px;
    }
    .tree-file:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-file.active {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    button.badge-btn {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      border: 0;
      cursor: pointer;
    }
    button.badge-btn:hover {
      filter: brightness(1.08);
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
    <button type="button" data-command="refresh" ${disabled}>Refresh</button>
    <button type="button" data-command="openChange" data-change-id="${escapeHtml(current?.id || '')}" ${openCurrentDisabled}>
      Open diff (selected)
    </button>
  </div>
  <div class="toolbar toolbar-row2">
    <button type="button" data-command="copySessionPath" ${copyPathDisabled}>Copy session.json path</button>
  </div>
  <div class="toolbar">
    <button type="button" data-command="copyBeforePath" ${copySelectedPathDisabled}>Copy BEFORE path</button>
    <button type="button" data-command="copyAfterPath" ${copySelectedPathDisabled}>Copy AFTER path</button>
  </div>
  <div class="summary">${sessionMeta}</div>
  <div class="hint">${multiSessionHint}폴더를 펼쳐 파일을 선택한 다음 path 복사 버튼을 누르세요. Gemini CLI에는 <code>@복사한경로</code> 형태로 붙여 넣으면 됩니다.</div>
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function pickLatestSessionManifest(workspaceRoots) {
  const roots = Array.isArray(workspaceRoots) ? workspaceRoots : [];
  if (roots.length === 0) {
    return { manifestPath: null, totalCandidates: 0 };
  }

  // null 을 두 번째 인수로 전달하면 files.exclude 설정을 무시합니다.
  // 이전 버전 watcher-friendly.cjs 가 .ai-migration 을 files.exclude 에 추가한
  // 프로젝트에서도 session.json 을 정상적으로 발견할 수 있습니다.
  const uris = await vscode.workspace.findFiles('**/.ai-migration/**/session.json', null);
  if (!uris || uris.length === 0) {
    return { manifestPath: null, totalCandidates: 0 };
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

      if (isBetterStep || isSameStepAndNewer) {
        latestStepNum = stepNum;
        latestMtimeMs = st.mtimeMs;
        latest = uri.fsPath;
      }
    } catch {
      // ignore invalid candidate
    }
  }
  return { manifestPath: latest, totalCandidates: uris.length };
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
