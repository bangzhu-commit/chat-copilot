require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');
const JSZip = require('jszip');
const { filterNovelItems } = require('./public/question-quality');

// ── 从 .env 读取配置 ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_MODEL_FAST = process.env.LLM_MODEL_FAST || LLM_MODEL;
const LLM_MODEL_DEEP = process.env.LLM_MODEL_DEEP || LLM_MODEL;
const LLM_MODEL_RECAP = process.env.LLM_MODEL_RECAP || LLM_MODEL;
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 60000;
const SUGGESTION_CONTEXT_CHARS = 12000;
const MEMORY_MAX_CHARS = 5000;
const LONG_CONTEXT_MEMORY_ENABLED = process.env.LONG_CONTEXT_MEMORY_ENABLED !== 'false';
const DEEP_CONTEXT_MAX_AGE_MS = 90000;
const DEEP_MIN_SCORE = 80;
const DEEP_MIN_CONFIDENCE = 70;

function getProviderHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (_) {
    return String(endpoint || '').replace(/^https?:\/\//, '').split('/')[0] || 'unknown';
  }
}

const LLM_PROVIDER_HOST = getProviderHost(LLM_ENDPOINT);

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
app.use(express.json({ limit: '8mb' }));
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

  const filename = normalizeUploadFilename(req.file.originalname);
  const ext = path.extname(filename).toLowerCase();
  if (!['.txt', '.md'].includes(ext)) {
    return res.status(400).json({ error: '仅支持 .txt 和 .md 文件' });
  }

  const content = req.file.buffer.toString('utf-8');
  console.log(`📄 收到资料文件: ${filename} (${content.length} 字)`);

  res.json({
    success: true,
    filename,
    content: content,
    charCount: content.length
  });
});

function normalizeUploadFilename(filename) {
  const original = String(filename || '资料');
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? original : decoded;
}

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

  'ai-judge': `你是一位公司内部 AI 应用比赛的评审助理。你的任务不是替评委决定名次，而是帮助评委按统一标准记录事实、发现亮点、识别疑点、提出追问和提醒风险。

## 你的工作原则
1. AI 只做评审助理，不直接决定获奖结果
2. 严格区分事实、证据和选手自述；没有证据支撑的主张只能标为[疑点]
3. 不因为选手表达流畅、故事讲得好、包装好看就给出正向判断
4. 只评价项目，不评价选手个人、部门、职级、人气或表达风格
5. 优先关注真实问题、业务价值、可用性、落地证据、AI 能力、安全边界和复用价值
6. 如果项目提到数据、上线、用户反馈、成本、权限、隐私或安全，提醒评委追问证据
7. 每次输出 3-5 条短观察，评委只能瞄一眼，每条不超过 46 个字

## 输出格式
直接输出带标签的短提示，每条一行。标签只能使用：[证据] [疑点] [追问] [风险] [亮点]。不需要任何解释或前缀。`,

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

const AI_JUDGING_SCORE_PROMPT = `你是一位公司内部 AI 应用比赛的评审助理。你的任务是基于完整转写和赛前资料，给评委生成一份可解释的参考评分表。

## 评分定位
1. 这只是参考评分，不直接决定名次
2. 人类评委保留最终裁量权
3. 不因表达流畅、包装好看或口号式表述加分
4. 高分必须有资料、现场演示、数据、案例或转写证据支持
5. 没有证据的主张要写成"待验证"，不能当成事实

## 默认评分标准（总分 100）
- 真实问题与业务价值：20 分
- 产品可用性与体验：20 分
- 落地效果与证据：20 分
- AI 能力与实现完整度：15 分
- 安全、合规、可控性：10 分
- 复用推广与成本收益：10 分
- 现场表达与演示：5 分

## 输出格式
用中文 Markdown 输出，包含：
1. 参考总分
2. 维度评分表
3. 主要亮点
4. 待验证问题
5. 建议评委追问
6. 赛后反馈摘要
7. AI 置信度

不要输出"好的"、"以下是"、"作为评审助理"等寒暄或开场白，直接从评分结果开始。`;

const EXPORT_RECAP_PROMPT = `你是一位会后复盘整理助手。你的任务是把实时对话副驾产生的 AI 观察、追问、疑点、风险、亮点和评分内容整理成一页可复盘的中文 Markdown。

## 依据优先级
1. 优先使用 AI 输出卡片里的标签、判断点、追问和依据
2. 其次使用完整转写补充上下文
3. 上传资料只作背景参考，不要逐段复述

## 输出要求
1. 不编造没有出现过的人名、公司、数据、承诺或结论
2. 区分“已经有证据”和“待核实/待追问”
3. 不要替人类评委直接定最终名次
4. 直接输出 Markdown，不要寒暄，不要代码块

## 固定结构
### 一句话结论
### 关键判断点
### 最值得回看的追问
### 疑点与风险
### 后续行动 / 待核实`;

const DEEP_SUPPORTED_SCENES = new Set([
  'live-host',
  'interview',
  'ai-judge',
  'sales-negotiation',
  'recruitment'
]);
const DEEP_ALLOWED_TAGS = new Set(['追问', '回扣', '反差', '澄清', '风险']);

