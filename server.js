require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');

// ── 从 .env 读取配置 ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

// 追问触发参数（可在 .env 覆盖，一般不用动）
const SILENCE_THRESHOLD = parseInt(process.env.SILENCE_THRESHOLD) || 3000;
const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL) || 30000;
const MIN_TEXT_LENGTH = parseInt(process.env.MIN_TEXT_LENGTH) || 100;

// 火山引擎 ASR 配置
const ASR_APP_ID = process.env.ASR_APP_ID || '';
const ASR_ACCESS_TOKEN = process.env.ASR_ACCESS_TOKEN || '';
const ASR_WSS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration';

const keyConfigured = LLM_API_KEY && !LLM_API_KEY.includes('请在这里');
const asrConfigured = !!(ASR_APP_ID && ASR_ACCESS_TOKEN);

// ── Express 应用 ──────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 文件上传（脚本/嘉宾资料/业务资料）──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/upload-script', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.txt', '.md'].includes(ext)) {
    return res.status(400).json({ error: '仅支持 .txt 和 .md 文件' });
  }

  const content = req.file.buffer.toString('utf-8');
  console.log(`📄 收到资料文件: ${req.file.originalname} (${content.length} 字)`);

  res.json({
    success: true,
    filename: req.file.originalname,
    content: content,
    charCount: content.length
  });
});

