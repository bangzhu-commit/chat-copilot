// Presentation helpers. Conversation data and model requests stay in app.js.
const suggestionViews = new Map();
let welcomeSceneChosen = false;
let activePopover = '';

function readPreference(key) {
  try { return localStorage.getItem(`chat-copilot:${key}`); } catch (_) { return null; }
}

function savePreference(key, value) {
  try { localStorage.setItem(`chat-copilot:${key}`, value); } catch (_) {}
}

function uiIcon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="icons.svg#${name}"/></svg>`;
}

function initializeWorkbench() {
  const savedScene = readPreference('scene');
  if (Array.from($sceneMode.options).some(option => option.value === savedScene)) {
    $sceneMode.value = savedScene;
    welcomeSceneChosen = true;
  }
  deepModeEnabled = readPreference('auto-deep') === 'true';
  setReadingSize(readPreference('font-size') || 'standard');
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.popover, #settingsToggle, #moreToggle')) closePopovers();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activePopover) closePopovers(true);
  });
}

function chooseScene(mode) {
  $sceneMode.value = mode;
  welcomeSceneChosen = true;
  savePreference('scene', mode);
  onSceneModeChange();
  const dialog = document.getElementById('sceneDialog');
  if (dialog.open) dialog.close();
}

function sceneButtons(container, limit = Infinity) {
  const icons = ['mic', 'interview', 'users', 'briefcase', 'handshake', 'coffee', 'award', 'video', 'book', 'settings'];
  Array.from($sceneMode.options).slice(0, limit).forEach((option, index) => {
    const button = document.createElement('button');
    button.className = 'scene-option';
    button.innerHTML = uiIcon(icons[index]);
    const label = document.createElement('span');
    label.textContent = option.textContent;
    button.appendChild(label);
    button.onclick = () => chooseScene(option.value);
    container.appendChild(button);
  });
}

function showScenePicker() {
  const container = document.getElementById('sceneDialogOptions');
  container.replaceChildren();
  sceneButtons(container);
  document.getElementById('sceneDialog').showModal();
}

function renderWelcome() {
  if (suggestionGroups.length || isRecording) return;
  const empty = $suggestionsContainer.querySelector('.empty-state');
  if (!empty) return;
  empty.className = 'empty-state welcome';
  empty.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = welcomeSceneChosen ? getSceneLabel() : '这次要聊什么？';
  empty.appendChild(heading);
  if (!welcomeSceneChosen) {
    const grid = document.createElement('div');
    grid.className = 'scene-grid';
    sceneButtons(grid, 6);
    empty.appendChild(grid);
    const more = document.createElement('button');
    more.className = 'welcome-more';
    more.textContent = '更多场景';
    more.onclick = showScenePicker;
    empty.appendChild(more);
  } else {
    const material = document.createElement('p');
    material.className = 'welcome-subtitle';
    material.textContent = scriptMeta ? `背景资料：${scriptMeta.filename}` : '背景资料（可选）';
    empty.appendChild(material);
    const actions = document.createElement('div');
    actions.className = 'welcome-actions';
    const upload = document.createElement('button');
    upload.className = 'btn';
    upload.innerHTML = `${uiIcon('upload')}上传资料`;
    upload.onclick = () => document.getElementById('fileInput').click();
    const start = document.createElement('button');
    start.className = 'btn btn-primary';
    start.textContent = '开始对话';
    start.onclick = toggleRecording;
    actions.append(upload, start);
    empty.appendChild(actions);
  }
}

function toggleWorkbenchPopover(name) {
  const opening = activePopover !== name;
  closePopovers();
  if (!opening) return;
  activePopover = name;
  document.getElementById(`${name}Panel`).hidden = false;
  document.getElementById(`${name}Toggle`).setAttribute('aria-expanded', 'true');
  document.getElementById(`${name}Panel`).querySelector('button, select')?.focus();
}

function closePopovers(restoreFocus = false) {
  const previous = activePopover;
  ['settings', 'more'].forEach(name => {
    document.getElementById(`${name}Panel`).hidden = true;
    document.getElementById(`${name}Toggle`).setAttribute('aria-expanded', 'false');
  });
  activePopover = '';
  if (restoreFocus && previous) document.getElementById(`${previous}Toggle`).focus();
}

function setReadingSize(value) {
  const size = value === 'large' ? 'large' : 'standard';
  document.body.classList.toggle('large-text', size === 'large');
  document.getElementById('fontSize').value = size;
  savePreference('font-size', size);
}

function updateModelDisplay() {
  const models = appConfig.models || {};
  ['fast', 'deep', 'recap'].forEach(task => {
    document.getElementById(`${task}Model`).textContent = models[task] || appConfig.model || '未配置';
  });
  document.getElementById('modelSummary').textContent = `出题 ${models.fast || appConfig.model || '未配置'} · 深度 ${models.deep || appConfig.model || '未配置'}`;
}

function updateWorkbenchState() {
  document.getElementById('elapsedTime').hidden = !isRecording && !startTime;
  document.getElementById('actionState').textContent = isRecording ? '对话进行中' : '待命';
  $audioSource.disabled = isRecording || $btnToggle.disabled;
  if (isRecording) {
    closePopovers();
    const empty = $suggestionsContainer.querySelector('.empty-state');
    if (empty) {
      empty.className = 'empty-state';
      empty.innerHTML = '<p>等待对话内容</p>';
    }
  }
}

function attachCardActions(card, item, register = true) {
  if (register) suggestionViews.set(item, card);
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const used = document.createElement('button');
  used.className = 'card-action';
  used.innerHTML = uiIcon('check');
  used.title = item.used ? '标记未用' : '标记已用';
  used.setAttribute('aria-label', used.title);
  used.setAttribute('aria-pressed', String(Boolean(item.used)));
  used.onclick = () => {
    item.used = !item.used;
    updateQuestionLedgerUsage(item);
    syncSuggestionViews(item);
  };
  const pin = document.createElement('button');
  pin.className = 'card-action';
  pin.innerHTML = uiIcon(item.pinned ? 'unpin' : 'pin');
  pin.title = item.pinned ? '取消置顶' : '置顶问题';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(Boolean(item.pinned)));
  pin.onclick = () => { item.pinned = !item.pinned; syncSuggestionViews(item); };
  actions.append(used, pin);
  card.appendChild(actions);
  card.classList.toggle('used', Boolean(item.used));
}

function syncSuggestionViews(item) {
  const card = suggestionViews.get(item);
  if (card) {
    card.querySelector('.card-actions')?.remove();
    attachCardActions(card, item, false);
  }
  renderPinnedSuggestions();
}

function renderPinnedSuggestions() {
  const container = document.getElementById('pinnedSuggestions');
  const items = suggestionGroups.flatMap(group => group.items).filter(item => item.pinned);
  container.replaceChildren();
  container.hidden = items.length === 0;
  const count = document.getElementById('pinnedCount');
  count.hidden = items.length === 0;
  count.textContent = `置顶 ${items.length}`;
  if (!items.length) return;
  const heading = document.createElement('p');
  heading.textContent = `已置顶 · ${items.length}`;
  container.appendChild(heading);
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    const text = document.createElement('div');
    text.className = 'suggestion-text';
    text.textContent = item.text || item.question;
    card.appendChild(text);
    attachCardActions(card, item, false);
    container.appendChild(card);
  });
}

function updateTranscriptRoleStyle(turn) {
  if (!turn.element) return;
  turn.element.dataset.role = /主持|采访|面试官|我方|评委/.test(speakerRoleMap[turn.speakerId] || '') ? 'host' : 'guest';
}
