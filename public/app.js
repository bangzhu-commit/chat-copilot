// ══════════════════════════════════════════════════════════
//  把天聊下去 · 前端逻辑（豆包 Seed-ASR 2.0 版）
// ══════════════════════════════════════════════════════════

// ── 状态 ──────────────────────────────────────────────────
let isRecording = false;
let autoScroll = true;
let startTime = null;
let timerInterval = null;

// ASR 相关
let asrWs = null;           // 与后端的 WebSocket 连接
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let lastFinalText = '';      // 上一次 definite 文本（用于去重）
let interimTranscriptLine = null;

// 对话数据
let fullTranscript = '';         // 全量转写文本
let newTextSinceLastTrigger = ''; // 上次触发后的新增文本
let suggestionCount = 0;
let speakerOrder = [];
let speakerLabelMap = {};
let speakerRoleMap = {};
let speakerRoleSource = {};
let transcriptTurns = [];
let suggestionGroups = [];
let questionLedger = [];
let questionLedgerCounter = 0;
let exportGroupCounter = 0;
let recentTurnKeys = new Map();
let turnCounter = 0;
let deepModeEnabled = false;
let speakerRounds = [];
let openSpeakerRound = null;
let lastCompletedRound = null;
let deepGeneratedRoundIds = new Set();
let deepTurnTimer = null;
let deepRoundCounter = 0;
let isGeneratingDeep = false;
let lastDeepTriggerTime = 0;
let conversationMemory = '';
let memoryTurnCursor = 0;
let isMemoryGenerating = false;
let memoryRetryAfter = 0;
let conversationMemoryScene = '';
let sessionStartedAt = null;
let sessionEndedAt = null;
let exportPromptedForSession = false;
let stopExportPromptTimer = null;
let isExporting = false;

// 上传资料内容
let scriptContent = '';
let scriptMeta = null;

const SCENE_UI = {
  'sales-negotiation': {
    label: 'Deal',
    title: 'AI 实时洞察',
    emptyTitle: '等待销售洞察',
    emptyHint: '可识别事实、风险、推荐动作和谈判提醒'
  },
  'candidate-interview': {
    label: 'Answer',
    title: 'AI 回答提示',
    emptyTitle: '等待回答提示',
    emptyHint: '可识别问题意图、回答结构、可用素材和风险'
  },
  'dating': {
    label: 'Date',
    title: 'AI 聊天提示',
    emptyTitle: '等待相亲聊天提示',
    emptyHint: '可生成破冰、共鸣、追问、转场和边界提醒'
  },
  'ai-judge': {
    label: 'Judge',
    title: 'AI 评审观察',
    emptyTitle: '等待评审观察',
    emptyHint: '可整理证据、疑点、追问、风险和亮点'
  },
  default: {
    label: 'Cue',
    title: 'AI 追问建议',
    emptyTitle: '等待追问建议',
    emptyHint: '有对话内容后可自动生成，也可手动触发'
  }
};

const SCENE_ROLE_PRESETS = {
  'live-host': ['嘉宾', '主持人'],
  'interview': ['受访者', '采访者'],
  'recruitment': ['候选人', '面试官'],
  'candidate-interview': ['面试官', '候选人'],
  'sales-negotiation': ['客户', '我方'],
  'dating': ['对方', '自己'],
  'ai-judge': ['选手', '评委'],
  'recording': ['讲述者', '协作者'],
  'training': ['讲师', '学员'],
  default: ['说话人 A', '说话人 B']
};

const DEEP_SUPPORTED_SCENES = new Set([
  'live-host',
  'interview',
  'ai-judge',
  'sales-negotiation',
  'recruitment'
]);
const DEEP_TURN_SILENCE_MS = 4000;
const DEEP_MIN_TEXT_LENGTH = 60;
const DEEP_MIN_INTERVAL = 20000;
const DEEP_CONTEXT_MAX_AGE_MS = 90000;
const QUESTION_DEDUP_WINDOW_MS = 20 * 60 * 1000;
const QUESTION_HISTORY_LIMIT = 80;
const LONG_CONTEXT_SCENES = new Set(['live-host', 'interview']);
const RECENT_CONTEXT_CHARS = 12000;
const MEMORY_BATCH_TURNS = 12;
const MEMORY_BATCH_CHARS = 3600;

// 配置（从后端加载）
let appConfig = {
  silenceThreshold: 3000,
  minInterval: 30000,
  minTextLength: 100,
  model: '',
  models: {},
  llmProvider: '',
  hasApiKey: false,
  hasAsrConfig: false,
  longContextMemoryEnabled: true
};

// 追问触发控制
let silenceTimer = null;
let lastTriggerTime = 0;
let isGenerating = false;

// ── DOM 元素 ──────────────────────────────────────────────
const $sceneMode = document.getElementById('sceneMode');
const $customPromptRow = document.getElementById('customPromptRow');
const $customPrompt = document.getElementById('customPrompt');
const $audioSource = document.getElementById('audioSource');
const $btnToggle = document.getElementById('btnToggle');
const $scriptStatus = document.getElementById('scriptStatus');
const $suggestionsContainer = document.getElementById('suggestionsContainer');
const $suggestionCount = document.getElementById('suggestionCount');
const $suggestionPanelLabel = document.getElementById('suggestionPanelLabel');
const $suggestionPanelTitle = document.getElementById('suggestionPanelTitle');
const $transcriptContainer = document.getElementById('transcriptContainer');
const $speakerRoleControls = document.getElementById('speakerRoleControls');
const $charCount = document.getElementById('charCount');
const $btnScrollLock = document.getElementById('btnScrollLock');
const $btnDeepTrigger = document.getElementById('btnDeepTrigger');
const $btnDeepAuto = document.getElementById('btnDeepAuto');
const $btnInterviewReview = document.getElementById('btnInterviewReview');
const $btnJudgingScore = document.getElementById('btnJudgingScore');
const $btnExportReview = document.getElementById('btnExportReview');
const $statusDot = document.getElementById('statusDot');
const $statusText = document.getElementById('statusText');
const $asrStatus = document.getElementById('asrStatus');
const $llmStatus = document.getElementById('llmStatus');
const $elapsedTime = document.getElementById('elapsedTime');

// ── 初始化 ────────────────────────────────────────────────
async function init() {
  await loadConfig();
  await loadAudioDevices();
  onSceneModeChange();
  setStatus('ready', '就绪');

  if (!appConfig.hasAsrConfig) {
    $asrStatus.textContent = 'ASR: 未配置';
    $asrStatus.style.color = '#ef4444';
  } else {
    $asrStatus.textContent = 'ASR: 豆包 Seed-ASR 2.0';
  }
}

// ── 场景模式切换 ──────────────────────────────────────────
function onSceneModeChange() {
  const mode = $sceneMode.value;
  if (conversationMemoryScene && conversationMemoryScene !== mode) {
    resetConversationMemory();
  }
  conversationMemoryScene = mode;
  if (mode === 'custom') {
    $customPromptRow.style.display = 'flex';
    $customPrompt.focus();
  } else {
    $customPromptRow.style.display = 'none';
  }

  const ui = SCENE_UI[mode] || SCENE_UI.default;
  $suggestionPanelLabel.textContent = ui.label;
  $suggestionPanelTitle.textContent = ui.title;
  $btnInterviewReview.style.display = mode === 'candidate-interview' ? '' : 'none';
  $btnJudgingScore.style.display = mode === 'ai-judge' ? '' : 'none';
  updateDeepControls();
  syncSpeakerRolesWithScene();
  updateSpeakerRoleControls();
  refreshTranscriptSpeakerLabels();

  const emptyState = $suggestionsContainer.querySelector('.empty-state');
  if (emptyState) {
    emptyState.innerHTML = `
      <p>${ui.emptyTitle}</p>
      <p class="hint">${ui.emptyHint}</p>
    `;
  }
}

function isDeepSupportedScene(mode = $sceneMode.value) {
  return DEEP_SUPPORTED_SCENES.has(mode);
}

function updateDeepControls() {
  const supported = isDeepSupportedScene();
  if (!supported) {
    deepModeEnabled = false;
    clearDeepTurnTimer();
  }

  if ($btnDeepTrigger) {
    $btnDeepTrigger.style.display = supported ? '' : 'none';
  }

  if ($btnDeepAuto) {
    $btnDeepAuto.style.display = supported ? '' : 'none';
    $btnDeepAuto.textContent = deepModeEnabled ? '自动深度：开' : '自动深度：关';
    $btnDeepAuto.classList.toggle('active', deepModeEnabled);
  }
}

function toggleDeepMode() {
  if (!isDeepSupportedScene()) return;
  deepModeEnabled = !deepModeEnabled;
  updateDeepControls();
  if (deepModeEnabled) {
    scheduleDeepSilenceCompletion();
  } else {
    clearDeepTurnTimer();
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    appConfig = await res.json();
    if (!appConfig.hasApiKey) {
      $llmStatus.textContent = 'LLM: Key 未配置';
      $llmStatus.style.color = '#ef4444';
    }
  } catch (e) {
    console.warn('加载配置失败:', e);
  }
}