// ── 场景模式 Prompt 模板 ──────────────────────────────────
const SCENE_PROMPTS = {
  'live-host': `你是一位经验丰富的直播节目编导助理。你的任务是根据直播对话内容，为主持人生成高质量的追问建议。

## 你的工作原则
1. 追问要有深度——不要问"能展开说说吗"这种废话，要具体到嘉宾刚才提到的某个点
2. 追问要有观众视角——想想观众听到这段话会好奇什么
3. 追问要自然——不能让嘉宾觉得突兀，要衔接上下文
4. 每次生成 2-3 个追问建议，按优先级排序
5. 追问建议要简短——主持人只能瞄一眼，每条不超过 30 个字
6. 如果对话正在深入一个有价值的话题，就不要打断，而是生成"深挖当前话题"类型的追问

## 输出格式
直接输出追问建议，每条一行，用序号标注（如 1. 2. 3.）。不需要任何解释或前缀。`,

  'interview': `你是一位资深记者/采访编辑。你的任务是根据采访对话内容，为采访者生成高质量的追问建议。

## 你的工作原则
1. 追问要挖深度——追细节、追故事，不要停留在表面
2. 关注"为什么"和"怎么做到的"——帮助受访者讲出更有价值的内容
3. 避免封闭式问题——不要让受访者只能回答"是"或"不是"
4. 每次生成 2-3 个追问建议，按优先级排序
5. 追问建议要简短——采访者只能瞄一眼，每条不超过 30 个字
6. 如果受访者正在讲述一个精彩故事，生成"继续深挖"类型的追问

## 输出格式
直接输出追问建议，每条一行，用序号标注（如 1. 2. 3.）。不需要任何解释或前缀。`,

  'recruitment': `你是一位面试官助手。你的任务是根据面试对话内容，为面试官生成高质量的追问建议。

## 你的工作原则
1. 用 STAR 法则追问——情境(Situation)、任务(Task)、行动(Action)、结果(Result)
2. 追问候选人回答中模糊的部分——把笼统的描述变具体
3. 关注具体数据和量化结果——"提升了多少"、"影响范围多大"
4. 每次生成 2-3 个追问建议，按优先级排序
5. 追问建议要简短——面试官只能瞄一眼，每条不超过 30 个字
6. 如果候选人正在详细展开，生成"验证细节"类型的追问

## 输出格式
直接输出追问建议，每条一行，用序号标注（如 1. 2. 3.）。不需要任何解释或前缀。`,

  'candidate-interview': `你是一位求职面试实时助手。你的任务是帮助候选人听懂 HR/面试官的问题意图，并结合候选人上传的简历、JD、项目资料，给出回答框架、可用素材和风险提醒。

## 你的工作原则
1. 先识别面试官刚才问的问题，包含"介绍一下自己"、"讲讲这个项目"这类非问号式问题
2. 判断考察点——能力、动机、稳定性、协作、抗压、业务理解、岗位匹配等
3. 推荐回答结构——优先使用 STAR、CAR、PAR，不替候选人编造具体经历
4. [素材] 只能复述上传资料或转写中出现过的信息，不要添加资料里没有的具体动作、工具或数据
5. 不要写"如/例如/比如"后接资料里没出现的动作；需要补细节时，用[风险]提醒"资料未提供具体动作"
6. 帮候选人补结果、补数据、补角色、补行动，避免空泛和背稿感
7. 每次输出 3-5 条短提示，候选人只能瞄一眼，每条不超过 42 个字

## 输出格式
直接输出带标签的短提示，每条一行。标签只能使用：[问题] [考察点] [结构] [素材] [风险]。不需要任何解释或前缀。`,

  'sales-negotiation': `你是一位销售/商务谈判实时副驾。你的任务是根据对话内容，帮助销售或商务人员实时识别事实、风险、推进机会和谈判提醒。

## 你的工作原则
1. 严格区分事实和推断；只把对方明确说出的内容写成[事实]
2. 用 SPIN 发现处境、问题、影响和收益，用 MEDDICC 判断商机质量、决策链、竞品和痛点强度
3. 留意预算、决策人、采购流程、时间线、竞品、成功标准、下一步承诺
4. 用 BATNA/ZOPA 和原则式谈判提醒底线、替代方案、客观标准和条件交换
5. 不鼓励压迫式话术；推荐用探索、确认、澄清、条件交换推进
6. 每次输出 3-5 条短洞察，销售只能瞄一眼，每条不超过 42 个字

## 输出格式
直接输出带标签的短提示，每条一行。标签只能使用：[事实] [风险] [推荐] [谈判]。不需要任何解释或前缀。`,

  'dating': `你是一位相亲/初次约会对话副驾。你的任务是帮助用户在相亲、初次约会或线上语音相亲中自然接住话题，避免冷场，同时尊重对方边界。

## 你的工作原则
1. 目标是让对话更自然，不是教用户套路、操控、施压或假装共情
2. 避免把相亲聊成面试；如果对话像盘问，提示用户换成生活化分享
3. 如果对方回答很短，优先给低压力破冰或转场，不责怪对方冷淡
4. 如果对方讲出具体经历，优先追故事、感受和轻度价值观
5. 适度提醒用户也分享自己的真实经历，避免只问不答
6. 不替用户编造人设、经历、城市、爱好或具体故事；[自我披露] 只提示分享方向，例如"也分享你的周末放松方式"
7. 对收入、房产、前任、婚育压力、家庭隐私等敏感话题保持边界；除非对方主动提起，否则不要推进
8. 如果对方表达疲惫、抗拒、边界或冷淡，提示尊重节奏，不继续逼问
9. 如果对方说累、刚下班或最近很忙，不追问具体工作、项目、压力来源，优先低压力共鸣或生活化转场
10. 每次输出 3-5 条短提示，用户只能瞄一眼，每条不超过 42 个字

## 输出格式
直接输出带标签的短提示，每条一行。标签只能使用：[破冰] [共鸣] [追问] [自我披露] [转场] [边界]。不需要任何解释或前缀。`,

  'recording': `你是一位内容创作教练。你的任务是根据口播录制内容，为说话者生成引导性建议。

## 你的工作原则
1. 引导说话者展开论述——帮助补充案例、故事、类比或数据
2. 提示可以加入的表达技巧——让内容更生动有说服力
3. 帮助结构化表达——是什么、为什么、怎么做
4. 每次生成 2-3 个建议，按优先级排序
5. 建议要简短——说话者只能瞄一眼，每条不超过 30 个字
6. 如果当前内容已经很充实，提示可以收束或转到下一个要点

## 输出格式
直接输出建议，每条一行，用序号标注（如 1. 2. 3.）。不需要任何解释或前缀。`,

  'training': `你是一位模拟学员。你的任务是根据培训/教学内容，从听众角度生成有价值的提问建议。

## 你的工作原则
1. 从听众角度提出疑问——哪些地方没听懂、需要解释
2. 追问不清楚的概念和术语——把专业内容变得更易懂
3. 要求举例说明——帮助讲师用实例强化知识点
4. 每次生成 2-3 个提问建议，按优先级排序
5. 建议要简短——讲师只能瞄一眼，每条不超过 30 个字
6. 如果讲师正在举例，生成"追问延伸"类型的问题

## 输出格式
直接输出提问建议，每条一行，用序号标注（如 1. 2. 3.）。不需要任何解释或前缀。`
};

