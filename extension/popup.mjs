import { deriveView, taskIsVisible, withPendingDraft } from './view-model.mjs';

const byId = (id) => document.getElementById(id);
let port;
let latestState = {};
let currentPrimary;
let currentThumbnail;
let pendingFocus = false;
let connectionAttempts = 0;
let reconnectTimer;
let actionBusy = false;
let pendingDraft = null;

function dispatch(action, payload = {}) {
  try { port?.postMessage({ type: 'action', action, ...payload }); }
  catch { showDisconnected(); }
}

function showDisconnected() {
  render({ ...latestState, connection: { status: 'disconnected', error: { message: '扩展连接已中断，请重新连接。' } } });
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!globalThis.chrome?.runtime?.connect) {
    render({ connection: { status: 'disconnected', error: { message: '请从浏览器工具栏打开已安装的 Fango 插件。' } } });
    return;
  }
  try {
    port = chrome.runtime.connect({ name: 'popup' });
    port.onMessage.addListener((message) => {
      if (message?.type !== 'state') return;
      connectionAttempts = 0;
      actionBusy = false;
      if (taskIsVisible(message.state?.task) ||
          (message.state?.context?.mode === 'manual' && message.state?.context?.input === pendingDraft)) pendingDraft = null;
      render(message.state);
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError prevents an unhandled extension-console diagnostic.
      void chrome.runtime.lastError;
      port = null;
      showDisconnected();
      if (connectionAttempts++ < 3) reconnectTimer = setTimeout(connect, 350 * connectionAttempts);
    });
    dispatch('initialize');
  } catch { showDisconnected(); }
}

function setText(id, value) { byId(id).textContent = value ?? ''; }
function show(id, visible) { byId(id).hidden = !visible; }

function render(state = {}) {
  latestState = state;
  const presented = withPendingDraft(state, pendingDraft);
  const view = deriveView(presented);
  show('main-view', !view.isSettings);
  show('settings-view', view.isSettings);
  show('settings-button', !view.isSettings);
  show('back-button', view.isSettings);
  show('connection', Boolean(view.connectionNotice));
  setText('connection-message', view.connectionNotice);
  byId('connection').classList.toggle('is-error', state.connection?.status === 'disconnected');
  show('help-button', view.showConnectionHelp);

  setText('section-caption', view.task ? '本次下载' : view.showCard ? '准备好，保存到本地' : '保存一段好内容');
  show('empty-state', view.showEmpty);
  setText('empty-title', view.emptyTitle);
  show('video-card', view.showCard);
  setText('video-title', view.title);
  byId('video-title').title = view.title;
  setText('video-meta', view.subtitle);
  if (currentThumbnail !== view.thumbnail) {
    currentThumbnail = view.thumbnail;
    show('thumbnail', false);
    show('cover-placeholder', true);
    if (view.thumbnail) byId('thumbnail').src = view.thumbnail;
    else byId('thumbnail').removeAttribute('src');
  }
  show('input-form', view.showInput);
  const input = byId('video-input');
  // The same DOM node survives every progress/state update. Never replace a
  // draft while the user is typing or moving a caret through a pasted link.
  if (document.activeElement !== input && input.value !== view.input) input.value = view.input;
  input.setAttribute('aria-invalid', String(presented.context?.status === 'error'));
  if (pendingFocus && view.showInput && !view.isSettings) {
    pendingFocus = false;
    input.focus();
  }

  show('task-status', Boolean(view.status));
  setText('status-text', view.status);
  byId('task-status').dataset.tone = view.tone;
  byId('task-status').classList.toggle('is-busy', view.busy);
  const progress = byId('progress-track');
  show('progress-track', view.busy);
  progress.classList.toggle('is-indeterminate', view.progress === null);
  if (view.progress === null) {
    progress.removeAttribute('aria-valuenow');
    byId('progress-fill').style.removeProperty('width');
  } else {
    progress.setAttribute('aria-valuenow', String(view.progress));
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    byId('progress-fill').style.width = `${view.progress}%`;
  }
  setText('progress-label', view.progress === null ? '' : `${view.progress}%`);
  show('background-hint', view.active && view.connected);
  show('saved-file', Boolean(view.actualPath));
  setText('saved-path', view.actualPath);
  byId('saved-path').title = view.actualPath;
  show('notice', Boolean(view.notice));
  setText('notice', view.notice);
  currentPrimary = view.primary;
  show('primary-button', Boolean(view.primary));
  if (view.primary) {
    setText('primary-label', view.primary.label);
    byId('primary-icon').setAttribute('href', `#i-${view.primary.icon || 'download'}`);
    byId('primary-button').disabled = Boolean(view.primary.disabled || actionBusy);
  }
  const secondary = byId('secondary-actions');
  const signature = JSON.stringify(view.secondary);
  if (secondary.dataset.signature !== signature) {
    secondary.dataset.signature = signature;
    secondary.replaceChildren(...view.secondary.map(({ action, label, disabled }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = label;
      button.dataset.action = action;
      button.disabled = Boolean(disabled);
      return button;
    }));
  }
  show('destination', Boolean(view.outputDir) && !view.actualPath);
  setText('destination-path', view.outputDir);
  byId('destination-path').title = view.outputDir;

  setText('directory-path', view.directory || '连接后读取保存位置');
  byId('directory-path').title = view.directory;
  setText('directory-label', view.directoryPending ? '新位置 · 保存后生效' : '当前下载目录');
  byId('choose-directory').disabled = !view.connected || view.choosingDirectory;
  setText('choose-label', view.choosingDirectory ? '正在选择文件夹…' : '选择文件夹');
  byId('save-settings').disabled = !view.connected || view.choosingDirectory || !view.directory;
  setText('settings-hint', view.choosingDirectory ? '请在系统窗口中选择；关闭弹窗也会保留选择结果。' : view.active ? '当前下载仍使用原目录，更改只影响后续任务。' : '选择文件夹后，点击保存。');
  show('settings-notice', Boolean(view.settingsNotice));
  setText('settings-notice', view.settingsNotice);
  byId('settings-notice').dataset.kind = view.settingsNotice === '已保存' ? 'success' : 'other';
  show('settings-reconnect', state.connection?.status === 'disconnected');
}

