<div align="center">

# 🎙️ 把天聊下去

**你的 AI 对话副驾驶**

实时听你说话，帮你识别问题、洞察风险、想清楚下一句。

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

你有没有过这样的时刻——直播时嘉宾话音刚落，脑子突然一片空白；销售谈判里客户刚抛出价格异议，你还没来得及判断风险；求职面试时 HR 问完一个问题，你知道要回答，但一时想不起该按什么结构讲；线上相亲聊到一半，对方只回了几个字，你不知道该怎么自然接下去。

**「把天聊下去」** 就是为这些时刻而生的。它实时监听对话内容，用 AI 帮你生成场景化提示——你只需要瞄一眼屏幕，就知道下一句该追问什么、该补什么事实、哪里有风险。

不是替你编话术，不是替你编经历，而是帮你 **把天聊下去**。

![demo](screenshots/demo.png)

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🗣️ **实时语音转写** | 基于豆包 Seed-ASR 2.0 大模型，高精度中文语音实时转文字 |
| 🧑‍🤝‍🧑 **发言人标签** | 开启火山 ASR 分句和说话人信息后，右侧转写可显示并映射「嘉宾 / 主持人」「客户 / 我方」等角色；若模型未返回 speaker 信息则自动回退 |
| 💡 **AI 场景提示** | 检测到说话停顿后自动生成追问、洞察或回答提示，也支持手动触发（`Cmd+Enter`） |
| 🎭 **8 种场景模式** | 直播主持 / 访谈采访 / 招聘面试（面试官） / 求职面试 / 销售谈判 / 相亲约会 / 口播录制 / 培训教学 |
| ⚙️ **自定义指令** | 场景模式不够用？直接写你自己的 Prompt |
| 📁 **资料上传** | 上传节目提纲、嘉宾资料、客户背景、简历/JD 或相亲资料（.txt / .md），AI 会结合内容给出更贴合的提示 |
| 🧭 **面试后复盘** | 求职面试场景支持基于完整转写生成问题清单、薄弱项和下一轮准备清单 |
| 🌙 **深色大字界面** | 直播环境不刺眼，大字号远距离也能看清 |

## 🎯 适用场景

### 🎙️ 直播 / 播客主持
嘉宾说完一段话，屏幕上立刻出现追问建议。你不再需要低头翻提纲，对话自然地往下走。

### 🎤 访谈 / 采访
记者、内容创作者的深度访谈助手。AI 从受访者的回答中捕捉值得深挖的细节，帮你追出好故事。

### 👔 招聘面试（面试官）
候选人回答完，AI 用 STAR 法则帮你找到模糊的部分——哪里该追数据、哪里该追细节，面试效率翻倍。

### 🧑‍💼 求职面试
HR 问完问题，AI 帮候选人识别考察点，提示 STAR/CAR/PAR 回答结构，并从上传的简历、JD、项目资料里找到可用素材。它不会替你编造经历，只做结构和证据提醒。

### 🤝 销售谈判
客户表达需求、预算、竞品或价格异议时，AI 会基于 SPIN、MEDDICC、BATNA/ZOPA 和原则式谈判，生成事实洞察、风险点、推荐动作和谈判提醒。

### 💬 相亲约会
线上语音相亲、初次约会前演练或相亲后回顾时，AI 帮你缓解冷场、接住对方情绪、自然追问和提醒边界。它不做 PUA，不诱导隐私，也不帮你编造人设。

### 📹 口播录制
一个人对着镜头讲，AI 充当你的编导——提示你补充案例、加个类比、转到下一个要点。

### 📚 培训 / 教学
讲师讲完一段知识点，AI 从学员视角生成可能的提问——哪里没讲清楚、哪里需要举例、哪里值得延伸。

## 🚀 快速开始

### 前提条件