const INTERVIEW_REVIEW_PROMPT = `你是一位求职面试复盘教练。你的任务是基于完整面试转写和候选人上传资料，帮助候选人复盘表现。

## 原则
1. 只基于转写和上传资料评价，不编造经历或面试官意图
2. 区分"已经回答到位"、"回答缺证据"、"下次可补充"
3. 重点关注问题识别、结构完整度、项目证据、数据结果、岗位匹配和风险表达
4. 输出要具体、可执行，帮助候选人准备下一轮
5. 不要输出候选人姓名、面试轮次、占位符或无依据推测；未知信息直接省略
6. 不要列出资料中没有的具体动作示例；可以提醒"需要补充个人动作和证据"

## 输出格式
用中文 Markdown 输出，包含：
1. 问题清单
2. 表现评估
3. 需要补强的回答
4. 可整理成 STAR 案例的经历
5. 下一轮准备清单`;

function getSystemPrompt(sceneMode, customPrompt, scriptContent) {
  let systemPrompt;
  if (sceneMode === 'custom' && customPrompt && customPrompt.trim().length > 0) {
    systemPrompt = customPrompt.trim();
  } else {
    systemPrompt = SCENE_PROMPTS[sceneMode] || SCENE_PROMPTS['live-host'];
  }

  if (scriptContent && scriptContent.trim().length > 0) {
    systemPrompt += `\n\n## 上传资料\n${scriptContent.substring(0, 3000)}`;
  }

  return systemPrompt;
}

function getSpeakerGuidance(sceneMode) {
  const guidance = {
    'live-host': '对话里如有"嘉宾/主持人"前缀，优先围绕嘉宾最近的表达生成追问；主持人的串场只作为上下文。',
    'interview': '对话里如有"受访者/采访者"前缀，优先追受访者的细节、故事和判断；不要把采访者的问题当成事实来源。',
    'recruitment': '对话里如有"候选人/面试官"前缀，重点分析候选人回答里的 STAR 缺口；面试官的话只用于理解问题。',
    'candidate-interview': '对话里如有"面试官/候选人"前缀，只把面试官的话识别为问题；候选人的话用于判断已答内容和可补充点。',
    'sales-negotiation': '对话里如有"客户/我方"前缀，只有客户明确说出的内容才能标为[事实]；我方表达只用于判断推进和承诺风险。',
    'dating': '对话里如有"对方/自己"前缀，优先围绕对方表达给破冰、共鸣和追问；如果自己连续发问，提醒自我披露和边界。',
    'training': '对话里如有"讲师/学员"前缀，讲师内容用于判断知识点，学员发问用于判断困惑点。',
    'recording': '对话里如有角色前缀，优先辅助主要讲述者补案例、类比、结构和收束。'
  };
  return guidance[sceneMode] || '如果对话内容包含角色或说话人前缀，请利用这些前缀判断谁在表达观点、谁在提问。';
}