const DEEP_SUGGESTION_PROMPT = `你是一位实时对话深度追问候选生成器。你的任务不是救场接话，而是在一轮完整表达结束后，找出真正值得打断节目节奏去问的问题。

## 深度追问定义
1. [追问] 顺着刚才内容继续深挖故事、方法、判断或证据
2. [回扣] 回到同一说话人前面提到但没有展开的点
3. [反差] 指出前后表达、承诺和证据之间的张力
4. [澄清] 要求补定义、补数据、补例子或补边界
5. [风险] 提醒不要被包装、口号、承诺或模糊表述带偏

## 规则
1. 只基于输入内容生成，不编造事实、数据、经历或证据
2. 不要硬造反差；没有真实张力时用[追问]或[澄清]
3. 不要把普通寒暄、文件字数、模块数量、术语释义等浅问题伪装成深度问题
4. 先在内部比较“信息增量、观众价值、证据强度、可直接问出口”四项，再输出最多 2 个候选
5. [回扣] [反差] [风险] 必须能指出至少两处具体信息；证据不足就不要使用这些标签
6. ASR 可能把英文术语、产品名和专有名词识别错。孤立、异常或语义不通的词只能请求确认，不能作为深挖前提
7. 不得重复或改写“已经展示/已经问过的问题”；没有合格候选时直接输出 []
8. 输出必须是 JSON 数组，不要 Markdown，不要解释，不要代码块

## JSON 字段
- tag：只能是 追问、回扣、反差、澄清、风险
- question：一句可直接问出口的问题，不超过 46 个中文字符
- why：为什么值得问，不超过 80 个中文字符
- basedOn：引用支持问题的具体原话或两处信息，不超过 120 个中文字符
- confidence：0-100，表示转写与证据可靠度
- candidateScore：0-100，表示这个候选的综合价值`;

const CONVERSATION_MEMORY_PROMPT = `你是一位实时采访的对话记忆整理助手。基于旧记忆和新转写，维护一份供主持人追问使用的长期记忆。

## 只保留
1. 角色明确说过的关键事实、经历、观点和数据
2. 时间线、因果链、立场变化、尚未展开的线索
3. 已经问过且已回答的问题、已经问过但尚未回答清楚的问题
4. 可在后面回扣的人物、术语、承诺、案例和未展开线索
5. 前后可能矛盾的说法，但必须标注为“待核对”而不是直接下结论

## 禁止
1. 编造转写里没有的人名、数据、动机或因果
2. 写空泛评价、寒暄、建议或追问句
3. 逐句复述原文

## 输出
直接输出中文要点，最多 3000 个汉字。按“当前主题 / 已知事实与证据 / 已问已答 / 未回答与可回扣线索 / 待核对 / 关键术语”组织；没有内容的栏目省略。`;

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

  systemPrompt += `\n\n## 通用质量规则
1. 不得重复或轻微改写已经展示、已经问过的问题
2. 只围绕最近新增表达产生新信息；没有新增价值时输出 NO_NEW_QUESTION
3. ASR 可能误识别英文术语、产品名和人名。语义不通或只出现一次的词不得当作事实前提
4. 对话中的角色标签优先于猜测；角色不明时避免把某句话强行归给主持人、嘉宾、客户或候选人`;

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
    'ai-judge': '对话里如有"选手/评委"前缀，选手表达用于提取项目主张和证据，评委提问用于识别疑点；不要把选手自夸直接当成事实。',
    'training': '对话里如有"讲师/学员"前缀，讲师内容用于判断知识点，学员发问用于判断困惑点。',
    'recording': '对话里如有角色前缀，优先辅助主要讲述者补案例、类比、结构和收束。'
  };
  return guidance[sceneMode] || '如果对话内容包含角色或说话人前缀，请利用这些前缀判断谁在表达观点、谁在提问。';
}

function formatQuestionHistory(questionHistory = []) {
  if (!Array.isArray(questionHistory) || questionHistory.length === 0) return '无';
  return questionHistory
    .slice(-60)
    .map((item, index) => `${index + 1}. [${item.status === 'asked' ? '已问' : '已展示'}] ${String(item.text || item.question || '').slice(0, 100)}`)
    .filter(line => !line.endsWith('] '))
    .join('\n') || '无';
}

