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

// 对话数据
let fullTranscript = '';         // 全量转写文本
let newTextSinceLastTrigger = ''; // 上次触发后的新增文本
let suggestionCount = 0;
let speakerOrder = [];
let speakerLabelMap = {};
let speakerRoleMap = {};
let transcriptTurns = [];
let recentTurnKeys = new Map();
let turnCounter = 0;

// 上传资料内容
let scriptContent = '';

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
  'recording': ['讲述者', '协作者'],
  'training': ['讲师', '学员'],
  default: ['说话人 A', '说话人 B']
};

// 配置（从后端加载）
let appConfig = {
  silenceThreshold: 3000,
  minInterval: 30000,
  minTextLength: 100,
  model: '',
  hasApiKey: false,
  hasAsrConfig: false
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
const $interimText = document.getElementById('interimText');
const $charCount = document.getElementById('charCount');
const $btnScrollLock = document.getElementById('btnScrollLock');
const $btnInterviewReview = document.getElementById('btnInterviewReview');
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
    // 最终结果 → 添加到转写区
    $interimText.textContent = '';
    $interimText.classList.remove('active');

    // 去重：如果和上一次完全一样则跳过
    if (finalKey !== lastFinalText) {
      const changed = commitTranscriptTurns(incomingTurns);
      if (changed) {
        resetSilenceTimer();
      }
      lastFinalText = finalKey;
    }
  } else {
    // 中间结果 → 显示为临时文本
    $interimText.textContent = text;
    $interimText.classList.add('active');
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
      } else {
        addCommittedTurn(turn);
        triggerText += formatPromptTranscriptTurn(turn);
      }

      rememberTurn(turn);
      changed = true;
    });

  if (changed) {
    rebuildTranscriptState();
    newTextSinceLastTrigger += triggerText;
    updateCharCount();
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

function isFillerTurn(text) {
  return /^(嗯+|啊+|哦+|呃+|额+)$/i.test(text.trim());
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
  ensureSpeakerRole(turn.speakerId);
  transcriptTurns.push(turn);
  turn.element = renderTranscriptLine(turn);
  updateSpeakerRoleControls();
}

function rebuildTranscriptState() {
  fullTranscript = transcriptTurns.map(formatPromptTranscriptTurn).join('');
}

function getSpeakerLabel(speakerId) {
  if (!speakerId) return '';
  if (!speakerLabelMap[speakerId]) {
    speakerOrder.push(speakerId);
    speakerLabelMap[speakerId] = `说话人 ${speakerOrder.length}`;
    ensureSpeakerRole(speakerId);
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

function ensureSpeakerRole(speakerId) {
  if (!speakerId || speakerRoleMap[speakerId]) return;
  const roles = getSceneRoles();
  const index = speakerOrder.indexOf(speakerId);
  speakerRoleMap[speakerId] = roles[index] || '';
}

function getSceneRoles() {
  return SCENE_ROLE_PRESETS[$sceneMode.value] || SCENE_ROLE_PRESETS.default;
}

function syncSpeakerRolesWithScene() {
  const roles = getSceneRoles();
  speakerOrder.forEach((speakerId, index) => {
    const currentRole = speakerRoleMap[speakerId];
    speakerRoleMap[speakerId] = roles.includes(currentRole) ? currentRole : roles[index] || '';
  });
}

function updateSpeakerRoleControls() {
  if (!$speakerRoleControls) return;
  if (speakerOrder.length === 0) {
    $speakerRoleControls.hidden = true;
    $speakerRoleControls.innerHTML = '';
    return;
  }

  const roles = getSceneRoles();
  $speakerRoleControls.hidden = false;
  $speakerRoleControls.innerHTML = '';

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
      speakerRoleMap[speakerId] = select.value;
      refreshTranscriptSpeakerLabels();
      rebuildTranscriptState();
      updateCharCount();
    };

    item.appendChild(label);
    item.appendChild(select);
    $speakerRoleControls.appendChild(item);
  });
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
  $interimText.textContent = '';
  $interimText.classList.remove('active');

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ── 转写文本管理 ──────────────────────────────────────────
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
  $transcriptContainer.innerHTML = '';
  fullTranscript = '';
  newTextSinceLastTrigger = '';
  lastFinalText = '';
  speakerOrder = [];
  speakerLabelMap = {};
  speakerRoleMap = {};
  transcriptTurns = [];
  recentTurnKeys = new Map();
  turnCounter = 0;
  updateSpeakerRoleControls();
  updateCharCount();
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
        transcript: fullTranscript.slice(-3000),
        scriptContent: scriptContent || '',
        previousSummary: '',
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

    if (data.suggestions) {
      addSuggestionGroup(data.suggestions);
    }

    $llmStatus.textContent = `LLM: 已生成（${data.model || ''})`;
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

// ── 追问建议显示 ──────────────────────────────────────────
function addSuggestionGroup(rawText, groupType = 'suggestion') {
  const emptyState = $suggestionsContainer.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // 解析建议（按行拆分，去掉空行和序号前缀）
  const lines = rawText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line
      .replace(/^#{1,4}\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[\.\、\)]\s*/, '')
      .trim());

  if (lines.length === 0) return;

  // 创建建议组
  const group = document.createElement('div');
  group.className = `suggestion-group ${groupType === 'review' ? 'review-group' : ''}`;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.textContent = groupType === 'review' ? `${formatTime(new Date())} · 面试复盘` : formatTime(new Date());
  group.appendChild(header);

  lines.forEach(text => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    card.onclick = () => card.classList.toggle('used');

    const tagMatch = text.match(/^(\[[^\]]+\])\s*(.*)$/);
    if (tagMatch) {
      const tagText = tagMatch[1].slice(1, -1);
      text = tagMatch[2] || text;
      card.classList.add(`tag-${getTagClass(tagText)}`);

      const tag = document.createElement('div');
      tag.className = 'suggestion-tag';
      tag.textContent = tagText;
      card.appendChild(tag);
    }

    if (groupType === 'review') {
      card.classList.add('review-card');
    }

    const textEl = document.createElement('div');
    textEl.className = 'suggestion-text';
    textEl.textContent = text;

    card.appendChild(textEl);
    group.appendChild(card);
    suggestionCount++;
  });

  // 插入到最前面
  $suggestionsContainer.insertBefore(group, $suggestionsContainer.firstChild);
  $suggestionCount.textContent = suggestionCount;
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
    '边界': 'boundary'
  };
  return map[tagText] || 'note';
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