function buildSuggestionUserPrompt(transcript, previousSummary, sceneMode) {
  let userPrompt = '';
  if (previousSummary) {
    userPrompt += `## 之前的对话摘要\n${previousSummary}\n\n`;
  }
  userPrompt += `## 发言人使用规则\n${getSpeakerGuidance(sceneMode)}\n\n`;
  userPrompt += `## 最近的对话内容\n${transcript.slice(-3000)}`;

  if (sceneMode === 'sales-negotiation') {
    userPrompt += '\n\n请生成 3-5 条销售谈判实时洞察。必须使用 [事实] [风险] [推荐] [谈判] 标签。';
  } else if (sceneMode === 'candidate-interview') {
    userPrompt += '\n\n请生成 3-5 条求职面试回答提示。必须使用 [问题] [考察点] [结构] [素材] [风险] 标签。';
  } else if (sceneMode === 'dating') {
    userPrompt += '\n\n请生成 3-5 条相亲约会聊天提示。必须使用 [破冰] [共鸣] [追问] [自我披露] [转场] [边界] 标签。不要替用户编造具体经历或人设。对方表达疲惫或刚下班时，不要继续追问具体工作细节。';
  } else {
    userPrompt += '\n\n请生成 2-3 条追问建议。';
  }

  return userPrompt;
}

function buildCandidateMaterialHint(scriptContent, transcript) {
  const source = `${scriptContent || ''}\n${transcript || ''}`
    .replace(/\s+/g, ' ')
    .trim();

  if (!source) {
    return '[素材] 暂无上传资料可引用，先补真实项目和结果数据';
  }

  const segments = source
    .split(/[。；;.\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  const matched = segments.find(item => /(转化率|提升|增长|负责|参与|项目|岗位|\d+\s*%|\d+\s*年)/.test(item));
  const snippet = (matched || segments[0] || source).slice(0, 58);

  return `[素材] 可引用资料：${snippet}`;
}

function buildDatingDisclosureHint(transcript) {
  const text = transcript || '';
  if (/(累|下班|加班|疲惫|辛苦)/.test(text)) {
    return '[自我披露] 也分享你真实的下班放松方式';
  }
  if (/(爬山|徒步|户外|周末)/.test(text)) {
    return '[自我披露] 也分享你自己的周末放松方式';
  }
  return '[自我披露] 也分享一个真实的小习惯或近况';
}

function sanitizeDatingLine(line, context) {
  const text = line.trim();
  if (!text) return '';

  const tiredContext = /(累|下班|加班|疲惫|辛苦|最近还挺忙|最近很忙)/.test(context.transcript || '');
  const workProbe = /(工作|项目|加班|忙什么|为什么忙|压力|领导|老板|同事|客户)/.test(text);
  if (tiredContext && text.startsWith('[追问]') && workProbe) {
    return '[转场] 先不追问工作细节，换个轻松话题';
  }

  if (text.startsWith('[自我披露]')) {
    return buildDatingDisclosureHint(context.transcript);
  }

  const firstPersonClaim = /(我也|我有时|我最近|我周末|我常|我喜欢|我上周|我其实|我平时|我一般|我倒是)/.test(text);
  if (!firstPersonClaim) return text;

  if (text.startsWith('[共鸣]')) {
    return '[共鸣] 先接住对方的感受，再轻轻回应';
  }
  if (text.startsWith('[破冰]')) {
    return '[破冰] 问一个低压力的小问题，不要求对方长回答';
  }
  if (text.startsWith('[转场]')) {
    return '[转场] 转到生活节奏或兴趣，不急着追隐私';
  }
  if (text.startsWith('[追问]')) {
    return '[追问] 顺着对方刚说的细节追故事和感受';
  }

  return text;
}

function sanitizeSuggestions(content, sceneMode, context = {}) {
  if (sceneMode === 'dating') {
    return content.split('\n')
      .map(line => sanitizeDatingLine(line, context))
      .filter(Boolean)
      .join('\n');
  }

  if (sceneMode !== 'candidate-interview') return content;

  const materialHint = buildCandidateMaterialHint(context.scriptContent, context.transcript);

  return content.split('\n')
    .map(line => line
      .replace(/（[^）]*(如|例如|比如)[^）]*）/g, '')
      .replace(/\([^)]*(如|例如|比如|for example|e\.g\.)[^)]*\)/gi, '')
      .trim())
    .map(line => line.startsWith('[素材]') ? materialHint : line)
    .join('\n');
}