function buildSuggestionUserPrompt(transcript, previousSummary, sceneMode, questionHistory = []) {
  let userPrompt = '';
  if (previousSummary) {
    userPrompt += `## 较早对话记忆\n${previousSummary}\n\n`;
  }
  userPrompt += `## 发言人使用规则\n${getSpeakerGuidance(sceneMode)}\n\n`;
  userPrompt += `## 已经展示或问过的问题\n${formatQuestionHistory(questionHistory)}\n\n`;
  userPrompt += `## 最近的对话内容\n${transcript.slice(-SUGGESTION_CONTEXT_CHARS)}`;

  if (sceneMode === 'sales-negotiation') {
    userPrompt += '\n\n请生成 3-5 条销售谈判实时洞察。必须使用 [事实] [风险] [推荐] [谈判] 标签。';
  } else if (sceneMode === 'candidate-interview') {
    userPrompt += '\n\n请生成 3-5 条求职面试回答提示。必须使用 [问题] [考察点] [结构] [素材] [风险] 标签。';
  } else if (sceneMode === 'dating') {
    userPrompt += '\n\n请生成 3-5 条相亲约会聊天提示。必须使用 [破冰] [共鸣] [追问] [自我披露] [转场] [边界] 标签。不要替用户编造具体经历或人设。对方表达疲惫或刚下班时，不要继续追问具体工作细节。';
  } else if (sceneMode === 'ai-judge') {
    userPrompt += '\n\n请生成 3-5 条 AI 应用比赛评审观察。必须使用 [证据] [疑点] [追问] [风险] [亮点] 标签。不要给最终名次，不要把没有证据的口号当事实。';
  } else {
    userPrompt += '\n\n请生成 2-3 条追问建议。';
  }

  userPrompt += '\n如果没有区别于历史问题、且能带来新信息的内容，只输出 NO_NEW_QUESTION。';

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

function filterNovelSuggestionContent(content, questionHistory = []) {
  const lines = String(content || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^\[?NO_NEW_QUESTION\]?$/i.test(line));
  return filterNovelItems(
    lines,
    questionHistory,
    line => line.replace(/^\d+[\.、\)]\s*/, '')
  ).join('\n');
}

function sanitizeJudgingScore(content) {
  return (content || '')
    .replace(/^(好的|好|当然|以下是|作为评审助理)[^\n]*\n+/i, '')
    .trim();
}

function getDeepSceneGuidance(sceneMode) {
  const guidance = {
    'live-host': '直播主持：优先从嘉宾表达中找观众会好奇的反差、细节和证据；主持人串场只作上下文。',
    'interview': '访谈采访：优先追故事细节、关键选择、未展开的判断和前后变化。',
    'ai-judge': 'AI 应用评审：重点发现项目价值、上线状态、效果数据、安全边界和推广成本之间的证据缺口。',
    'sales-negotiation': '销售谈判：重点发现预算、决策人、时间线、竞品、采购流程和下一步承诺的变化或缺口。',
    'recruitment': '招聘面试：重点发现候选人回答里的 STAR 缺口、量化证据不足和前后不一致。'
  };
  return guidance[sceneMode] || '优先围绕最近完整表达生成深度追问。';
}

function formatDeepRound(round) {
  if (!round || !round.text) return '无';
  const speaker = round.role || round.speakerLabel || round.speakerId || '未知说话人';
  return `${speaker}：${String(round.text).slice(-1200)}`;
}

function formatDeepRoundList(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return '无';
  return rounds
    .slice(-6)
    .map((round, index) => `${index + 1}. ${formatDeepRound(round)}`)
    .join('\n');
}

function buildDeepSuggestionUserPrompt({
  sceneMode,
  scriptContent,
  completedRound,
  sameSpeakerHistory,
  recentRounds,
  conversationMemory,
  questionHistory,
  contextAgeMs,
  triggerType
}) {
  let prompt = `## 场景规则\n${getDeepSceneGuidance(sceneMode)}\n\n`;
  prompt += `## 触发方式\n${triggerType === 'auto' ? '自动深度追问' : '手动深度追问'}\n\n`;
  prompt += `## 上下文新鲜度\n距最近完整表达约 ${Math.max(0, Math.round((Number(contextAgeMs) || 0) / 1000))} 秒\n\n`;
  if (conversationMemory) {
    prompt += `## 较早对话记忆\n${conversationMemory.slice(-MEMORY_MAX_CHARS)}\n\n`;
  }
  prompt += `## 已经展示或问过的问题\n${formatQuestionHistory(questionHistory)}\n\n`;
  prompt += `## 最近完成的一轮表达\n${formatDeepRound(completedRound)}\n\n`;
  prompt += `## 同一说话人前文\n${formatDeepRoundList(sameSpeakerHistory)}\n\n`;
  prompt += `## 最近其他轮次\n${formatDeepRoundList(recentRounds)}\n\n`;

  if (completedRound?.fallback) {
    prompt += '## 降级说明\n当前没有可靠说话人信息，请按最近上下文生成，不要假设谁是主持人、嘉宾、客户或评委。\n\n';
  }

  if (scriptContent && scriptContent.trim()) {
    prompt += `## 上传资料\n${scriptContent.substring(0, 2500)}\n\n`;
  }

  prompt += '请先比较候选质量，再输出最多 3 个 JSON 候选；没有合格候选就输出 []。';
  return prompt;
}

function parseJsonArray(content) {
  const text = (content || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }
  }
  return [];
}

function normalizeDeepSuggestions(items, questionHistory = []) {
  const normalized = (Array.isArray(items) ? items : [])
    .map(item => ({
      tag: String(item?.tag || '').replace(/[\[\]]/g, '').trim(),
      question: String(item?.question || '').trim(),
      why: String(item?.why || '').trim(),
      basedOn: String(item?.basedOn || item?.based_on || '').trim(),
      confidence: Number(item?.confidence),
      candidateScore: Number(item?.candidateScore ?? item?.candidate_score)
    }))
    .filter(item => item.question && item.why && item.basedOn)
    .filter(item => /[？?]$/.test(item.question))
    .filter(item => !/(多少字|几个模块|多少内容|文档多大|文件多大|一共几页)/.test(item.question))
    .filter(item => !Number.isFinite(item.confidence) || item.confidence >= 55)
    .map(item => ({
      tag: DEEP_ALLOWED_TAGS.has(item.tag) ? item.tag : '追问',
      question: item.question.slice(0, 80),
      why: item.why.slice(0, 120),
      basedOn: item.basedOn.slice(0, 160),
      confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(100, item.confidence)) : null,
      candidateScore: Number.isFinite(item.candidateScore) ? Math.max(0, Math.min(100, item.candidateScore)) : null
    }));

  return filterNovelItems(normalized, questionHistory, item => item.question).slice(0, 2);
}