byId('thumbnail').addEventListener('load', () => { show('thumbnail', true); show('cover-placeholder', false); });
byId('thumbnail').addEventListener('error', () => { show('thumbnail', false); show('cover-placeholder', true); });
byId('video-input').addEventListener('input', (event) => {
  actionBusy = false;
  pendingDraft = event.target.value;
  render(latestState);
  dispatch('editInput', { input: event.target.value });
});
byId('video-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    dispatch('resolveInput');
  }
});
byId('input-form').addEventListener('submit', (event) => { event.preventDefault(); dispatch('resolveInput'); });
byId('primary-button').addEventListener('click', () => {
  if (!currentPrimary || currentPrimary.disabled || actionBusy) return;
  if (currentPrimary.action === 'reconnect' && !port) { connectionAttempts = 0; connect(); return; }
  if (['start', 'retry'].includes(currentPrimary.action)) {
    actionBusy = true;
    byId('primary-button').disabled = true;
  }
  dispatch(currentPrimary.action);
});
byId('secondary-actions').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  if (['changeLink', 'useCurrentPage'].includes(button.dataset.action)) pendingDraft = null;
  if (button.dataset.action === 'changeLink') pendingFocus = true;
  dispatch(button.dataset.action);
});
byId('settings-button').addEventListener('click', () => dispatch('openSettings'));
byId('back-button').addEventListener('click', () => dispatch('back'));
byId('help-button').addEventListener('click', () => dispatch('openHelp'));
byId('choose-directory').addEventListener('click', () => dispatch('chooseDirectory'));
byId('save-settings').addEventListener('click', () => dispatch('saveSettings', { outputDir: latestState.pendingDirectory || latestState.settings?.outputDir }));
byId('settings-reconnect').addEventListener('click', () => { if (port) dispatch('reconnect'); else { connectionAttempts = 0; connect(); } });

render();
connect();