async function loadAudioDevices() {
  try {
    // 先请求权限，才能枚举设备
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    $audioSource.innerHTML = '';
    audioInputs.forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `麦克风 ${i + 1}`;
      $audioSource.appendChild(opt);
    });
  } catch (e) {
    console.warn('枚举音频设备失败:', e);
    $audioSource.innerHTML = '<option value="default">默认麦克风</option>';
  }
}

// ── WebSocket 连接管理 ─────────────────────────────────────
function connectAsrWebSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/asr`;

    asrWs = new WebSocket(wsUrl);
    asrWs.binaryType = 'arraybuffer';

    asrWs.onopen = () => {
      console.log('ASR WebSocket 已连接');
      // 发送启动命令
      asrWs.send(JSON.stringify({ type: 'start' }));
    };

    asrWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleAsrMessage(msg);
        if (msg.type === 'ready') {
          resolve();
        }
      } catch (e) {
        console.error('ASR 消息解析失败:', e);
      }
    };

    asrWs.onerror = (err) => {
      console.error('ASR WebSocket 错误:', err);
      $asrStatus.textContent = 'ASR: 连接错误';
      reject(err);
    };

    asrWs.onclose = () => {
      console.log('ASR WebSocket 已关闭');
      if (isRecording) {
        $asrStatus.textContent = 'ASR: 连接断开';
      }
    };
  });
}

function handleAsrMessage(msg) {
  switch (msg.type) {
    case 'ready':
      $asrStatus.textContent = 'ASR: 识别中';
      break;

    case 'asr_result':
      processAsrResult(msg);
      break;

    case 'error':
      console.error('ASR 错误:', msg.message);
      $asrStatus.textContent = `ASR: ${msg.message}`;
      break;

    case 'disconnected':
      if (isRecording) {
        $asrStatus.textContent = 'ASR: 服务断开';
      }
      break;
  }
}

function processAsrResult(msg) {
  const text = msg.text || '';
  const definite = msg.definite;
  const incomingTurns = extractAsrTurns(msg, text);
  const finalKey = text || incomingTurns.map(turn => `${turn.speakerId}:${turn.text}`).join('|');

  if (!finalKey) return;

  if (definite) {
    // 最终结果回来后，用带角色的正式记录替换实时草稿。
    clearInterimTranscript();

    // 去重：如果和上一次完全一样则跳过
    if (finalKey !== lastFinalText) {
      const changed = commitTranscriptTurns(incomingTurns);
      if (changed) {
        resetSilenceTimer();
      }
      lastFinalText = finalKey;
    }
  } else {
    // 中间结果先在转写列表内显示，不等待说话人归属。
    renderInterimTranscript(text);
  }
}

function extractAsrTurns(msg, fallbackText) {
  const utterances = Array.isArray(msg.utterances) ? msg.utterances : [];
  const turns = utterances
    .map(utterance => ({
      text: getUtteranceText(utterance),
      speakerId: getUtteranceSpeakerId(utterance),
      startMs: getUtteranceTime(utterance, ['start_time', 'startTime', 'start', 'begin_time', 'beginTime']),
      endMs: getUtteranceTime(utterance, ['end_time', 'endTime', 'end', 'stop_time', 'stopTime'])
    }))
    .filter(turn => turn.text.length > 0);

  if (turns.length > 0) return turns;
  return fallbackText ? [{ text: fallbackText, speakerId: '', startMs: null, endMs: null }] : [];
}

function getUtteranceText(utterance) {
  if (!utterance || typeof utterance !== 'object') return '';
  if (typeof utterance.text === 'string' && utterance.text.trim()) {
    return utterance.text.trim();
  }
  if (Array.isArray(utterance.words)) {
    return utterance.words
      .map(word => word.text || word.word || '')
      .join('')
      .trim();
  }
  return '';
}

function getUtteranceSpeakerId(utterance) {
  if (!utterance || typeof utterance !== 'object') return '';
  const additions = utterance.additions || {};
  const candidates = [
    utterance.speaker,
    utterance.speaker_id,
    utterance.speakerId,
    utterance.speaker_label,
    additions.speaker,
    additions.speaker_id,
    additions.speakerId,
    additions.speaker_label
  ];

  const speaker = candidates.find(value => value !== undefined && value !== null && value !== '');
  return speaker !== undefined ? `speaker-${speaker}` : '';
}

function getUtteranceTime(utterance, keys) {
  const additions = utterance?.additions || {};
  for (const key of keys) {
    const value = utterance?.[key] ?? additions[key];
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function commitTranscriptTurns(rawTurns) {
  let changed = false;
  let triggerText = '';
  const deepUpdatedTurns = [];
  rawTurns
    .map(normalizeIncomingTurn)
    .filter(Boolean)
    .forEach(turn => {
      if (isFillerTurn(turn.text)) return;
      if (isRecentDuplicate(turn)) return;

      const mergeTarget = findMergeTarget(turn);
      if (mergeTarget) {
        mergeTarget.text = mergeTurnText(mergeTarget.text, turn.text);
        mergeTarget.endMs = turn.endMs || mergeTarget.endMs;
        updateTranscriptLine(mergeTarget);
        triggerText += formatPromptTranscriptTurn({ ...turn, speakerId: mergeTarget.speakerId });
        deepUpdatedTurns.push(mergeTarget);
      } else {
        addCommittedTurn(turn);
        triggerText += formatPromptTranscriptTurn(turn);
        deepUpdatedTurns.push(turn);
      }

      rememberTurn(turn);
      changed = true;
    });

  if (changed) {
    rebuildTranscriptState();
    newTextSinceLastTrigger += triggerText;
    updateCharCount();
    deepUpdatedTurns.forEach(handleDeepTurnUpdate);
    maybeRefreshConversationMemory();
  }
  return changed;
}

function normalizeIncomingTurn(turn) {
  const text = normalizeTranscriptText(turn.text);
  if (!text) return null;
  return {
    id: `turn-${++turnCounter}`,
    text,
    speakerId: turn.speakerId || '',
    startMs: turn.startMs,
    endMs: turn.endMs,
    receivedAt: Date.now(),
    element: null
  };
}

function normalizeTranscriptText(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？；：、,.!?;:])/g, '$1')
    .trim();
}

function normalizeDuplicateText(text) {
  return normalizeTranscriptText(text).replace(/[，。！？；：、,.!?;:\s"“”'‘’]/g, '');
}

function getActiveQuestionHistory() {
  const now = Date.now();
  return questionLedger
    .filter(item => item.sceneMode === $sceneMode.value)
    .filter(item => item.used || now - Date.parse(item.createdAt) <= QUESTION_DEDUP_WINDOW_MS)
    .slice(-QUESTION_HISTORY_LIMIT);
}

function serializeQuestionHistory() {
  return getActiveQuestionHistory().map(item => ({
    text: item.text,
    type: item.type,
    status: item.used ? 'asked' : 'shown',
    createdAt: item.createdAt
  }));
}

function filterNovelQuestionItems(items, getText = item => item.text || item.question || '') {
  const api = window.ChatCopilotQuestionQuality;
  if (!api?.filterNovelItems) return items;
  return api.filterNovelItems(items, getActiveQuestionHistory(), getText);
}

function registerQuestionItem(item, type, createdAt) {
  const text = item.text || item.question || '';
  if (!text || !['suggestion', 'deep'].includes(type)) return;
  const ledgerItem = {
    id: `question-${++questionLedgerCounter}`,
    text,
    type,
    sceneMode: $sceneMode.value,
    createdAt: createdAt.toISOString(),
    used: false
  };
  questionLedger.push(ledgerItem);
  if (questionLedger.length > 240) {
    questionLedger = questionLedger.slice(-200);
  }
  item.ledgerId = ledgerItem.id;
}

function updateQuestionLedgerUsage(item) {
  if (!item?.ledgerId) return;
  const ledgerItem = questionLedger.find(entry => entry.id === item.ledgerId);
  if (ledgerItem) ledgerItem.used = !!item.used;
}

function isFillerTurn(text) {
  const compact = normalizeDuplicateText(text).toLowerCase();
  if (!compact) return true;
  return /^(?:(?:嗯|啊|哦|呃|额|哎|唉|嗯哼|对|是|好|行|可以|没错)){1,4}$/i.test(compact);
}

function isRecentDuplicate(turn) {
  const key = buildTurnKey(turn);
  const now = Date.now();
  const lastSeen = recentTurnKeys.get(key);
  if (!lastSeen) return false;
  const duplicateWindow = turn.startMs !== null && turn.startMs !== undefined
    ? 90000
    : normalizeDuplicateText(turn.text).length >= 10 ? 90000 : 10000;
  return now - lastSeen < duplicateWindow;
}

function buildTurnKey(turn) {
  const text = normalizeDuplicateText(turn.text);
  if (turn.startMs !== null && turn.startMs !== undefined) {
    return `${turn.speakerId}|${text}|${Math.round(Number(turn.startMs) / 500)}`;
  }
  return `${turn.speakerId}|${text}`;
}

function rememberTurn(turn) {
  recentTurnKeys.set(buildTurnKey(turn), Date.now());
  if (recentTurnKeys.size > 220) {
    const staleKeys = [...recentTurnKeys.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 60)
      .map(([key]) => key);
    staleKeys.forEach(key => recentTurnKeys.delete(key));
  }
}

function findMergeTarget(turn) {
  const fragmentType = getFragmentType(turn.text);
  if (!fragmentType) return null;
  for (let i = transcriptTurns.length - 1; i >= 0; i--) {
    const candidate = transcriptTurns[i];
    if (candidate.speakerId !== turn.speakerId) continue;
    if (canMergeByTime(candidate, turn) || (fragmentType === 'continuation' && canMergeByReceiveTime(candidate, turn))) {
      return candidate;
    }
    return null;
  }
  return null;
}

function getFragmentType(text) {
  const compact = normalizeDuplicateText(text);
  if (/^[的地得了着过们及和与或、，。！？；：]/.test(text)) return 'continuation';
  if (compact.length <= 8) return 'short';
  return '';
}

function canMergeByTime(previous, next) {
  if (previous.endMs === null || previous.endMs === undefined || next.startMs === null || next.startMs === undefined) return false;
  return Math.abs(Number(next.startMs) - Number(previous.endMs)) <= 2500;
}

function canMergeByReceiveTime(previous, next) {
  return Math.abs(Number(next.receivedAt || 0) - Number(previous.receivedAt || 0)) <= 3500;
}

function mergeTurnText(previous, next) {
  const cleanedNext = normalizeTranscriptText(next);
  if (!cleanedNext) return previous;
  if (/^[的地得了着过们及和与或]/.test(cleanedNext)) {
    return previous.replace(/[，。！？；：、,.!?;:]$/, '') + cleanedNext;
  }
  return `${previous}${cleanedNext}`;
}

function addCommittedTurn(turn) {
  getSpeakerLabel(turn.speakerId);
  ensureSpeakerRole(turn.speakerId, turn.text);
  transcriptTurns.push(turn);
  turn.element = renderTranscriptLine(turn);
  updateSpeakerRoleControls();
}

function rebuildTranscriptState() {
  fullTranscript = transcriptTurns.map(formatPromptTranscriptTurn).join('');
}

function shouldUseConversationMemory(mode = $sceneMode.value) {
  return appConfig.longContextMemoryEnabled && LONG_CONTEXT_SCENES.has(mode);
}

function resetConversationMemory() {
  conversationMemory = '';
  memoryTurnCursor = 0;
  memoryRetryAfter = 0;
}

function maybeRefreshConversationMemory() {
  if (!shouldUseConversationMemory() || isGenerating || isMemoryGenerating || Date.now() < memoryRetryAfter) return;

  const pendingTurns = transcriptTurns.slice(memoryTurnCursor);
  const pendingText = pendingTurns.map(formatPromptTranscriptTurn).join('');
  const hasEnoughTurns = pendingTurns.length >= MEMORY_BATCH_TURNS;
  const hasEnoughText = pendingText.length >= MEMORY_BATCH_CHARS;
  if (!hasEnoughTurns && !hasEnoughText) return;

  const memoryChunk = buildConversationMemoryChunk(pendingTurns);
  refreshConversationMemory(memoryChunk.turns, memoryChunk.text);
}

function buildConversationMemoryChunk(turns) {
  const chunkTurns = [];
  let text = '';

  for (const turn of turns) {
    const formatted = formatPromptTranscriptTurn(turn);
    if (chunkTurns.length > 0 && text.length + formatted.length > 8000) break;

    chunkTurns.push(turn);
    text += formatted;

    if (chunkTurns.length >= MEMORY_BATCH_TURNS || text.length >= MEMORY_BATCH_CHARS) break;
  }

  return { turns: chunkTurns, text };
}

async function refreshConversationMemory(turns, transcriptChunk) {
  isMemoryGenerating = true;
  const turnCount = turns.length;

  try {
    const res = await fetch('/api/conversation-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sceneMode: $sceneMode.value,
        previousMemory: conversationMemory,
        transcriptChunk: transcriptChunk.slice(-9000)
      })
    });
    const data = await res.json();

    if (!res.ok) {
      console.warn('对话记忆更新失败:', data.error);
      memoryRetryAfter = Date.now() + 30000;
      return;
    }

    if (data.memory) {
      conversationMemory = data.memory;
      memoryTurnCursor += turnCount;
    } else {
      memoryRetryAfter = Date.now() + 30000;
    }
  } catch (err) {
    console.warn('对话记忆请求失败:', err);
    memoryRetryAfter = Date.now() + 30000;
  } finally {
    isMemoryGenerating = false;
    maybeRefreshConversationMemory();
  }
}

function getRecentContextForSuggestions() {
  return fullTranscript.slice(-RECENT_CONTEXT_CHARS);
}

function handleDeepTurnUpdate(turn) {
  if (!turn || !turn.text || !isDeepSupportedScene()) return;

  if (!turn.speakerId) {
    openSpeakerRound = null;
    clearDeepTurnTimer();
    return;
  }

  if (openSpeakerRound && openSpeakerRound.speakerId !== turn.speakerId) {
    const completed = finishOpenSpeakerRound('speaker-change');
    maybeAutoGenerateDeep(completed);
  }

  if (!openSpeakerRound) {
    openSpeakerRound = {
      id: `round-${++deepRoundCounter}`,
      speakerId: turn.speakerId,
      turnIds: [],
      text: '',
      startedAt: turn.receivedAt || Date.now(),
      endedAt: turn.receivedAt || Date.now(),
      reason: ''
    };
  }

  if (!openSpeakerRound.turnIds.includes(turn.id)) {
    openSpeakerRound.turnIds.push(turn.id);
  }
  openSpeakerRound.endedAt = turn.receivedAt || Date.now();
  refreshOpenRoundText();
  scheduleDeepSilenceCompletion();
}

function refreshOpenRoundText() {
  if (!openSpeakerRound) return;
  const turnIdSet = new Set(openSpeakerRound.turnIds);
  openSpeakerRound.text = transcriptTurns
    .filter(turn => turnIdSet.has(turn.id))
    .map(turn => turn.text)
    .join('');
}

function finishOpenSpeakerRound(reason) {
  if (!openSpeakerRound) return null;
  refreshOpenRoundText();
  const round = {
    ...openSpeakerRound,
    speakerLabel: getSpeakerLabel(openSpeakerRound.speakerId),
    role: speakerRoleMap[openSpeakerRound.speakerId] || '',
    text: normalizeTranscriptText(openSpeakerRound.text),
    reason
  };
  openSpeakerRound = null;
  clearDeepTurnTimer();

  if (!isDeepRoundEligible(round)) return null;

  speakerRounds.push(round);
  if (speakerRounds.length > 30) {
    speakerRounds = speakerRounds.slice(-30);
  }
  lastCompletedRound = round;
  return round;
}

function scheduleDeepSilenceCompletion() {
  clearDeepTurnTimer();
  if (!openSpeakerRound || !isDeepSupportedScene()) return;

  deepTurnTimer = setTimeout(() => {
    const completed = finishOpenSpeakerRound('long-pause');
    maybeAutoGenerateDeep(completed);
  }, DEEP_TURN_SILENCE_MS);
}

function clearDeepTurnTimer() {
  if (deepTurnTimer) {
    clearTimeout(deepTurnTimer);
    deepTurnTimer = null;
  }
}

function maybeAutoGenerateDeep(round) {
  if (!round || !deepModeEnabled || !isDeepSupportedScene()) return;
  if (isGenerating || isGeneratingDeep) return;
  if (deepGeneratedRoundIds.has(round.id)) return;
  if (Date.now() - lastDeepTriggerTime < DEEP_MIN_INTERVAL) return;

  deepGeneratedRoundIds.add(round.id);
  generateDeepSuggestions('auto', round);
}

function isDeepRoundEligible(round) {
  if (!round || !round.text) return false;
  const compact = normalizeDuplicateText(round.text);
  if (compact.length < DEEP_MIN_TEXT_LENGTH) return false;
  if (/^(是|对|不是|还行吧|可以|没问题|不知道|没有|差不多|嗯|哦|啊|好)$/i.test(compact)) return false;
  return true;
}

function getSpeakerLabel(speakerId) {
  if (!speakerId) return '';
  if (!speakerLabelMap[speakerId]) {
    speakerOrder.push(speakerId);
    speakerLabelMap[speakerId] = `说话人 ${speakerOrder.length}`;
  }
  return speakerLabelMap[speakerId];
}

function getSpeakerDisplayName(speakerId) {
  const role = speakerRoleMap[speakerId];
  return role || getSpeakerLabel(speakerId);
}

function formatPromptTranscriptTurn(turn) {
  const speakerLabel = getSpeakerLabel(turn.speakerId);
  const role = speakerRoleMap[turn.speakerId];
  if (role && speakerLabel) return `${role}（${speakerLabel}）：${turn.text}\n`;
  if (role) return `${role}：${turn.text}\n`;
  if (speakerLabel) return `${speakerLabel}：${turn.text}\n`;
  return `${turn.text}\n`;
}

function ensureSpeakerRole(speakerId, text = '') {
  if (!speakerId || speakerRoleMap[speakerId]) return;
  const inferredRole = inferSpeakerRole($sceneMode.value, text);
  if (inferredRole && !isRoleAssignedToOtherSpeaker(inferredRole, speakerId)) {
    assignSpeakerRole(speakerId, inferredRole, 'auto-content');
  }
  assignRemainingRoleIfClear();
}

function inferSpeakerRole(sceneMode, text) {
  const value = normalizeTranscriptText(text).toLowerCase();
  if (!value) return '';

  if (sceneMode === 'live-host') {
    if (/(欢迎来到|今天.{0,12}嘉宾|请.{0,12}(介绍|分享)|直播间|我是.{0,10}(主持人|主播|帮主))/.test(value)) return '主持人';
    if (/(大家好.{0,8}我是|我是.{0,20}(创始人|联合创始人|ceo|负责人)|我们(公司|团队|产品))/.test(value)) return '嘉宾';
  }

  if (sceneMode === 'interview') {
    if (/(今天我们(采访|聊)|请.{0,12}(介绍|讲讲|分享)|我想问)/.test(value)) return '采访者';
    if (/(大家好.{0,8}我是|我来自|我的经历|我当时负责)/.test(value)) return '受访者';
  }

  if (sceneMode === 'recruitment' || sceneMode === 'candidate-interview') {
    if (/(请.{0,12}(自我介绍|介绍一下|讲讲)|为什么应聘|你在.{0,12}项目)/.test(value)) return '面试官';
    if (/(我应聘|我在.{0,12}项目|我主要负责|我的优势)/.test(value)) return '候选人';
  }

  if (sceneMode === 'ai-judge') {
    if (/(请.{0,12}(介绍|演示|说明)|我想追问|评分)/.test(value)) return '评委';
    if (/(我们的项目|这个产品解决|我们做了|目前已经上线)/.test(value)) return '选手';
  }

  if (sceneMode === 'sales-negotiation') {
    if (/(我们的预算|采购流程|我要和.{0,8}确认|你们的报价)/.test(value)) return '客户';
    if (/(我们的方案|可以给您|我们产品|下一步我们)/.test(value)) return '我方';
  }

  return '';
}

function isRoleAssignedToOtherSpeaker(role, speakerId) {
  return Object.entries(speakerRoleMap)
    .some(([id, assignedRole]) => id !== speakerId && assignedRole === role);
}

function assignSpeakerRole(speakerId, role, source = 'manual') {
  if (!speakerId) return;
  if (!role) {
    delete speakerRoleMap[speakerId];
    delete speakerRoleSource[speakerId];
    return;
  }
  speakerRoleMap[speakerId] = role;
  speakerRoleSource[speakerId] = source;
}

function assignRemainingRoleIfClear() {
  const roles = getSceneRoles();
  const visibleSpeakers = speakerOrder.slice(0, 2);
  if (visibleSpeakers.length !== 2 || roles.length < 2) return;

  const unassignedSpeakers = visibleSpeakers.filter(speakerId => !speakerRoleMap[speakerId]);
  const unusedRoles = roles.filter(role => !visibleSpeakers.some(speakerId => speakerRoleMap[speakerId] === role));
  if (unassignedSpeakers.length === 1 && unusedRoles.length === 1) {
    assignSpeakerRole(unassignedSpeakers[0], unusedRoles[0], 'auto-elimination');
  }
}

function getSceneRoles() {
  return SCENE_ROLE_PRESETS[$sceneMode.value] || SCENE_ROLE_PRESETS.default;
}

function syncSpeakerRolesWithScene() {
  const roles = getSceneRoles();
  speakerOrder.forEach(speakerId => {
    const currentRole = speakerRoleMap[speakerId];
    if (currentRole && !roles.includes(currentRole)) {
      assignSpeakerRole(speakerId, '');
    }
    const sample = transcriptTurns
      .filter(turn => turn.speakerId === speakerId)
      .slice(0, 8)
      .map(turn => turn.text)
      .join(' ');
    ensureSpeakerRole(speakerId, sample);
  });
  assignRemainingRoleIfClear();
}

function updateSpeakerRoleControls() {
  if (!$speakerRoleControls) return;

  const roles = getSceneRoles();
  $speakerRoleControls.hidden = false;
  $speakerRoleControls.innerHTML = '';

  const hint = document.createElement('div');
  hint.className = 'speaker-role-hint';
  hint.textContent = speakerOrder.length === 0
    ? `角色映射：等待识别说话人，识别后可设为 ${roles.slice(0, 2).join(' / ')}`
    : '角色映射：已根据开场内容自动判断，不确定时保持未指定';
  $speakerRoleControls.appendChild(hint);

  if (speakerOrder.length === 0) return;

  speakerOrder.forEach(speakerId => {
    const item = document.createElement('div');
    item.className = 'speaker-role-item';

    const label = document.createElement('span');
    label.className = 'speaker-role-label';
    label.textContent = getSpeakerLabel(speakerId);

    const select = document.createElement('select');
    select.className = 'speaker-role-select';
    select.setAttribute('aria-label', `${getSpeakerLabel(speakerId)} 角色`);

    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '未指定';
    select.appendChild(emptyOption);

    roles.forEach(role => {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role;
      select.appendChild(option);
    });

    select.value = speakerRoleMap[speakerId] || '';
    select.onchange = () => {
      assignSpeakerRole(speakerId, select.value, 'manual');
      assignRemainingRoleIfClear();
      refreshTranscriptSpeakerLabels();
      rebuildTranscriptState();
      resetConversationMemory();
      maybeRefreshConversationMemory();
      updateCharCount();
      updateSpeakerRoleControls();
    };

    item.appendChild(label);
    item.appendChild(select);
    $speakerRoleControls.appendChild(item);
  });

  const mappedSpeakers = speakerOrder.slice(0, 2);
  if (mappedSpeakers.length === 2 && mappedSpeakers.every(speakerId => speakerRoleMap[speakerId])) {
    const swapButton = document.createElement('button');
    swapButton.type = 'button';
    swapButton.className = 'speaker-role-swap';
    swapButton.textContent = '交换角色';
    swapButton.title = '交换前两位说话人的场景角色';
    swapButton.onclick = () => {
      const [first, second] = mappedSpeakers;
      const firstRole = speakerRoleMap[first];
      assignSpeakerRole(first, speakerRoleMap[second], 'manual');
      assignSpeakerRole(second, firstRole, 'manual');
      refreshTranscriptSpeakerLabels();
      rebuildTranscriptState();
      resetConversationMemory();
      maybeRefreshConversationMemory();
      updateSpeakerRoleControls();
    };
    $speakerRoleControls.appendChild(swapButton);
  }
}

function refreshTranscriptSpeakerLabels() {
  transcriptTurns.forEach(updateTranscriptLine);
}

function updateTranscriptLine(turn) {
  if (!turn.element) return;
  const speaker = turn.element.querySelector('.speaker-chip');
  const content = turn.element.querySelector('.transcript-content');
  const displayName = getSpeakerDisplayName(turn.speakerId);
  if (speaker) {
    speaker.textContent = displayName;
    speaker.hidden = !displayName;
    speaker.title = getSpeakerLabel(turn.speakerId);
  }
  if (content) {
    content.textContent = turn.text;
  }
}

// ── 音频采集 ──────────────────────────────────────────────
async function startAudioCapture() {
  const deviceId = $audioSource.value;
  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      sampleRate: { ideal: 16000 },
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

  // 创建 AudioContext
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 16000  // 请求 16kHz，浏览器可能不支持会用默认值
  });

  // 注册 AudioWorklet
  await audioContext.audioWorklet.addModule('pcm-processor.js');

  // 创建节点链
  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

  // 接收 PCM 数据并通过 WebSocket 发送
  workletNode.port.onmessage = (event) => {
    if (asrWs && asrWs.readyState === WebSocket.OPEN) {
      asrWs.send(event.data); // ArrayBuffer → binary frame
    }
  };

  source.connect(workletNode);
  // workletNode 不需要连接到 destination（不需要播放）
}

function stopAudioCapture() {
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

// ── 开始/停止录音 ─────────────────────────────────────────
function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  if (!appConfig.hasAsrConfig) {
    alert('ASR 未配置。请编辑 .env 文件，填入 ASR_APP_ID 和 ASR_ACCESS_TOKEN。');
    return;
  }

  try {
    setStatus('recording', '连接中...');
    $btnToggle.textContent = '连接中';
    $btnToggle.disabled = true;
    $asrStatus.textContent = 'ASR: 连接中...';

    // 先建立 WebSocket，等待 ready
    await connectAsrWebSocket();

    // 再启动音频采集
    await startAudioCapture();

    clearStopExportPromptTimer();
    if (!sessionStartedAt) {
      sessionStartedAt = new Date().toISOString();
    }
    sessionEndedAt = null;

    isRecording = true;
    lastFinalText = '';
    $btnToggle.textContent = '停止';
    $btnToggle.disabled = false;
    $btnToggle.classList.add('recording');
    setStatus('recording', '录音中');

    // 清除空状态
    const emptyState = $transcriptContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // 启动计时
    startTime = Date.now();
    timerInterval = setInterval(updateElapsedTime, 1000);

  } catch (err) {
    console.error('启动失败:', err);
    $btnToggle.textContent = '开始';
    $btnToggle.disabled = false;
    setStatus('error', '启动失败');
    $asrStatus.textContent = 'ASR: 启动失败';
    alert('启动语音识别失败: ' + (err.message || '请检查麦克风权限'));

    // 清理
    stopAudioCapture();
    if (asrWs) {
      asrWs.close();
      asrWs = null;
    }
  }
}

function stopRecording() {
  isRecording = false;
  sessionEndedAt = new Date().toISOString();

  // 发送停止信号
  if (asrWs && asrWs.readyState === WebSocket.OPEN) {
    asrWs.send(JSON.stringify({ type: 'stop' }));
    // 延迟关闭 WebSocket，等待最终结果
    setTimeout(() => {
      if (asrWs) {
        asrWs.close();
        asrWs = null;
      }
    }, 3000);
  }

  stopAudioCapture();
  clearSilenceTimer();

  $btnToggle.textContent = '开始';
  $btnToggle.classList.remove('recording');
  setStatus('ready', '已停止');
  $asrStatus.textContent = 'ASR: 已停止';
  clearInterimTranscript();

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  scheduleStopExportPrompt();
}

// ── 转写文本管理 ──────────────────────────────────────────
function renderInterimTranscript(text) {
  const contentText = normalizeTranscriptText(text);
  if (!contentText) return;

  const emptyState = $transcriptContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  if (!interimTranscriptLine) {
    interimTranscriptLine = document.createElement('div');
    interimTranscriptLine.className = 'transcript-line interim-line';

    const ts = document.createElement('span');
    ts.className = 'timestamp';
    ts.textContent = '实时';

    const chip = document.createElement('span');
    chip.className = 'interim-chip';
    chip.textContent = '识别中';

    const content = document.createElement('span');
    content.className = 'transcript-content';

    interimTranscriptLine.appendChild(ts);
    interimTranscriptLine.appendChild(chip);
    interimTranscriptLine.appendChild(content);
    $transcriptContainer.appendChild(interimTranscriptLine);
  }

  const content = interimTranscriptLine.querySelector('.transcript-content');
  if (content) content.textContent = contentText;

  if (autoScroll) {
    $transcriptContainer.scrollTop = $transcriptContainer.scrollHeight;
  }
}

function clearInterimTranscript() {
  if (interimTranscriptLine) {
    interimTranscriptLine.remove();
    interimTranscriptLine = null;
  }
}

function renderTranscriptLine(turn) {
  const emptyState = $transcriptContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const line = document.createElement('div');
  line.className = 'transcript-line';

  const ts = document.createElement('span');
  ts.className = 'timestamp';
  ts.textContent = formatTime(new Date());

  const speakerLabel = getSpeakerDisplayName(turn.speakerId);
  const speaker = document.createElement('span');
  speaker.className = 'speaker-chip';
  speaker.textContent = speakerLabel;
  speaker.hidden = !speakerLabel;
  speaker.title = getSpeakerLabel(turn.speakerId);

  const content = document.createElement('span');
  content.className = 'transcript-content';
  content.textContent = turn.text;

  line.appendChild(ts);
  line.appendChild(speaker);
  line.appendChild(content);
  $transcriptContainer.appendChild(line);

  if (autoScroll) {
    $transcriptContainer.scrollTop = $transcriptContainer.scrollHeight;
  }

  return line;
}

function clearTranscript() {
  if (!confirm('确定要清空所有转写文字吗？')) return;
  clearInterimTranscript();
  $transcriptContainer.innerHTML = '';
  fullTranscript = '';
  newTextSinceLastTrigger = '';
  lastFinalText = '';
  speakerOrder = [];
  speakerLabelMap = {};
  speakerRoleMap = {};
  speakerRoleSource = {};
  transcriptTurns = [];
  recentTurnKeys = new Map();
  turnCounter = 0;
  resetDeepState();
  resetConversationMemory();
  updateSpeakerRoleControls();
  updateCharCount();
}

function resetDeepState() {
  clearDeepTurnTimer();
  speakerRounds = [];
  openSpeakerRound = null;
  lastCompletedRound = null;
  deepGeneratedRoundIds = new Set();
  deepRoundCounter = 0;
  lastDeepTriggerTime = 0;
}

function toggleScrollLock() {
  autoScroll = !autoScroll;
  $btnScrollLock.textContent = autoScroll ? '自动滚动：开' : '自动滚动：关';
  if (autoScroll) {
    $transcriptContainer.scrollTop = $transcriptContainer.scrollHeight;
  }
}

function updateCharCount() {
  $charCount.textContent = `${fullTranscript.length} 字`;
}

// ── 追问生成触发 ──────────────────────────────────────────
function resetSilenceTimer() {
  clearSilenceTimer();
  silenceTimer = setTimeout(() => {
    checkAndTriggerSuggestion();
  }, appConfig.silenceThreshold);
}

function clearSilenceTimer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
}

function checkAndTriggerSuggestion() {
  const now = Date.now();
  const elapsed = now - lastTriggerTime;

  // 最小间隔保护
  if (elapsed < appConfig.minInterval) return;

  // 最小文本量
  if (newTextSinceLastTrigger.length < appConfig.minTextLength) return;

  // 避免重复
  if (isGenerating) return;

  generateSuggestions();
}

function manualTrigger() {
  if (fullTranscript.trim().length === 0) {
    alert('还没有对话内容，请先开始录音。');
    return;
  }
  if (isGenerating) {
    alert('正在生成中，请稍候...');
    return;
  }
  generateSuggestions();
}

async function generateSuggestions() {
  isGenerating = true;
  lastTriggerTime = Date.now();
  const textForThisTrigger = newTextSinceLastTrigger;
  newTextSinceLastTrigger = '';

  $llmStatus.textContent = 'LLM: 生成中...';
  $llmStatus.style.color = '#f59e0b';

  try {
    const res = await fetch('/api/generate-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: getRecentContextForSuggestions(),
        scriptContent: scriptContent || '',
        previousSummary: shouldUseConversationMemory() ? conversationMemory : '',
        questionHistory: serializeQuestionHistory(),
        sceneMode: $sceneMode.value,
        customPrompt: $customPrompt.value || ''
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('生成失败:', data.error);
      $llmStatus.textContent = `LLM: ${data.error}`;
      $llmStatus.style.color = '#ef4444';
      // 把文本还回去，下次还能用
      newTextSinceLastTrigger = textForThisTrigger + newTextSinceLastTrigger;
      return;
    }

    const addedCount = data.suggestions
      ? addSuggestionGroup(data.suggestions, 'suggestion', data.diagnostics || null)
      : 0;

    $llmStatus.textContent = addedCount > 0
      ? `LLM: 已生成（${data.model || ''})`
      : 'LLM: 暂无新增问题';
    $llmStatus.style.color = '#22c55e';

    // 3 秒后恢复待命状态
    setTimeout(() => {
      if (!isGenerating) {
        $llmStatus.textContent = 'LLM: 待命';
        $llmStatus.style.color = '';
      }
    }, 3000);

  } catch (err) {
    console.error('请求失败:', err);
    $llmStatus.textContent = 'LLM: 网络错误';
    $llmStatus.style.color = '#ef4444';
    newTextSinceLastTrigger = textForThisTrigger + newTextSinceLastTrigger;
  } finally {
    isGenerating = false;
    maybeRefreshConversationMemory();
  }
}

function manualDeepTrigger() {
  if (!isDeepSupportedScene()) return;
  if (fullTranscript.trim().length === 0) {
    alert('还没有对话内容，请先开始录音。');
    return;
  }
  if (isGenerating || isGeneratingDeep) {
    alert('正在生成中，请稍候...');
    return;
  }
  const round = getManualDeepRound();
  if (!round || !round.text || normalizeDuplicateText(round.text).length < 20) {
    alert('还没有足够完整的一轮表达，建议再听一段后点击。');
    return;
  }

  const contextAgeMs = getRoundContextAgeMs(round);
  let allowStaleContext = false;
  if (contextAgeMs > DEEP_CONTEXT_MAX_AGE_MS) {
    const ageMinutes = Math.max(1, Math.round(contextAgeMs / 60000));
    allowStaleContext = confirm(`最近转写已停更约 ${ageMinutes} 分钟。是否仍基于这段旧上下文生成深度追问？`);
    if (!allowStaleContext) return;
  }

  generateDeepSuggestions('manual', round, { contextAgeMs, allowStaleContext });
}

function getManualDeepRound() {
  if (openSpeakerRound) {
    const currentRound = buildCurrentOpenRoundSnapshot();
    if (isDeepRoundEligible(currentRound)) {
      return finishOpenSpeakerRound('manual');
    }
  }

  if (lastCompletedRound) return lastCompletedRound;

  return buildFallbackDeepRound();
}

function buildCurrentOpenRoundSnapshot() {
  if (!openSpeakerRound) return null;
  refreshOpenRoundText();
  return {
    ...openSpeakerRound,
    speakerLabel: getSpeakerLabel(openSpeakerRound.speakerId),
    role: speakerRoleMap[openSpeakerRound.speakerId] || '',
    text: normalizeTranscriptText(openSpeakerRound.text),
    reason: 'manual-preview'
  };
}

function buildFallbackDeepRound() {
  const recentText = transcriptTurns.slice(-8).map(formatPromptTranscriptTurn).join('').trim();
  const text = recentText || fullTranscript.slice(-1200).trim();
  if (!text) return null;
  return {
    id: `fallback-${Date.now()}`,
    speakerId: '',
    speakerLabel: '',
    role: '',
    turnIds: [],
    text,
    startedAt: transcriptTurns.at(-8)?.receivedAt || Date.now(),
    endedAt: transcriptTurns.at(-1)?.receivedAt || Date.now(),
    reason: 'manual-fallback',
    fallback: true
  };
}

function getRoundContextAgeMs(round) {
  const rawEndedAt = round?.endedAt || transcriptTurns.at(-1)?.receivedAt || Date.now();
  const endedAt = typeof rawEndedAt === 'number' ? rawEndedAt : Date.parse(rawEndedAt);
  return Number.isFinite(endedAt) ? Math.max(0, Date.now() - endedAt) : 0;
}

function serializeDeepRound(round) {
  if (!round) return null;
  const role = round.speakerId ? speakerRoleMap[round.speakerId] || round.role || '' : '';
  const speakerLabel = round.speakerId ? getSpeakerLabel(round.speakerId) : '';
  return {
    id: round.id,
    speakerId: round.speakerId || '',
    speakerLabel,
    role,
    text: round.text || '',
    startedAt: round.startedAt || '',
    endedAt: round.endedAt || '',
    reason: round.reason || '',
    fallback: !!round.fallback
  };
}

function getSameSpeakerHistory(round) {
  if (!round || !round.speakerId) return [];
  return speakerRounds
    .filter(item => item.id !== round.id && item.speakerId === round.speakerId)
    .slice(-4)
    .map(serializeDeepRound);
}

function getRecentRounds(round) {
  return speakerRounds
    .filter(item => !round || item.id !== round.id)
    .slice(-6)
    .map(serializeDeepRound);
}

async function generateDeepSuggestions(triggerType, sourceRound = null, options = {}) {
  if (!isDeepSupportedScene()) return;

  const round = sourceRound || getManualDeepRound();
  if (!round || !round.text || normalizeDuplicateText(round.text).length < 20) {
    if (triggerType === 'manual') {
      alert('还没有足够完整的一轮表达，建议再听一段后点击。');
    }
    return;
  }

  if (isGenerating || isGeneratingDeep) return;

  isGenerating = true;
  isGeneratingDeep = true;
  lastDeepTriggerTime = Date.now();
  if ($btnDeepTrigger) $btnDeepTrigger.disabled = true;
  if ($btnDeepAuto) $btnDeepAuto.disabled = true;
  $llmStatus.textContent = 'LLM: 深度追问中...';
  $llmStatus.style.color = '#f59e0b';

  try {
    const contextAgeMs = options.contextAgeMs ?? getRoundContextAgeMs(round);
    const res = await fetch('/api/deep-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sceneMode: $sceneMode.value,
        scriptContent: scriptContent || '',
        completedRound: serializeDeepRound(round),
        sameSpeakerHistory: getSameSpeakerHistory(round),
        recentRounds: getRecentRounds(round),
        conversationMemory: shouldUseConversationMemory() ? conversationMemory : '',
        questionHistory: serializeQuestionHistory(),
        contextAgeMs,
        allowStaleContext: !!options.allowStaleContext,
        triggerType
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('深度追问失败:', data.error);
      $llmStatus.textContent = `LLM: ${data.error}`;
      $llmStatus.style.color = '#ef4444';
      return;
    }

    const notices = [];
    if (round.fallback) notices.push('未识别说话人，已按最近上下文生成');
    if (contextAgeMs > DEEP_CONTEXT_MAX_AGE_MS) {
      notices.push(`上下文已停更 ${Math.max(1, Math.round(contextAgeMs / 60000))} 分钟`);
    }
    const addedCount = Array.isArray(data.suggestions)
      ? addDeepSuggestionGroup(data.suggestions, triggerType, notices.join('；'), data.diagnostics || null)
      : 0;

    $llmStatus.textContent = addedCount > 0
      ? `LLM: 已生成深度追问（${data.model || ''})`
      : `LLM: ${data.reason || '当前没有值得打断的新问题'}`;
    $llmStatus.style.color = '#22c55e';
  } catch (err) {
    console.error('深度追问请求失败:', err);
    $llmStatus.textContent = 'LLM: 网络错误';
    $llmStatus.style.color = '#ef4444';
  } finally {
    isGenerating = false;
    isGeneratingDeep = false;
    if ($btnDeepTrigger) $btnDeepTrigger.disabled = false;
    if ($btnDeepAuto) $btnDeepAuto.disabled = false;
    maybeRefreshConversationMemory();
  }
}

async function generateInterviewReview() {
  if ($sceneMode.value !== 'candidate-interview') return;
  if (fullTranscript.trim().length === 0) {
    alert('还没有面试转写内容，无法复盘。');
    return;
  }
  if (isGenerating) {
    alert('正在生成中，请稍候...');
    return;
  }

  isGenerating = true;
  $btnInterviewReview.disabled = true;
  $llmStatus.textContent = 'LLM: 复盘中...';
  $llmStatus.style.color = '#f59e0b';

  try {
    const res = await fetch('/api/interview-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: fullTranscript,
        scriptContent: scriptContent || ''
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('复盘失败:', data.error);
      $llmStatus.textContent = `LLM: ${data.error}`;
      $llmStatus.style.color = '#ef4444';
      return;
    }

    if (data.review) {
      addSuggestionGroup(data.review, 'review');
    }

    $llmStatus.textContent = `LLM: 已复盘（${data.model || ''})`;
    $llmStatus.style.color = '#22c55e';
  } catch (err) {
    console.error('复盘请求失败:', err);
    $llmStatus.textContent = 'LLM: 网络错误';
    $llmStatus.style.color = '#ef4444';
  } finally {
    isGenerating = false;
    $btnInterviewReview.disabled = false;
  }
}

async function generateJudgingScore() {
  if ($sceneMode.value !== 'ai-judge') return;
  if (fullTranscript.trim().length === 0) {
    alert('还没有项目展示转写内容，无法生成评分表。');
    return;
  }
  if (isGenerating) {
    alert('正在生成中，请稍候...');
    return;
  }

  isGenerating = true;
  $btnJudgingScore.disabled = true;
  $llmStatus.textContent = 'LLM: 评分中...';
  $llmStatus.style.color = '#f59e0b';

  try {
    const res = await fetch('/api/judging-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: fullTranscript,
        scriptContent: scriptContent || ''
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('评分表生成失败:', data.error);
      $llmStatus.textContent = `LLM: ${data.error}`;
      $llmStatus.style.color = '#ef4444';
      return;
    }

    if (data.score) {
      addSuggestionGroup(data.score, 'score');
    }

    $llmStatus.textContent = `LLM: 已生成评分表（${data.model || ''})`;
    $llmStatus.style.color = '#22c55e';
  } catch (err) {
    console.error('评分表请求失败:', err);
    $llmStatus.textContent = 'LLM: 网络错误';
    $llmStatus.style.color = '#ef4444';
  } finally {
    isGenerating = false;
    $btnJudgingScore.disabled = false;
  }
}

// ── 追问建议显示 ──────────────────────────────────────────
function parseSuggestionLines(rawText) {
  return rawText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line
      .replace(/^#{1,4}\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[\.\、\)]\s*/, '')
      .trim())
    .filter(line => line.length > 0 && !/^\[?NO_NEW_QUESTION\]?$/i.test(line))
    .map(text => {
      const tagMatch = text.match(/^(\[[^\]]+\])\s*(.*)$/);
      if (!tagMatch) {
        return { tag: '', text, used: false };
      }
      return {
        tag: tagMatch[1].slice(1, -1),
        text: tagMatch[2] || text,
        used: false
      };
    });
}

function addSuggestionGroup(rawText, groupType = 'suggestion', diagnostics = null) {
  let items = parseSuggestionLines(rawText);
  if (groupType === 'suggestion' && ['live-host', 'interview', 'recruitment'].includes($sceneMode.value)) {
    items = items.filter(item => /[？?]/.test(item.text));
  }
  if (groupType === 'suggestion') {
    items = filterNovelQuestionItems(items, item => item.text);
  }
  if (items.length === 0) return 0;

  const emptyState = $suggestionsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const createdAt = new Date();
  const groupRecord = {
    id: `group-${++exportGroupCounter}`,
    type: groupType,
    title: getSuggestionGroupTitle(groupType),
    createdAt: createdAt.toISOString(),
    sceneMode: $sceneMode.value,
    sceneLabel: getSceneLabel(),
    rawText,
    diagnostics,
    items
  };
  suggestionGroups.push(groupRecord);
  items.forEach(item => registerQuestionItem(item, groupType, createdAt));

  // 创建建议组
  const group = document.createElement('div');
  group.className = `suggestion-group ${['review', 'score'].includes(groupType) ? 'review-group' : ''}`;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.textContent = getSuggestionGroupHeader(groupType, createdAt);
  group.appendChild(header);

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    card.onclick = () => {
      card.classList.toggle('used');
      item.used = card.classList.contains('used');
      updateQuestionLedgerUsage(item);
    };

    if (item.tag) {
      card.classList.add(`tag-${getTagClass(item.tag)}`);

      const tag = document.createElement('div');
      tag.className = 'suggestion-tag';
      tag.textContent = item.tag;
      card.appendChild(tag);
    }

    if (['review', 'score'].includes(groupType)) {
      card.classList.add('review-card');
    }

    const textEl = document.createElement('div');
    textEl.className = 'suggestion-text';
    textEl.textContent = item.text;

    card.appendChild(textEl);
    group.appendChild(card);
    suggestionCount++;
  });

  // 插入到最前面
  $suggestionsContainer.insertBefore(group, $suggestionsContainer.firstChild);
  $suggestionCount.textContent = suggestionCount;
  return items.length;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function addDeepSuggestionGroup(suggestions, triggerType, notice = '', diagnostics = null) {
  let items = suggestions
    .map(item => ({
      tag: normalizeDeepTag(item.tag),
      question: (item.question || '').trim(),
      why: (item.why || '').trim(),
      basedOn: (item.basedOn || '').trim(),
      confidence: normalizeOptionalNumber(item.confidence),
      candidateScore: normalizeOptionalNumber(item.candidateScore),
      selectionScore: normalizeOptionalNumber(item.selectionScore),
      selectionReason: (item.selectionReason || '').trim()
    }))
    .filter(item => item.question);

  items = filterNovelQuestionItems(items, item => item.question).slice(0, 1);
  if (items.length === 0) return 0;

  const emptyState = $suggestionsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const createdAt = new Date();
  const groupRecord = {
    id: `group-${++exportGroupCounter}`,
    type: 'deep',
    title: '深度追问',
    createdAt: createdAt.toISOString(),
    sceneMode: $sceneMode.value,
    sceneLabel: getSceneLabel(),
    triggerType,
    notice,
    diagnostics,
    items: items.map(item => ({ ...item, text: item.question, used: false }))
  };
  suggestionGroups.push(groupRecord);
  groupRecord.items.forEach(item => registerQuestionItem(item, 'deep', createdAt));

  const group = document.createElement('div');
  group.className = 'suggestion-group deep-group';

  const header = document.createElement('div');
  header.className = 'group-header deep-header';
  header.textContent = `深度追问 · ${formatTime(createdAt)}${triggerType === 'auto' ? ' · 自动' : ''}`;
  group.appendChild(header);

  if (notice) {
    const noticeEl = document.createElement('div');
    noticeEl.className = 'deep-notice';
    noticeEl.textContent = notice;
    group.appendChild(noticeEl);
  }

  items.forEach((item, index) => {
    const recordItem = groupRecord.items[index];
    const card = document.createElement('div');
    card.className = `suggestion-card deep-card tag-${getTagClass(item.tag)}`;
    card.onclick = () => {
      card.classList.toggle('used');
      recordItem.used = card.classList.contains('used');
      updateQuestionLedgerUsage(recordItem);
    };

    const meta = document.createElement('div');
    meta.className = 'deep-meta';

    const badge = document.createElement('span');
    badge.className = 'deep-badge';
    badge.textContent = 'DEEP';
    meta.appendChild(badge);

    const tag = document.createElement('span');
    tag.className = 'suggestion-tag';
    tag.textContent = item.tag;
    meta.appendChild(tag);

    const textEl = document.createElement('div');
    textEl.className = 'suggestion-text deep-question';
    textEl.textContent = item.question;

    const detail = document.createElement('div');
    detail.className = 'suggestion-detail';
    const basedOn = item.basedOn || item.why;
    const why = item.why && item.why !== item.basedOn ? ` 提醒：${item.why}` : '';
    detail.textContent = basedOn ? `依据：${basedOn}${why}` : '依据：来自最近一轮完整表达';

    card.appendChild(meta);
    card.appendChild(textEl);
    card.appendChild(detail);
    group.appendChild(card);
    suggestionCount++;
  });

  $suggestionsContainer.insertBefore(group, $suggestionsContainer.firstChild);
  $suggestionCount.textContent = suggestionCount;
  return items.length;
}

function normalizeDeepTag(tag) {
  const text = (tag || '').replace(/[\[\]]/g, '').trim();
  return ['追问', '回扣', '反差', '澄清', '风险'].includes(text) ? text : '追问';
}

function getSuggestionGroupHeader(groupType, date = new Date()) {
  return `${formatTime(date)}${getSuggestionGroupTitle(groupType) ? ` · ${getSuggestionGroupTitle(groupType)}` : ''}`;
}

function getSuggestionGroupTitle(groupType) {
  const titleMap = {
    review: '面试复盘',
    score: '评审评分表'
  };
  return titleMap[groupType] || '';
}

function getTagClass(tagText) {
  const map = {
    '事实': 'fact',
    '风险': 'risk',
    '推荐': 'action',
    '追问': 'action',
    '谈判': 'deal',
    '问题': 'question',
    '考察点': 'intent',
    '结构': 'structure',
    '素材': 'material',
    '破冰': 'icebreaker',
    '共鸣': 'empathy',
    '自我披露': 'share',
    '转场': 'transition',
    '边界': 'boundary',
    '证据': 'fact',
    '疑点': 'risk',
    '亮点': 'deal',
    '回扣': 'material',
    '反差': 'risk',
    '澄清': 'question'
  };
  return map[tagText] || 'note';
}

// ── 会后复盘导出 ──────────────────────────────────────────
function clearStopExportPromptTimer() {
  if (stopExportPromptTimer) {
    clearTimeout(stopExportPromptTimer);
    stopExportPromptTimer = null;
  }
}

function scheduleStopExportPrompt() {
  clearStopExportPromptTimer();
  if (exportPromptedForSession) return;

  stopExportPromptTimer = setTimeout(() => {
    stopExportPromptTimer = null;
    if (isRecording || exportPromptedForSession || !hasExportableContent()) return;

    exportPromptedForSession = true;
    if (confirm('本轮对话已停止，要导出复盘包吗？')) {
      exportReviewPackage('stop');
    }
  }, 3400);
}

function hasExportableContent() {
  return fullTranscript.trim().length > 0 || transcriptTurns.length > 0 || suggestionGroups.length > 0;
}

async function exportReviewPackage(source = 'manual') {
  if (!hasExportableContent()) {
    alert('还没有可导出的记录。先录音或生成一些 AI 追问/判断点后再导出。');
    return;
  }
  if (isExporting) {
    alert('正在导出中，请稍候...');
    return;
  }

  isExporting = true;
  if ($btnExportReview) $btnExportReview.disabled = true;
  $llmStatus.textContent = 'LLM: 整理复盘包...';
  $llmStatus.style.color = '#f59e0b';

  const payload = buildExportPayload(source);
  let recap = '';
  let recapError = '';
  let recapModel = '';
  let recapDiagnostics = null;

  try {
    const recapRes = await fetch('/api/export-recap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        scriptContent: scriptContent || ''
      })
    });
    const recapData = await recapRes.json();
    if (!recapRes.ok) {
      recapError = recapData.error || 'AI 整理失败';
    } else {
      recap = recapData.recap || '';
      recapModel = recapData.model || '';
      recapDiagnostics = recapData.diagnostics || null;
    }
  } catch (err) {
    recapError = err.message || 'AI 整理请求失败';
  }

  const exportData = {
    ...payload,
    recap: {
      markdown: recap,
      error: recapError,
      model: recapModel,
      diagnostics: recapDiagnostics
    }
  };
  const markdown = buildExportMarkdown(exportData);
  const baseName = buildExportBaseName(exportData);

  try {
    const packageRes = await fetch('/api/export-package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseName,
        markdown,
        json: exportData
      })
    });

    if (!packageRes.ok) {
      let message = '导出 ZIP 失败';
      try {
        const data = await packageRes.json();
        message = data.error || message;
      } catch (_) {}
      alert(message);
      $llmStatus.textContent = `LLM: ${message}`;
      $llmStatus.style.color = '#ef4444';
      return;
    }

    const blob = await packageRes.blob();
    downloadBlob(blob, `${baseName}.zip`);
    exportPromptedForSession = true;
    $llmStatus.textContent = recapError ? 'LLM: 已导出（整理失败，保留原始记录）' : 'LLM: 复盘包已导出';
    $llmStatus.style.color = recapError ? '#f59e0b' : '#22c55e';
  } catch (err) {
    alert('导出失败: ' + err.message);
    $llmStatus.textContent = 'LLM: 导出失败';
    $llmStatus.style.color = '#ef4444';
  } finally {
    isExporting = false;
    if ($btnExportReview) $btnExportReview.disabled = false;
  }
}

function buildExportPayload(source) {
  const exportedAt = new Date();
  const startedAt = sessionStartedAt || inferFirstTranscriptTime() || exportedAt.toISOString();
  const reportedEndedAt = sessionEndedAt || exportedAt.toISOString();
  const lastTranscriptAt = inferLastTranscriptTime();
  const inactiveTailSeconds = lastTranscriptAt
    ? Math.max(0, Math.round((Date.parse(reportedEndedAt) - Date.parse(lastTranscriptAt)) / 1000))
    : 0;
  const endedAt = inactiveTailSeconds > 300 ? lastTranscriptAt : reportedEndedAt;
  const durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));

  return {
    schemaVersion: '1.1',
    exportedAt: exportedAt.toISOString(),
    source,
    session: {
      sceneMode: $sceneMode.value,
      sceneLabel: getSceneLabel(),
      startedAt,
      endedAt,
      durationSeconds,
      durationText: formatDurationText(durationSeconds),
      model: appConfig.model || '',
      models: appConfig.models || {},
      llmProvider: appConfig.llmProvider || '',
      inactiveTailSeconds,
      transcriptCharCount: fullTranscript.length,
      suggestionCount,
      uploadedMaterial: scriptMeta ? { ...scriptMeta } : null
    },
    suggestionGroups: serializeSuggestionGroups(),
    questionLedger: questionLedger.map(item => ({ ...item })),
    conversationMemory,
    speakerRoles: speakerOrder.map(speakerId => ({
      speakerId,
      speakerLabel: getSpeakerLabel(speakerId),
      role: speakerRoleMap[speakerId] || '',
      source: speakerRoleSource[speakerId] || ''
    })),
    transcript: {
      text: fullTranscript,
      turns: serializeTranscriptTurns()
    }
  };
}

function inferFirstTranscriptTime() {
  const firstTurn = transcriptTurns.find(turn => turn.receivedAt);
  return firstTurn ? new Date(firstTurn.receivedAt).toISOString() : null;
}

function inferLastTranscriptTime() {
  const lastTurn = [...transcriptTurns].reverse().find(turn => turn.receivedAt);
  return lastTurn ? new Date(lastTurn.receivedAt).toISOString() : null;
}

function serializeSuggestionGroups() {
  return suggestionGroups.map(group => ({
    id: group.id,
    type: group.type,
    title: group.title || getSuggestionGroupTitle(group.type),
    createdAt: group.createdAt,
    sceneMode: group.sceneMode,
    sceneLabel: group.sceneLabel,
    triggerType: group.triggerType || '',
    notice: group.notice || '',
    rawText: group.rawText || '',
    diagnostics: group.diagnostics || null,
    items: (group.items || []).map(item => ({
      tag: item.tag || '',
      text: item.text || item.question || '',
      question: item.question || '',
      why: item.why || '',
      basedOn: item.basedOn || '',
      confidence: item.confidence ?? null,
      candidateScore: item.candidateScore ?? null,
      selectionScore: item.selectionScore ?? null,
      selectionReason: item.selectionReason || '',
      detail: item.detail || item.basedOn || item.why || '',
      ledgerId: item.ledgerId || '',
      used: !!item.used
    }))
  }));
}

function serializeTranscriptTurns() {
  return transcriptTurns.map(turn => ({
    id: turn.id,
    speakerId: turn.speakerId || '',
    speakerLabel: getSpeakerLabel(turn.speakerId),
    role: speakerRoleMap[turn.speakerId] || '',
    displayName: getSpeakerDisplayName(turn.speakerId),
    text: turn.text,
    startMs: turn.startMs,
    endMs: turn.endMs,
    receivedAt: turn.receivedAt ? new Date(turn.receivedAt).toISOString() : ''
  }));
}

function buildExportBaseName(exportData) {
  return `把天聊下去-复盘包-${exportData.session.sceneLabel}-${formatFileTimestamp(new Date(exportData.exportedAt))}`
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');
}

function buildExportMarkdown(exportData) {
  const session = exportData.session;
  const lines = [];
  lines.push(`# 把天聊下去复盘包 - ${session.sceneLabel}`);
  lines.push(`导出时间：${formatReadableDateTime(exportData.exportedAt)}`);

  lines.push([
    '## 会话元信息',
    `- 场景：${session.sceneLabel}`,
    `- 开始：${formatReadableDateTime(session.startedAt)}`,
    `- 结束：${formatReadableDateTime(session.endedAt)}`,
    `- 时长：${session.durationText || '00:00:00'}`,
    `- 模型：${session.model || '未记录'}`,
    `- LLM 中转：${session.llmProvider || '未记录'}`,
    ...(session.inactiveTailSeconds > 300
      ? [`- 已排除停止收音后的空闲时长：${formatDurationText(session.inactiveTailSeconds)}`]
      : []),
    `- AI 输出卡片：${session.suggestionCount} 条`,
    `- 转写字数：${session.transcriptCharCount} 字`,
    `- 上传资料：${session.uploadedMaterial ? `${session.uploadedMaterial.filename}（${session.uploadedMaterial.charCount || 0} 字）` : '无'}`
  ].join('\n'));

  lines.push([
    '## AI 会后整理',
    exportData.recap.error
      ? `> AI 整理失败：${escapeMarkdownInline(exportData.recap.error)}\n\n以下内容保留原始记录，方便手动复盘。`
      : (exportData.recap.markdown || '（AI 未返回整理内容）')
  ].join('\n\n'));

  lines.push([
    '## 判断点总览',
    buildJudgmentSummaryMarkdown(exportData.suggestionGroups)
  ].join('\n\n'));

  lines.push([
    '## 评分表 / 复盘结果',
    buildReviewScoreMarkdown(exportData.suggestionGroups)
  ].join('\n\n'));

  lines.push([
    '## 追问与判断点原始记录',
    buildRawSuggestionGroupsMarkdown(exportData.suggestionGroups)
  ].join('\n\n'));

  lines.push([
    '## 实时转写附录',
    exportData.transcript.text.trim()
      ? `\`\`\`text\n${escapeFenceText(exportData.transcript.text.trim())}\n\`\`\``
      : '（没有转写内容）'
  ].join('\n\n'));

  return `${lines.join('\n\n')}\n`;
}