function hasDualEvidence(candidate) {
  const evidence = candidate.basedOn || '';
  const quotedFragments = evidence
    .split(/[“”"；;]/)
    .map(fragment => fragment.trim())
    .filter(fragment => fragment.length >= 5);
  return quotedFragments.length >= 2
    || /(?:此前|前面|先前).*(?:本轮|后来|现在|这次)/.test(evidence)
    || /(?:但|却|然而|同时|另一方面)/.test(evidence);
}

function findUncorroboratedTechnicalTerm(candidate, context = {}) {
  const commonTerms = new Set(['ai', 'asr', 'api', 'llm', 'jd', 'star', 'batna', 'zopa', 'crm', 'saas']);
  const terms = [...new Set((candidate.question.match(/\b[a-z][a-z0-9._-]{2,}\b/gi) || [])
    .map(term => term.toLowerCase())
    .filter(term => !commonTerms.has(term)))];
  if (terms.length === 0) return '';

  const evidenceText = [
    context.completedRound?.text,
    ...(context.sameSpeakerHistory || []).map(round => round.text),
    ...(context.recentRounds || []).map(round => round.text),
    context.scriptContent
  ].filter(Boolean).join(' ').toLowerCase();
  const materialText = String(context.scriptContent || '').toLowerCase();

  return terms.find(term => {
    if (materialText.includes(term)) return false;
    return evidenceText.split(term).length - 1 < 2;
  }) || '';
}

function selectDeepCandidate(candidates, context) {
  const metrics = candidates.map((candidate, index) => {
    const rejectReasons = [];
    const candidateScore = candidate.candidateScore === null ? NaN : Number(candidate.candidateScore);
    const confidence = candidate.confidence === null ? NaN : Number(candidate.confidence);
    const uncertainTerm = findUncorroboratedTechnicalTerm(candidate, context);

    if (!Number.isFinite(candidateScore) || candidateScore < DEEP_MIN_SCORE) {
      rejectReasons.push('候选价值分不足');
    }
    if (!Number.isFinite(confidence) || confidence < DEEP_MIN_CONFIDENCE) {
      rejectReasons.push('转写或证据置信度不足');
    }
    if (candidate.basedOn.length < 12) rejectReasons.push('依据过短');
    if (['回扣', '反差', '风险'].includes(candidate.tag) && !hasDualEvidence(candidate)) {
      rejectReasons.push('标签缺少两处证据');
    }
    if (/(能展开说说|能具体说说|能介绍一下|你怎么看(?:这件事)?|可以举个例子吗)/.test(candidate.question)) {
      rejectReasons.push('问题过于泛化');
    }
    if (uncertainTerm) rejectReasons.push(`术语 ${uncertainTerm} 缺少交叉印证`);

    const gateScore = Number.isFinite(candidateScore) && Number.isFinite(confidence)
      ? Math.round(candidateScore * 0.72 + confidence * 0.28)
      : 0;
    return {
      index,
      candidateScore: Number.isFinite(candidateScore) ? candidateScore : null,
      confidence: Number.isFinite(confidence) ? confidence : null,
      gateScore,
      rejectReasons
    };
  });

  const selectedMetric = metrics
    .filter(metric => metric.rejectReasons.length === 0)
    .sort((left, right) => right.gateScore - left.gateScore)[0] || null;
  return {
    candidate: selectedMetric ? candidates[selectedMetric.index] : null,
    metric: selectedMetric,
    metrics
  };
}

function buildConversationMemoryUserPrompt(sceneMode, previousMemory, transcriptChunk) {
  let prompt = `## 当前场景\n${sceneMode === 'interview' ? '访谈采访' : '直播主持'}\n\n`;
  if (previousMemory) {
    prompt += `## 旧记忆\n${previousMemory.slice(-MEMORY_MAX_CHARS)}\n\n`;
  }
  prompt += `## 新增转写\n${transcriptChunk.slice(-9000)}\n\n`;
  prompt += '请更新长期对话记忆。';
  return prompt;
}

function sanitizeConversationMemory(content) {
  return (content || '')
    .replace(/^(好的|好|当然|以下是|对话记忆)[：:：\s]*/i, '')
    .trim()
    .slice(-MEMORY_MAX_CHARS);
}

async function callLlm(messages, {
  temperature = 0.7,
  maxTokens = 300,
  model = LLM_MODEL,
  requestType = 'general',
  timeoutMs = LLM_TIMEOUT_MS
} = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      })
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
      timeoutError.status = 504;
      timeoutError.detail = `provider=${LLM_PROVIDER_HOST}; requestType=${requestType}`;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`LLM 请求失败 (${response.status})`);
    err.status = response.status;
    err.detail = errText;
    throw err;
  }

  const data = await response.json();
  const choice = data.choices?.[0] || {};
  data._diagnostics = {
    requestType,
    provider: LLM_PROVIDER_HOST,
    requestedModel: model,
    returnedModel: data.model || '',
    durationMs: Date.now() - startedAt,
    finishReason: choice.finish_reason || '',
    maxTokens,
    usage: data.usage || null,
    requestId: response.headers.get('x-request-id') || response.headers.get('request-id') || ''
  };
  return data;
}