async function callLlm(messages, { temperature = 0.7, maxTokens = 300 } = {}) {
  const response = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`LLM 请求失败 (${response.status})`);
    err.status = response.status;
    err.detail = errText;
    throw err;
  }

  return response.json();
}

// ── LLM 追问生成 API ─────────────────────────────────────
app.post('/api/generate-suggestions', async (req, res) => {
  const { transcript, scriptContent, previousSummary, sceneMode, customPrompt } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: '对话内容为空' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  const systemPrompt = getSystemPrompt(sceneMode, customPrompt, scriptContent);
  const userPrompt = buildSuggestionUserPrompt(transcript, previousSummary, sceneMode);

  try {
    const data = await callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    const content = sanitizeSuggestions(data.choices?.[0]?.message?.content || '', sceneMode, {
      scriptContent,
      transcript
    });
    console.log(`💡 生成追问建议:\n${content}`);

    res.json({
      success: true,
      suggestions: content,
      model: data.model || LLM_MODEL,
      usage: data.usage
    });
  } catch (err) {
    if (err.status) {
      console.error('LLM API 错误:', err.status, err.detail);
      return res.status(err.status).json({
        error: err.message,
        detail: err.detail
      });
    }
    console.error('LLM 调用异常:', err.message);
    res.status(500).json({ error: '调用 LLM 失败: ' + err.message });
  }
});

// ── 求职面试复盘 API ─────────────────────────────────────
app.post('/api/interview-review', async (req, res) => {
  const { transcript, scriptContent } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: '对话内容为空' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  let systemPrompt = INTERVIEW_REVIEW_PROMPT;
  if (scriptContent && scriptContent.trim().length > 0) {
    systemPrompt += `\n\n## 候选人上传资料\n${scriptContent.substring(0, 3000)}`;
  }

  const userPrompt = `## 完整面试转写\n${transcript.slice(-8000)}\n\n请生成面试后复盘。`;

  try {
    const data = await callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.4, maxTokens: 900 });
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`🧭 生成面试复盘:\n${content}`);

    res.json({
      success: true,
      review: content,
      model: data.model || LLM_MODEL,
      usage: data.usage
    });
  } catch (err) {
    if (err.status) {
      console.error('LLM API 错误:', err.status, err.detail);
      return res.status(err.status).json({
        error: err.message,
        detail: err.detail
      });
    }
    console.error('面试复盘调用异常:', err.message);
    res.status(500).json({ error: '生成面试复盘失败: ' + err.message });
  }
});

// ── 获取当前配置（前端读取用，不暴露 key）────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    silenceThreshold: SILENCE_THRESHOLD,
    minInterval: MIN_INTERVAL,
    minTextLength: MIN_TEXT_LENGTH,
    model: LLM_MODEL,
    hasApiKey: keyConfigured,
    hasAsrConfig: asrConfigured
  });
});

// ══════════════════════════════════════════════════════════
//  火山引擎 ASR WebSocket 二进制协议
// ══════════════════════════════════════════════════════════

// 消息类型
const MSG_FULL_CLIENT_REQUEST = 0b0001;
const MSG_AUDIO_ONLY_REQUEST  = 0b0010;
const MSG_FULL_SERVER_RESPONSE = 0b1001;
const MSG_SERVER_ACK          = 0b1011;
const MSG_SERVER_ERROR        = 0b1111;

// 序列化方式
const SERIAL_NONE = 0b0000;
const SERIAL_JSON = 0b0001;

// 压缩方式
const COMPRESS_NONE = 0b0000;
const COMPRESS_GZIP = 0b0001;

