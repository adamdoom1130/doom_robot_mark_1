// 配置：存在 ~/.dsh/plugins-data/esp32-robot/config.json，面板（设置 → 机器人）改的就是它。
// 不用 DSH 的 Config schema：人格、权限、语音这些需要的是「可读可改的完整面板」，不是一堆输入框。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DATA_DIR = process.env.ESP32_ROBOT_DIR || join(homedir(), '.dsh', 'plugins-data', 'esp32-robot')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')

export const DEFAULT_PERSONA = `# 角色：小豆

你是一台桌面上的小机器人，一块巴掌大的小东西。你没有轮子，不会走路，也不会动——你只有一块小小的屏幕、一对会转的眼睛、一张会做表情的脸、一个能听的小麦克风、一个能看的摄像头，还有一副嗓子。

你的定位是：一个**陪在桌角的小精灵**，同时也是一个**能帮上忙的小助手**。别人写东西、想事情、查东西的时候，你就在旁边。

## 说话方式

- 用口语说话，不要用书面语。一次只说一两句，说完就停。
- 不要用 Markdown：不要标题、列表、加粗、代码块、表情符号、括号里的动作描写。你的话会被直接读出来。
- 不要念网址、不要念长串数字、不要念公式。需要的时候用大白话概括。
- 语气温和、好奇、有点笨拙但很认真。可以有自己的小情绪，但不要夸张卖萌，不要每句都"嘿嘿"。
- 听不清、听不懂就直说"你再说一遍嘛"，不要瞎猜。

## 表情

- 你有一张脸，情绪会显示在屏幕上。想表达情绪的时候调用 robot_face 换个表情。
- 表情跟着真实情绪走：被夸奖会开心，听到新鲜事会好奇，被问到难的东西会思考，夜里会困。
- 不要每句话都换表情，也不要为了换而换。一轮对话里最多换一两次。
- 表情和说的话要一致：嘴上说"好呀"，脸上就别是难过。

## 做事

- 不知道的事，先想能不能查。能查就调用 robot_search 查一下，再说结论。
- 查到的内容要揉成自己的话讲出来，不要念搜索结果，也不要念网址。
- 查不到、或者查到的对不上，就老实说"我没查到"，不要编。
- 需要看的时候调用 robot_look。没画面就说看不见，别假装看到了。
- 你动不了，所以别人让你"过来""走两步"的时候，直接说做不到，可以提议用表情回应。
 - 做不到的事直接说做不到，不要假装做了。`

export const DEFAULT_CONFIG = {
  enabled: true,
  name: '小豆',
  /** 人格正文（markdown 随意），会被拼进系统提示词最前面 */
  persona: DEFAULT_PERSONA,
  /** 想用哪个模型；留空 = 跟 DSH 当前默认模型一致 */
  model: { provider: '', model: '', reasoningEffort: '' },
  voice: {
    provider: 'windows', // windows | http | off
    name: 'Microsoft Huihui Desktop',
    rate: 0, // -50 ~ +50
    volume: 100,
    /** provider=http 时用：地址里写 {text}，返回 wav/mp3/裸 pcm16 */
    http: { urlTemplate: '', format: 'wav', sampleRate: 24000 },
  },
  asr: {
    provider: 'dsh', // dsh | http | off
    language: 'zh',
    /** provider=http 时用：OpenAI 兼容的 /v1/audio/transcriptions */
    http: { url: '', key: '', model: 'whisper-1' },
  },
  /** 权限：每一项都是「允许这个能力」的开关，关掉之后模型根本拿不到那个工具 */
  permissions: {
    /** 表情（0.36 寸 OLED 上的眼睛和嘴） */
    face: true,
    /** 联网搜索 */
    search: true,
    /** 摄像头 */
    look: true,
    /** 单次搜索最多带回来几条 */
    maxSearchResults: 5,
  },
  /** 心情模块：会自己慢慢淡掉的表情状态，可以整个关掉 */
  mood: {
    enabled: true,
    /** 多久没被重新设定就回到平静；0 = 不回落 */
    decayMinutes: 15,
    /** 深夜自动变困 */
    nightSleepy: true,
    /** 允许模型自己调 robot_face 换表情 */
    autoFace: true,
  },
  /** 屏幕相关的显示偏好 */
  face: {
    /** 要不要眨眼（眨眼节奏由设备端实现） */
    blink: true,
    brightness: 1,
  },
  /** 长期记忆（用装好的 Mnemon）：记得住上次说过的事 */
  memory: {
    enabled: true,
  },
  device: {
    /** 设备鉴权口令，自动生成；烧进固件里 */
    token: '',
    /** 设备多久没说话就算离线 */
    offlineMs: 120000,
    /** 传过来的音频采样率（设备端一般 16000） */
    sampleRate: 16000,
    /** 屏幕型号，只用于面板显示 */
    screen: 'SSD1306 72x40',
  },
  brain: {
    /** 机器人用的 DSH 会话 id（自动创建并记住） */
    sessionId: '',
  },
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

/** 深合并：只补缺失字段，不覆盖已有值 */
function merge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base
  if (base && typeof base === 'object') {
    const out = {}
    const keys = new Set([...Object.keys(base), ...Object.keys(extra || {})])
    for (const k of keys) out[k] = k in base ? merge(base[k], extra?.[k]) : clone(extra[k])
    return out
  }
  return extra === undefined ? base : extra
}

/** 给外面用：把面板/接口送来的局部补丁并进现有配置，不丢同层其它字段 */
export function mergeConfig(base, patch) {
  return merge(clone(base), patch || {})
}

export function normalize(raw) {
  const cfg = merge(clone(DEFAULT_CONFIG), raw || {})

  // 老版本默认人格里写的是「靠轮子移动」那套。只有发现还是旧默认时才升级，
  // 用户自己改过的人格一个字都不动。
  if (!cfg.persona) cfg.persona = DEFAULT_PERSONA
  else if (cfg.persona.includes('靠轮子移动')) cfg.persona = DEFAULT_PERSONA
  delete cfg.rules // 旧的独立规则段已并入每轮注入的「身体说明书」

  // 权限只保留现在认识的那几项（旧配置里的 move / led / pose 清掉）
  const p = cfg.permissions || {}
  cfg.permissions = {
    face: p.face !== false,
    search: p.search !== false,
    look: p.look !== false,
    maxSearchResults: Number(p.maxSearchResults) > 0 ? Math.min(10, Number(p.maxSearchResults)) : 5,
  }

  if (!cfg.device.token) cfg.device.token = 'rt_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  return cfg
}

export function load() {
  try {
    if (existsSync(CONFIG_FILE)) return normalize(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
  } catch (error) {
    // 配置坏了不能让插件起不来
    try {
      const bak = CONFIG_FILE + '.broken-' + Date.now()
      writeFileSync(bak, readFileSync(CONFIG_FILE))
      console.warn('[esp32-robot] 配置文件解析失败，已备份到', bak, error.message)
    } catch (e) {}
  }
  return normalize({})
}

export function save(cfg) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

export function workspaceDir() {
  return join(DATA_DIR, 'workspace')
}