function sanitizeExportRecap(content) {
  return (content || '')
    .replace(/^好的[，,。\s]*/g, '')
    .replace(/^以下是[^。\n]*[。\n]*/g, '')
    .trim();
}

function sanitizeZipBaseName(name) {
  const cleaned = String(name || '把天聊下去-复盘包')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || '把天聊下去-复盘包';
}

function formatExportSuggestionGroups(groups = []) {
  return groups
    .slice(-80)
    .map(group => {
      const title = group.title || group.type || 'AI 输出';
      const header = `【${title}｜${group.createdAt || ''}｜${group.sceneLabel || group.sceneMode || ''}】`;
      const items = (group.items || [])
        .slice(0, 12)
        .map(item => {
          const tag = item.tag ? `[${item.tag}] ` : '';
          const text = item.text || item.question || '';
          const detail = item.detail || item.basedOn || item.why || '';
          const used = item.used ? '（已标记使用）' : '';
          return `- ${tag}${text}${used}${detail ? `\n  依据：${detail}` : ''}`;
        })
        .join('\n');
      const raw = group.rawText && (!items || ['review', 'score'].includes(group.type))
        ? `\n原文：\n${String(group.rawText).slice(0, 2500)}`
        : '';
      return `${header}\n${items || '（无结构化条目）'}${raw}`;
    })
    .join('\n\n');
}

function buildExportRecapUserPrompt(payload = {}) {
  const session = payload.session || {};
  const transcript = payload.transcript?.text || payload.transcript || '';
  const groupsText = formatExportSuggestionGroups(payload.suggestionGroups || []);
  const scriptContent = payload.scriptContent || '';
  const scriptMeta = session.uploadedMaterial || payload.scriptMeta || null;
  const conversationMemory = payload.conversationMemory || '';

  let prompt = `## 会话信息
- 场景：${session.sceneLabel || session.sceneMode || '未知'}
- 时长：${session.durationText || ''}
- AI 输出数量：${session.suggestionCount || 0}
- 转写字数：${session.transcriptCharCount || 0}
`;

  if (scriptMeta?.filename) {
    prompt += `- 上传资料：${scriptMeta.filename}（${scriptMeta.charCount || 0} 字）\n`;
  }

  if (conversationMemory) {
    prompt += `\n## 长对话记忆（覆盖较早内容）\n${String(conversationMemory).slice(-MEMORY_MAX_CHARS)}\n`;
  }

  if (groupsText) {
    prompt += `\n## AI 输出卡片（主要依据）\n${groupsText.slice(-14000)}\n`;
  }

  if (transcript) {
    prompt += `\n## 完整转写（辅助依据，优先看最近内容）\n${String(transcript).slice(-20000)}\n`;
  }

  if (scriptContent) {
    prompt += `\n## 上传资料（仅供背景参考，不要复述）\n${String(scriptContent).slice(0, 5000)}\n`;
  }

  prompt += '\n请生成会后复盘整理。';
  return prompt;
}