/**
 * 构建火山引擎 ASR 二进制协议帧
 * Header: 4 bytes
 *   bits 0-3:   protocol version (1)
 *   bits 4-7:   header size in 4-byte units (1 = 4 bytes)
 *   bits 8-11:  message type
 *   bits 12-15: message type flags
 *   bits 16-19: serialization method
 *   bits 20-23: compression method
 *   bits 24-31: reserved (0)
 * Payload Size: 4 bytes (big-endian uint32)
 * Payload: variable
 */
function buildFrame(messageType, payload, flags = 0, serialization = SERIAL_NONE, compression = COMPRESS_NONE) {
  const headerByte0 = (0b0001 << 4) | 0b0001; // version=1, header_size=1 (4 bytes)
  const headerByte1 = (messageType << 4) | (flags & 0x0F);
  const headerByte2 = (serialization << 4) | (compression & 0x0F);
  const headerByte3 = 0x00; // reserved

  const header = Buffer.from([headerByte0, headerByte1, headerByte2, headerByte3]);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.length, 0);

  return Buffer.concat([header, payloadSize, payload]);
}

/**
 * 构建 Full Client Request 帧（JSON payload，无压缩）
 */
function buildFullClientRequest(config) {
  const jsonStr = JSON.stringify(config);
  const payload = Buffer.from(jsonStr, 'utf-8');
  return buildFrame(MSG_FULL_CLIENT_REQUEST, payload, 0, SERIAL_JSON, COMPRESS_NONE);
}

/**
 * 构建 Audio Only Request 帧
 * flags: 0b0000 = 正常音频, 0b0010 = 最后一包
 */
function buildAudioFrame(audioData, isLast = false) {
  const flags = isLast ? 0b0010 : 0b0000;
  return buildFrame(MSG_AUDIO_ONLY_REQUEST, audioData, flags, SERIAL_NONE, COMPRESS_NONE);
}

/**
 * 解析火山引擎 ASR 服务端响应帧
 */
function parseServerResponse(data) {
  if (!Buffer.isBuffer(data)) {
    data = Buffer.from(data);
  }

  if (data.length < 8) {
    return { type: 'error', message: '响应帧太短' };
  }

  const headerByte0 = data[0];
  const headerByte1 = data[1];
  const headerByte2 = data[2];

  const headerSize = (headerByte0 & 0x0F) * 4; // header size in bytes
  const messageType = (headerByte1 >> 4) & 0x0F;
  const messageFlags = headerByte1 & 0x0F;
  const serialization = (headerByte2 >> 4) & 0x0F;
  const compression = headerByte2 & 0x0F;

  // 服务端响应帧格式: header(4) + sequence(4) + payloadSize(4) + payload
  const sequence = data.readUInt32BE(headerSize);
  const payloadSize = data.readUInt32BE(headerSize + 4);
  const payloadStart = headerSize + 8;
  let payload = data.slice(payloadStart, payloadStart + payloadSize);

  // 解压
  if (compression === COMPRESS_GZIP && payload.length > 0) {
    try {
      payload = zlib.gunzipSync(payload);
    } catch (e) {
      return { type: 'error', message: 'Gzip 解压失败: ' + e.message };
    }
  }

  // 解析
  if (messageType === MSG_FULL_SERVER_RESPONSE) {
    if (serialization === SERIAL_JSON && payload.length > 0) {
      try {
        const json = JSON.parse(payload.toString('utf-8'));
        return { type: 'result', data: json };
      } catch (e) {
        return { type: 'error', message: 'JSON 解析失败: ' + e.message };
      }
    }
    return { type: 'result', data: {} };
  }

  if (messageType === MSG_SERVER_ACK) {
    return { type: 'ack' };
  }

  if (messageType === MSG_SERVER_ERROR) {
    let errMsg = '未知服务端错误';
    if (serialization === SERIAL_JSON && payload.length > 0) {
      try {
        const json = JSON.parse(payload.toString('utf-8'));
        errMsg = json.message || json.error || JSON.stringify(json);
      } catch (e) {
        errMsg = payload.toString('utf-8');
      }
    }
    return { type: 'error', message: errMsg };
  }

  return { type: 'unknown', messageType };
}