function buildJudgmentSummaryMarkdown(groups) {
  const priorities = ['证据', '疑点', '风险', '亮点', '追问', '深度追问', '回扣', '反差', '澄清', '推荐', '谈判', '问题', '考察点', '结构', '素材', '其他'];
  const buckets = new Map(priorities.map(tag => [tag, []]));

  groups
    .filter(group => !['review', 'score'].includes(group.type))
    .forEach(group => {
      (group.items || []).forEach(item => {
        const tag = item.tag || (group.type === 'deep' ? '深度追问' : '其他');
        const bucket = buckets.get(tag) || buckets.get('其他');
        const detail = item.detail || item.basedOn || item.why || '';
        bucket.push({
          text: item.text || item.question || '',
          detail,
          time: group.createdAt,
          used: item.used
        });
      });
    });

  const sections = priorities
    .map(tag => {
      const items = buckets.get(tag) || [];
      if (items.length === 0) return '';
      const body = items.map(item => {
        const used = item.used ? '（已标记使用）' : '';
        const detail = item.detail ? `\n  - 依据：${escapeMarkdownInline(item.detail)}` : '';
        return `- ${escapeMarkdownInline(item.text)}${used}${detail}`;
      }).join('\n');
      return `### ${tag}\n${body}`;
    })
    .filter(Boolean);

  return sections.length > 0 ? sections.join('\n\n') : '（暂无可分组的判断点）';
}