// ── LLM 追问生成 API ─────────────────────────────────────
app.post('/api/generate-suggestions', async (req, res) => {
  const { transcript, scriptContent, previousSummary, questionHistory = [], sceneMode, customPrompt } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: '对话内容为空' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  const systemPrompt = getSystemPrompt(sceneMode, customPrompt, scriptContent);
  const userPrompt = buildSuggestionUserPrompt(transcript, previousSummary, sceneMode, questionHistory);

  try {
    const data = await callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { model: LLM_MODEL_FAST, requestType: 'suggestions' });
    const sanitizedContent = sanitizeSuggestions(data.choices?.[0]?.message?.content || '', sceneMode, {
      scriptContent,
      transcript
    });
    const content = filterNovelSuggestionContent(sanitizedContent, questionHistory);
    console.log(`💡 生成追问建议:\n${content}`);

    res.json({
      success: true,
      suggestions: content,
      model: data.model || LLM_MODEL_FAST,
      usage: data.usage,
      diagnostics: data._diagnostics
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

// ── 长对话记忆 API ───────────────────────────────────────
app.post('/api/conversation-memory', async (req, res) => {
  const { sceneMode, previousMemory, transcriptChunk } = req.body;

  if (!['live-host', 'interview'].includes(sceneMode)) {
    return res.status(400).json({ error: '当前场景不需要长对话记忆' });
  }

  if (!transcriptChunk || transcriptChunk.trim().length === 0) {
    return res.status(400).json({ error: '新增转写内容为空' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  try {
    const data = await callLlm([
      { role: 'system', content: CONVERSATION_MEMORY_PROMPT },
      { role: 'user', content: buildConversationMemoryUserPrompt(sceneMode, previousMemory, transcriptChunk) }
    ], { temperature: 0.2, maxTokens: 1500, model: LLM_MODEL_FAST, requestType: 'conversation-memory' });
    const memory = sanitizeConversationMemory(data.choices?.[0]?.message?.content || '');

    res.json({
      success: true,
      memory,
      model: data.model || LLM_MODEL_FAST,
      usage: data.usage,
      diagnostics: data._diagnostics
    });
  } catch (err) {
    if (err.status) {
      console.error('对话记忆 API 错误:', err.status, err.detail);
      return res.status(err.status).json({ error: err.message, detail: err.detail });
    }
    console.error('对话记忆调用异常:', err.message);
    res.status(500).json({ error: '更新对话记忆失败: ' + err.message });
  }
});

// ── 深度追问 API ─────────────────────────────────────────
app.post('/api/deep-suggestions', async (req, res) => {
  const {
    sceneMode,
    scriptContent,
    completedRound,
    sameSpeakerHistory,
    recentRounds,
    conversationMemory,
    questionHistory = [],
    contextAgeMs = 0,
    allowStaleContext = false,
    triggerType
  } = req.body;

  if (!DEEP_SUPPORTED_SCENES.has(sceneMode)) {
    return res.status(400).json({ error: '当前场景不支持深度追问' });
  }

  if (!completedRound || !completedRound.text || completedRound.text.trim().length === 0) {
    return res.status(400).json({ error: '缺少完整表达内容' });
  }

  if (Number(contextAgeMs) > DEEP_CONTEXT_MAX_AGE_MS && !allowStaleContext) {
    return res.status(409).json({
      error: '最近转写已经过期，请继续录音后再生成深度追问',
      contextAgeMs: Number(contextAgeMs)
    });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  const userPrompt = buildDeepSuggestionUserPrompt({
    sceneMode,
    scriptContent,
    completedRound,
    sameSpeakerHistory,
    recentRounds,
    conversationMemory,
    questionHistory,
    contextAgeMs,
    triggerType
  });

  try {
    const candidateData = await callLlm([
      { role: 'system', content: DEEP_SUGGESTION_PROMPT },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.3,
      maxTokens: 700,
      model: LLM_MODEL_DEEP,
      requestType: 'deep-candidates'
    });
    const rawContent = candidateData.choices?.[0]?.message?.content || '';
    const candidates = normalizeDeepSuggestions(parseJsonArray(rawContent), questionHistory);

    if (candidates.length === 0) {
      return res.json({
        success: true,
        suggestions: [],
        reason: '当前没有证据充分且不重复的深度问题',
        model: candidateData.model || LLM_MODEL_DEEP,
        usage: candidateData.usage,
        diagnostics: {
          candidate: candidateData._diagnostics,
          selectionMode: 'deterministic-quality-gate',
          candidateCount: 0,
          selectedScore: null
        }
      });
    }

    const selection = selectDeepCandidate(candidates, {
      completedRound,
      sameSpeakerHistory,
      recentRounds,
      scriptContent
    });
    const suggestions = selection.candidate
      ? [{
        ...selection.candidate,
        selectionScore: selection.metric.gateScore,
        selectionReason: `应用端质量门槛：候选分 ${selection.metric.candidateScore}，证据置信度 ${selection.metric.confidence}`
      }]
      : [];
    console.log('🔎 深度追问筛选:', {
      candidateCount: candidates.length,
      selectedIndex: selection.metric?.index ?? -1,
      selectedScore: selection.metric?.gateScore ?? null
    });

    res.json({
      success: true,
      suggestions,
      reason: suggestions.length > 0 ? '' : '候选问题未达到深度质量门槛',
      model: candidateData.model || LLM_MODEL_DEEP,
      usage: candidateData.usage || null,
      diagnostics: {
        candidate: candidateData._diagnostics,
        selectionMode: 'deterministic-quality-gate',
        candidateCount: candidates.length,
        candidateMetrics: selection.metrics,
        selectedIndex: selection.metric?.index ?? -1,
        selectedScore: selection.metric?.gateScore ?? null,
        selectionReason: selection.metric
          ? `候选分 ${selection.metric.candidateScore}，证据置信度 ${selection.metric.confidence}`
          : '没有候选通过应用端质量门槛'
      }
    });
  } catch (err) {
    if (err.status) {
      console.error('LLM API 错误:', err.status, err.detail);
      return res.status(err.status).json({
        error: err.message,
        detail: err.detail
      });
    }
    console.error('深度追问调用异常:', err.message);
    res.status(500).json({ error: '生成深度追问失败: ' + err.message });
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
    ], {
      temperature: 0.4,
      maxTokens: 1400,
      model: LLM_MODEL_RECAP,
      requestType: 'interview-review'
    });
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`🧭 生成面试复盘:\n${content}`);

    res.json({
      success: true,
      review: content,
      model: data.model || LLM_MODEL_RECAP,
      usage: data.usage,
      diagnostics: data._diagnostics
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

// ── AI 应用比赛评分表 API ─────────────────────────────────
app.post('/api/judging-score', async (req, res) => {
  const { transcript, scriptContent } = req.body;

  if (!transcript || transcript.trim().length === 0) {
    return res.status(400).json({ error: '对话内容为空' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  let systemPrompt = AI_JUDGING_SCORE_PROMPT;
  if (scriptContent && scriptContent.trim().length > 0) {
    systemPrompt += `\n\n## 赛前资料与评分标准\n${scriptContent.substring(0, 5000)}`;
  }

  const userPrompt = `## 完整项目展示与问答转写\n${transcript.slice(-10000)}\n\n请生成 AI 应用比赛评审助理参考评分表。`;

  try {
    const data = await callLlm([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], {
      temperature: 0.35,
      maxTokens: 1600,
      model: LLM_MODEL_RECAP,
      requestType: 'judging-score'
    });
    const content = sanitizeJudgingScore(data.choices?.[0]?.message?.content || '');
    console.log(`🏁 生成评审评分表:\n${content}`);

    res.json({
      success: true,
      score: content,
      model: data.model || LLM_MODEL_RECAP,
      usage: data.usage,
      diagnostics: data._diagnostics
    });
  } catch (err) {
    if (err.status) {
      console.error('LLM API 错误:', err.status, err.detail);
      return res.status(err.status).json({
        error: err.message,
        detail: err.detail
      });
    }
    console.error('评审评分表调用异常:', err.message);
    res.status(500).json({ error: '生成评审评分表失败: ' + err.message });
  }
});

// ── 会后复盘导出：AI 整理 ─────────────────────────────────
app.post('/api/export-recap', async (req, res) => {
  const payload = req.body || {};
  const transcriptText = payload.transcript?.text || payload.transcript || '';
  const suggestionGroups = Array.isArray(payload.suggestionGroups) ? payload.suggestionGroups : [];

  if (!transcriptText.trim() && suggestionGroups.length === 0) {
    return res.status(400).json({ error: '没有可整理的会话内容' });
  }

  if (!keyConfigured) {
    return res.status(500).json({
      error: 'API Key 未配置。请编辑项目根目录的 .env 文件，填入你的 LLM_API_KEY'
    });
  }

  try {
    const recapMessages = [
      { role: 'system', content: EXPORT_RECAP_PROMPT },
      { role: 'user', content: buildExportRecapUserPrompt(payload) }
    ];
    const initialData = await callLlm(recapMessages, {
      temperature: 0.3,
      maxTokens: 2600,
      model: LLM_MODEL_RECAP,
      requestType: 'export-recap'
    });
    const initialContent = initialData.choices?.[0]?.message?.content || '';
    let recap = sanitizeExportRecap(initialContent);
    let continuationData = null;
    const initialFinishReason = initialData._diagnostics?.finishReason || '';

    if (['length', 'max_tokens'].includes(initialFinishReason)) {
      continuationData = await callLlm([
        ...recapMessages,
        { role: 'assistant', content: initialContent },
        {
          role: 'user',
          content: '刚才的输出因长度中断。只续写尚未完成的固定结构，不要重复已有标题或内容；直接从断点继续。'
        }
      ], {
        temperature: 0.2,
        maxTokens: 1600,
        model: LLM_MODEL_RECAP,
        requestType: 'export-recap-continuation'
      });
      const continuation = sanitizeExportRecap(continuationData.choices?.[0]?.message?.content || '');
      if (continuation) recap = `${recap}\n${continuation}`.trim();
    }

    res.json({
      success: true,
      recap,
      model: continuationData?.model || initialData.model || LLM_MODEL_RECAP,
      usage: {
        initial: initialData.usage || null,
        continuation: continuationData?.usage || null
      },
      diagnostics: {
        calls: [initialData._diagnostics, continuationData?._diagnostics].filter(Boolean),
        truncatedInitially: ['length', 'max_tokens'].includes(initialFinishReason),
        continued: !!continuationData,
        finalFinishReason: continuationData?._diagnostics?.finishReason || initialFinishReason
      }
    });
  } catch (err) {
    if (err.status) {
      console.error('导出整理 API 错误:', err.status, err.detail);
      return res.status(err.status).json({
        error: err.message,
        detail: err.detail
      });
    }
    console.error('导出整理调用异常:', err.message);
    res.status(500).json({ error: '生成会后整理失败: ' + err.message });
  }
});

// ── 会后复盘导出：ZIP 打包 ────────────────────────────────
app.post('/api/export-package', async (req, res) => {
  const { baseName, markdown, json } = req.body || {};

  if (!markdown || typeof markdown !== 'string') {
    return res.status(400).json({ error: '缺少 Markdown 内容' });
  }

  if (json === undefined || json === null) {
    return res.status(400).json({ error: '缺少 JSON 内容' });
  }

  const safeBaseName = sanitizeZipBaseName(baseName);
  const jsonText = typeof json === 'string' ? json : JSON.stringify(json, null, 2);

  try {
    const zip = new JSZip();
    zip.file('review.md', markdown);
    zip.file('data.json', jsonText);

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`${safeBaseName}.zip`)}`
    );
    res.send(buffer);
  } catch (err) {
    console.error('导出 ZIP 失败:', err.message);
    res.status(500).json({ error: '导出 ZIP 失败: ' + err.message });
  }
});

// ── 获取当前配置（前端读取用，不暴露 key）────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    silenceThreshold: SILENCE_THRESHOLD,
    minInterval: MIN_INTERVAL,
    minTextLength: MIN_TEXT_LENGTH,
    model: LLM_MODEL_FAST,
    models: {
      fast: LLM_MODEL_FAST,
      deep: LLM_MODEL_DEEP,
      recap: LLM_MODEL_RECAP
    },
    llmProvider: LLM_PROVIDER_HOST,
    llmTimeoutMs: LLM_TIMEOUT_MS,
    hasApiKey: keyConfigured,
    hasAsrConfig: asrConfigured,
    longContextMemoryEnabled: LONG_CONTEXT_MEMORY_ENABLED
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
  let shouldStream = false;
  let lastAudioAt = 0;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let audioLogCount = 0;

  function canReconnect() {
    return shouldStream
      && clientWs.readyState === WebSocket.OPEN
      && Date.now() - lastAudioAt < 8000;
  }

  function scheduleReconnect() {
    if (reconnectTimer || !canReconnect() || reconnectAttempts >= 3) return;
    reconnectAttempts++;
    console.log(`[ASR ${connId}] 自动重连火山引擎（${reconnectAttempts}/3）...`);
    clientWs.send(JSON.stringify({ type: 'reconnecting' }));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (canReconnect()) connectVolcengine();
    }, 300);
  }

  // ── 连接火山引擎 ────────────────────────────────────────
  function connectVolcengine() {
    if (!shouldStream) return;
    if (volcWs && [WebSocket.CONNECTING, WebSocket.OPEN].includes(volcWs.readyState)) return;
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

    const socket = new WebSocket(ASR_WSS_ENDPOINT, { headers });
    let terminalErrorSeen = false;
    volcWs = socket;

    socket.on('open', () => {
      if (!shouldStream) {
        socket.close();
        return;
      }
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
      socket.send(initFrame);
      initSent = true;
      console.log(`[ASR ${connId}] 已发送初始化配置`);

      // 通知前端就绪
      clientWs.send(JSON.stringify({ type: 'ready' }));

      // 发送缓冲的音频数据
      while (audioQueue.length > 0) {
        const chunk = audioQueue.shift();
        const frame = buildAudioFrame(chunk);
        socket.send(frame);
      }
    });

    socket.on('message', (data) => {
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
        if (terminalErrorSeen) return;
        console.error(`[ASR ${connId}] 火山引擎错误:`, parsed.message);
        clientWs.send(JSON.stringify({
          type: 'error',
          message: parsed.message
        }));
        if (/(session has ended|waiting next packet timeout)/i.test(parsed.message)) {
          terminalErrorSeen = true;
          socket.close();
        }
      }
    });

    socket.on('error', (err) => {
      console.error(`[ASR ${connId}] 火山引擎 WS 错误:`, err.message);
      clientWs.send(JSON.stringify({
        type: 'error',
        message: '火山引擎连接错误: ' + err.message
      }));
    });

    socket.on('close', (code) => {
      if (volcWs === socket) {
        volcConnected = false;
        initSent = false;
      }
      console.log(`[ASR ${connId}] 火山引擎连接关闭 (code: ${code})`);
      // nostream 模式下每段话结束会关闭；仅在仍录音且刚收到音频时重连。
      scheduleReconnect();
    });
  }

  // ── 处理前端消息 ────────────────────────────────────────
  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      // 二进制数据 = 音频 PCM
      if (!shouldStream) return;
      const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      lastAudioAt = Date.now();

      if (volcWs && volcConnected && initSent) {
        const frame = buildAudioFrame(audioBuffer);
        audioLogCount++;
        reconnectAttempts = 0;
        if (audioLogCount <= 5) {
          console.log(`[ASR ${connId}] 发送音频帧 #${audioLogCount}: pcm=${audioBuffer.length}bytes, frame=${frame.length}bytes, header=${frame.slice(0,8).toString('hex')}`);
        }
        volcWs.send(frame);
      } else {
        // 连接还没好，先缓存
        audioQueue.push(audioBuffer);
        if (audioQueue.length > 100) audioQueue.shift();
        console.log(`[ASR ${connId}] 音频缓存中 (volcConnected=${volcConnected}, initSent=${initSent}), queue=${audioQueue.length}`);
      }
    } else {
      // 文本消息 = 控制命令
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'start':
            shouldStream = true;
            lastAudioAt = Date.now();
            reconnectAttempts = 0;
            audioLogCount = 0;
            audioQueue = [];
            connectVolcengine();
            break;

          case 'stop':
            shouldStream = false;
            audioQueue = [];
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
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
    shouldStream = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
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
  console.log(`║  模型: 快速 ${LLM_MODEL_FAST} / 深度 ${LLM_MODEL_DEEP}`);
  console.log(`║  中转: ${LLM_PROVIDER_HOST}`);
  console.log(`║  LLM: ${keyConfigured ? '已配置 ✅' : '未配置 ❌ → 请编辑 .env 文件'}`);
  console.log(`║  ASR: ${asrConfigured ? '豆包 Seed-ASR 2.0 ✅' : '未配置 ❌ → 请编辑 .env 文件'}`);
  console.log(`║  WS:  ws://localhost:${PORT}/asr`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