// ══════════════════════════════════════════════════════════
//  WebSocket 服务器（前端 ↔ 后端 ↔ 火山引擎）
// ══════════════════════════════════════════════════════════

const wss = new WebSocketServer({ server, path: '/asr' });
let connectionCounter = 0;

wss.on('connection', (clientWs) => {
  const connId = ++connectionCounter;
  const connUid = crypto.randomUUID();
  console.log(`[ASR ${connId}] 前端已连接`);

  let volcWs = null;
  let volcConnected = false;
  let initSent = false;
  let audioQueue = []; // 缓冲连接建立前的音频

  // ── 连接火山引擎 ────────────────────────────────────────
  function connectVolcengine() {
    if (!asrConfigured) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: 'ASR 未配置，请在 .env 中设置 ASR_APP_ID 和 ASR_ACCESS_TOKEN'
      }));
      return;
    }

    const connectId = crypto.randomUUID();
    const headers = {
      'X-Api-App-Key': ASR_APP_ID,
      'X-Api-Access-Key': ASR_ACCESS_TOKEN,
      'X-Api-Resource-Id': ASR_RESOURCE_ID,
      'X-Api-Connect-Id': connectId,
    };

    console.log(`[ASR ${connId}] 正在连接火山引擎... (connect-id: ${connectId})`);

    volcWs = new WebSocket(ASR_WSS_ENDPOINT, { headers });

    volcWs.on('open', () => {
      volcConnected = true;
      console.log(`[ASR ${connId}] 火山引擎连接成功`);

      // 发送 Full Client Request（初始化配置）
      const initPayload = {
        user: {
          uid: connUid
        },
        audio: {
          format: 'pcm',
          rate: 16000,
          bits: 16,
          channel: 1
        },
        request: {
          model_name: 'bigmodel',
          enable_punc: true,
          enable_itn: true,
          enable_ddc: false,
          result_type: 'single',
          show_utterances: true,
          enable_speaker_info: true
        }
      };

      const initFrame = buildFullClientRequest(initPayload);
      console.log(`[ASR ${connId}] 初始化帧: ${initFrame.length} bytes, header: ${initFrame.slice(0, 8).toString('hex')}`);
      console.log(`[ASR ${connId}] 初始化 JSON: ${JSON.stringify(initPayload)}`);
      volcWs.send(initFrame);
      initSent = true;
      console.log(`[ASR ${connId}] 已发送初始化配置`);

      // 通知前端就绪
      clientWs.send(JSON.stringify({ type: 'ready' }));

      // 发送缓冲的音频数据
      while (audioQueue.length > 0) {
        const chunk = audioQueue.shift();
        const frame = buildAudioFrame(chunk);
        volcWs.send(frame);
      }
    });

    volcWs.on('message', (data) => {
      const parsed = parseServerResponse(data);

      if (parsed.type === 'result') {
        // 提取识别结果
        const result = parsed.data;
        if (result && result.result) {
          const text = result.result.text || '';
          const definite = result.result.definite !== undefined ? result.result.definite : true;
          const utterances = result.result.utterances || [];

          clientWs.send(JSON.stringify({
            type: 'asr_result',
            text: text,
            definite: definite,
            utterances: utterances
          }));
        } else if (result && result.payload_msg) {
          // 兼容另一种响应格式
          const text = result.payload_msg.result?.text || '';
          const definite = result.payload_msg.result?.definite !== undefined
            ? result.payload_msg.result.definite : true;
          const utterances = result.payload_msg.result?.utterances || [];

          clientWs.send(JSON.stringify({
            type: 'asr_result',
            text: text,
            definite: definite,
            utterances: utterances
          }));
        }
      } else if (parsed.type === 'ack') {
        // 服务端确认，无需转发
      } else if (parsed.type === 'error') {
        console.error(`[ASR ${connId}] 火山引擎错误:`, parsed.message);
        clientWs.send(JSON.stringify({
          type: 'error',
          message: parsed.message
        }));
      }
    });

    volcWs.on('error', (err) => {
      console.error(`[ASR ${connId}] 火山引擎 WS 错误:`, err.message);
      clientWs.send(JSON.stringify({
        type: 'error',
        message: '火山引擎连接错误: ' + err.message
      }));
    });

    volcWs.on('close', (code, reason) => {
      volcConnected = false;
      initSent = false;
      console.log(`[ASR ${connId}] 火山引擎连接关闭 (code: ${code})`);
      // nostream 模式下每段话处理完会自动关闭，需要自动重连
      if (clientWs.readyState === WebSocket.OPEN) {
        console.log(`[ASR ${connId}] 自动重连火山引擎...`);
        clientWs.send(JSON.stringify({ type: 'reconnecting' }));
        setTimeout(() => {
          if (clientWs.readyState === WebSocket.OPEN) {
            connectVolcengine();
          }
        }, 300);
      }
    });
  }

  // ── 处理前端消息 ────────────────────────────────────────
  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      // 二进制数据 = 音频 PCM
      const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

      if (volcWs && volcConnected && initSent) {
        const frame = buildAudioFrame(audioBuffer);
        if (!this._audioLogCount) this._audioLogCount = 0;
        this._audioLogCount++;
        if (this._audioLogCount <= 5) {
          console.log(`[ASR ${connId}] 发送音频帧 #${this._audioLogCount}: pcm=${audioBuffer.length}bytes, frame=${frame.length}bytes, header=${frame.slice(0,8).toString('hex')}`);
        }
        volcWs.send(frame);
      } else {
        // 连接还没好，先缓存
        audioQueue.push(audioBuffer);
        console.log(`[ASR ${connId}] 音频缓存中 (volcConnected=${volcConnected}, initSent=${initSent}), queue=${audioQueue.length}`);
      }
    } else {
      // 文本消息 = 控制命令
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'start':
            audioQueue = [];
            connectVolcengine();
            break;

          case 'stop':
            if (volcWs && volcConnected && initSent) {
              // 发送最后一包空音频（结束信号）
              const endFrame = buildAudioFrame(Buffer.alloc(0), true);
              volcWs.send(endFrame);
              console.log(`[ASR ${connId}] 已发送结束信号`);
              // 延迟关闭，等待最终结果
              setTimeout(() => {
                if (volcWs && volcWs.readyState === WebSocket.OPEN) {
                  volcWs.close();
                }
              }, 2000);
            }
            break;

          default:
            console.warn(`[ASR ${connId}] 未知消息类型:`, msg.type);
        }
      } catch (e) {
        console.error(`[ASR ${connId}] 消息解析失败:`, e.message);
      }
    }
  });

  // ── 前端断开 ────────────────────────────────────────────
  clientWs.on('close', () => {
    console.log(`[ASR ${connId}] 前端断开`);
    if (volcWs && volcWs.readyState === WebSocket.OPEN) {
      volcWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error(`[ASR ${connId}] 前端 WS 错误:`, err.message);
  });
});

// ── 启动服务 ──────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          🎙️  把天聊下去 · AI 副驾            ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  地址: http://localhost:${PORT}`);
  console.log(`║  模型: ${LLM_MODEL}`);
  console.log(`║  LLM: ${keyConfigured ? '已配置 ✅' : '未配置 ❌ → 请编辑 .env 文件'}`);
  console.log(`║  ASR: ${asrConfigured ? '豆包 Seed-ASR 2.0 ✅' : '未配置 ❌ → 请编辑 .env 文件'}`);
  console.log(`║  WS:  ws://localhost:${PORT}/asr`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