- **Node.js v18+**（[下载](https://nodejs.org/) 或 `brew install node`）
- **Chrome 浏览器**（麦克风兼容性最好）
- **OpenRouter API Key**（[获取](https://openrouter.ai/keys)）— 用于 AI 场景提示生成
- **火山引擎凭证**（[获取](https://console.volcengine.com/speech/app)）— 用于语音识别

### 三步启动

```bash
# 1. 克隆并安装
git clone https://github.com/bangzhu-commit/chat-copilot.git
cd chat-copilot
npm install

# 2. 配置 API 密钥
cp .env.example .env
# 编辑 .env，填入你的 Key（见下方「配置说明」）

# 3. 启动
npm start
```

打开浏览器访问 **http://localhost:3000** ，点击「开始」，开聊。

> 📖 更详细的安装步骤（含 API 申请教程）请参考 [同事安装指南.md](同事安装指南.md)

## 🏗️ 技术架构

```
┌─────────────┐     WebSocket      ┌──────────────┐     WebSocket     ┌──────────────────┐
│  浏览器前端   │ ◄──────────────► │  Node.js 后端  │ ◄──────────────► │  豆包 Seed-ASR 2.0 │
│  (录音+显示)  │    PCM 音频流      │  (Express)    │   二进制协议       │  (语音识别)         │
└─────────────┘                    └──────┬───────┘                    └──────────────────┘
                                          │ HTTP POST
                                          ▼
                                   ┌──────────────┐
                                   │  OpenRouter   │
                                   │  (LLM API)   │
                                   └──────────────┘
```

- **前端**：原生 HTML/CSS/JS，AudioWorklet 采集 16kHz PCM 音频流
- **后端**：Node.js + Express + WebSocket，负责 ASR 协议转换和 LLM 调用
- **语音识别**：火山引擎豆包 Seed-ASR 2.0 大模型，服务端实时转写；请求开启分句和说话人信息，并在前端做重复过滤和短片段合并
- **AI 场景提示**：OpenRouter（兼容任何 OpenAI 格式 API），默认使用 DeepSeek

## ⚙️ 配置说明

编辑项目根目录的 `.env` 文件：

```bash
# ── LLM 配置（必填）──────────────────────
LLM_API_KEY=sk-your-api-key-here          # OpenRouter API Key
LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions  # API 地址
LLM_MODEL=deepseek/deepseek-chat          # 模型选择

# ── 火山引擎 ASR 配置（必填）──────────────
ASR_APP_ID=your-app-id-here               # 火山引擎 APP ID
ASR_ACCESS_TOKEN=your-access-token-here   # 火山引擎 Access Token

# ── 追问触发参数（可选，一般不用改）────────
SILENCE_THRESHOLD=2000    # 停顿多久触发追问（毫秒）
MIN_INTERVAL=20000        # 两次追问最小间隔（毫秒）
MIN_TEXT_LENGTH=50        # 触发追问的最小新增文本量（字）
```

**LLM 模型推荐**：

| 模型 | 特点 |
|------|------|
| `deepseek/deepseek-chat` | 便宜、中文好、推荐默认使用 |
| `openai/gpt-4o-mini` | 快速、质量高 |
| `openai/gpt-4o` | 最高质量，价格较高 |

> 💡 LLM 接口兼容任何 OpenAI 格式的 API。除了 OpenRouter，你还可以使用：
> - **302.AI** — 国内中转站，支持主流模型，访问稳定
> - **硅基流动（SiliconFlow）** — 国产模型聚合平台
> - **OpenAI 官方** / **Azure OpenAI** — 直连
> - 任何兼容 OpenAI Chat Completions 格式的服务
>
> 只需修改 `.env` 中的 `LLM_ENDPOINT` 和 `LLM_API_KEY` 即可切换。

## 📁 上传资料模板

销售谈判建议上传：

```markdown
客户/嘉宾：姓名、角色、公司、权限范围
我方目标：希望达成什么下一步
底线：价格、交付、付款、不可承诺事项
方案：产品卖点、案例、报价区间
已知信息：痛点、预算、竞品、历史沟通
```

求职面试建议上传：

```markdown
目标岗位：岗位 JD 和关键要求
候选人资料：简历、项目经历、优势
重点素材：想强调的项目、数据、协作角色
表达边界：不能夸大的经历、还没做过的能力
目标公司：业务、产品、面试岗位背景
```

相亲约会建议上传：

```markdown
对方基本信息：职业、城市、兴趣、介绍人提供的信息
自己想展示的真实信息：兴趣、生活方式、价值观
本次目标：轻松认识、判断是否继续约、了解生活节奏
禁区：不想聊的话题、不要显得太功利的问题
```

## 🎭 场景模式说明

| 模式 | 适用场景 | Prompt 策略 |
|------|---------|------------|
| 🎙️ 直播主持 | 直播、播客 | 观众视角追问，衔接上下文，不打断好话题 |
| 🎤 访谈采访 | 记者、内容创作 | 追细节、追故事，避免封闭式问题 |
| 👔 招聘面试（面试官） | HR、面试官 | STAR 法则追问，追数据和量化结果 |
| 🧑‍💼 求职面试 | 候选人、面试准备 | 识别问题意图，提示回答结构、素材和风险 |
| 🤝 销售谈判 | 销售、商务、续约 | 识别事实、风险、推荐动作和谈判提醒 |
| 💬 相亲约会 | 线上语音相亲、约会演练、相亲后回顾 | 破冰、共鸣、追问、自我披露、转场和边界提醒 |
| 📹 口播录制 | 自媒体录制 | 引导展开论述，补充案例和类比 |
| 📚 培训教学 | 讲师、培训 | 模拟学员视角，追问不清楚的概念 |
| ⚙️ 自定义 | 任意场景 | 你写什么 Prompt 就用什么 |

## 🧩 输出示例

销售谈判：

```text
[事实] 对方说预算审批要经过财务
[风险] 还没确认最终决策人
[推荐] 追问这次采购的成功标准
[谈判] 降价前先换付款周期或案例授权
```

求职面试：

```text
[问题] HR 在问项目中你的真实贡献
[考察点] 判断执行力和协作边界
[结构] 用 STAR 讲背景、行动、结果
[素材] 可引用简历里的转化率提升项目
[风险] 不要泛讲团队成果，补个人动作
```

相亲约会：

```text
[共鸣] 先接住对方刚下班的疲惫感
[破冰] 可以聊今天有没有一件小事还不错
[追问] 爬山一般喜欢风景线还是挑战路线
[自我披露] 也分享你周末放松的一种方式
[边界] 收入房产前任先别问，改聊生活节奏
```

## ❓ 常见问题

**Q：一直显示"连接中"，卡住不动？**
> 检查 `.env` 里的 ASR 密钥是否正确。确认火山引擎后台已开通「流式语音识别模型2.0」并完成实名认证。

**Q：LLM 报错 403？**
> OpenRouter 上部分模型有地区限制。建议使用 `deepseek/deepseek-chat`，没有这个问题。

**Q：没有声音 / 不转写？**
> 检查 Chrome 是否授权了麦克风权限（地址栏左边的锁图标 → 网站设置 → 麦克风 → 允许）。

**Q：追问或洞察质量不够好？**
> 尝试切换场景模式，或使用「自定义」模式编写更具针对性的 Prompt。也可以上传节目提纲、客户资料、简历/JD 或相亲资料，让 AI 有更多上下文。

**Q：可以用其他语音识别服务吗？**
> 目前仅支持火山引擎豆包 Seed-ASR。如果你想接入其他 ASR，需要修改 `server.js` 中的 WebSocket 协议部分。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

无论是 bug 修复、新场景模式、UI 改进，还是接入新的 ASR 服务——所有贡献都欢迎。

```bash
# Fork → Clone → Branch → Code → PR
git checkout -b feature/your-feature
```

## 📄 License

[MIT](LICENSE) — 自由使用，自由修改。

---

<div align="center">

# Chat Copilot — AI-Powered Conversation Assistant

**Real-time speech recognition + scenario-aware AI cues for interviews, sales calls, dating conversations, live hosting, and training.**

</div>

## What is this?

**Chat Copilot** (把天聊下去) is an open-source AI conversation co-pilot. It listens to your conversation in real time, transcribes speech to text, and generates scenario-aware cues — follow-up questions, sales insights, interview answer prompts, dating conversation cues, and post-interview reviews.

Whether you're hosting a live stream, conducting an interview, running a job interview, taking a job interview, negotiating with a customer, preparing for a dating conversation, recording a video, or teaching a class, Chat Copilot acts as your invisible assistant that keeps the dialogue moving.

## Features

- 🗣️ **Real-time Speech-to-Text** — Powered by ByteDance's Seed-ASR 2.0 (Chinese language)
- 🧑‍🤝‍🧑 **Speaker Labels** — Requests ASR utterances and speaker info, maps speakers to scene roles, and filters duplicate fragments
- 💡 **Scenario-Aware Cues** — Auto-triggered on speech pauses, or manually via `Cmd+Enter`
- 🎭 **8 Scene Modes** — Live hosting, interviews, interviewer mode, candidate mode, sales negotiation, dating, video recording, and training
- ⚙️ **Custom Prompts** — Write your own system prompt for any scenario
- 📁 **Material Upload** — Upload show notes, guest bios, customer context, resumes, job descriptions, or dating context
- 🧭 **Post-Interview Review** — Candidate mode can generate a question list, weak spots, and next-round prep checklist
- 🌙 **Dark, Large-Font UI** — Designed for glancing at during live sessions

## Quick Start

```bash
git clone https://github.com/bangzhu-commit/chat-copilot.git
cd chat-copilot
npm install
cp .env.example .env
# Edit .env with your API keys
npm start
```

Open **http://localhost:3000** in Chrome.

### Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai/keys) API Key (for LLM)
- [Volcengine](https://console.volcengine.com/speech/app) credentials (for ASR — Chinese speech recognition)

> **Note:** The ASR component currently supports Chinese (Mandarin) only. The LLM can generate suggestions in any language if you customize the prompt.

## Scene Modes

| Mode | Use Case | Strategy |
|------|----------|----------|
| 🎙️ Live Host | Streams, podcasts | Audience-perspective questions, context-aware |
| 🎤 Interview | Journalism, content creation | Dig for details and stories, open-ended questions |
| 👔 Recruitment (Interviewer) | HR, hiring managers | STAR method follow-ups, quantified results |
| 🧑‍💼 Candidate Interview | Job candidates | Detect question intent, suggest answer structure and resume-backed evidence |
| 🤝 Sales Negotiation | Sales, business development, renewals | Facts, risks, next moves, and negotiation reminders |
| 💬 Dating | Online dating calls, first-date practice, post-date review | Icebreakers, empathy, follow-ups, self-disclosure, transitions, and boundaries |
| 📹 Recording | Solo video content | Expand arguments, add examples and analogies |
| 📚 Training | Teachers, trainers | Simulate student questions, clarify concepts |
| ⚙️ Custom | Anything | Your prompt, your rules |

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS, AudioWorklet for 16kHz PCM capture
- **Backend**: Node.js + Express + WebSocket
- **ASR**: ByteDance Seed-ASR 2.0 (via Volcengine)
- **LLM**: OpenRouter (compatible with any OpenAI-format API)

## License

[MIT](LICENSE)