function buildReviewScoreMarkdown(groups) {
  const reviewGroups = groups.filter(group => ['review', 'score'].includes(group.type));
  if (reviewGroups.length === 0) return '（未生成评分表或复盘结果）';

  return reviewGroups.map(group => {
    const title = group.title || getSuggestionGroupTitle(group.type) || '复盘结果';
    const raw = group.rawText || (group.items || []).map(item => item.text).join('\n');
    return `### ${formatReadableDateTime(group.createdAt)} · ${title}\n\n${raw}`;
  }).join('\n\n');
}

function buildRawSuggestionGroupsMarkdown(groups) {
  if (groups.length === 0) return '（没有 AI 输出记录）';

  return groups.map(group => {
    const title = group.title || getSuggestionGroupTitle(group.type) || 'AI 输出';
    const meta = [
      formatReadableDateTime(group.createdAt),
      title,
      group.triggerType === 'auto' ? '自动' : group.triggerType === 'manual' ? '手动' : ''
    ].filter(Boolean).join(' · ');
    const body = (group.items || []).map(item => {
      const tag = item.tag ? `[${item.tag}] ` : '';
      const text = item.text || item.question || '';
      const detail = item.detail || item.basedOn || item.why || '';
      const used = item.used ? '（已标记使用）' : '';
      return `- ${tag}${escapeMarkdownInline(text)}${used}${detail ? `\n  - 依据：${escapeMarkdownInline(detail)}` : ''}`;
    }).join('\n') || '（无结构化条目）';
    return `### ${meta}\n${body}`;
  }).join('\n\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSceneLabel() {
  return $sceneMode.selectedOptions?.[0]?.textContent || $sceneMode.value;
}

function formatDurationText(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatFileTimestamp(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}`;
}

function formatReadableDateTime(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function escapeMarkdownInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeFenceText(text) {
  return String(text || '').replace(/```/g, '`\\`\\`');
}

// ── 资料上传 ──────────────────────────────────────────────
async function uploadScript(input) {
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload-script', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (!res.ok) {
      alert('上传失败: ' + data.error);
      return;
    }

    scriptContent = data.content;
    scriptMeta = {
      filename: data.filename,
      charCount: data.charCount,
      loadedAt: new Date().toISOString()
    };
    $scriptStatus.textContent = `已加载资料: ${data.filename} (${data.charCount} 字)`;
  } catch (err) {
    alert('上传失败: ' + err.message);
  }

  // 清空 input，允许重复上传同一文件
  input.value = '';
}

// ── 状态管理 ──────────────────────────────────────────────
function setStatus(state, text) {
  $statusDot.className = `status-dot ${state}`;
  $statusText.textContent = text;
}

// ── 工具函数 ──────────────────────────────────────────────
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function updateElapsedTime() {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  $elapsedTime.textContent = `${h}:${m}:${s}`;
}

// ── 快捷键 ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Cmd/Ctrl + Enter → 手动触发追问
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    manualTrigger();
  }
});

// ── 启动 ──────────────────────────────────────────────────
init();
