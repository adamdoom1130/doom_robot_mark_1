// ESP32 小机器人 —— DSH 插件的宿主半边。
//
// 这个文件负责四件事：
//   1. 网关：给 ESP32 一个极简 HTTP 接口（传 16k PCM 上来 / 拉 16k PCM 下去）
//   2. 感官：麦克风音频 → 文字（ASR 适配器），文字 → 语音（TTS 适配器）
//   3. 大脑：把文字送进 DSH 的一个专用会话（preset: esp32-robot），拿回它说的话
//   4. 手脚：给那个会话只挂「机器人动作工具」，并按面板里的权限开关裁剪
//
// 设计原则：机器人永远不能直接操作这台电脑。它只有 move / led / pose / look / status 五个动作，
// 而且每次动作都受 maxMoveMs / maxSpeed / 权限开关限制。这就是「受限指令」的落地方式。

import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, save, workspaceDir, DATA_DIR, mergeConfig } from './lib/config.js'
import { synthesize, splitSentences, listVoices, parseWav, toPcm16k, buildWav, OUT_RATE } from './lib/tts.js'
import { EMOTIONS, EMOTION_KEYS, cleanEmotion, cleanIntensity, createMood } from './lib/face.js'
import { simPage } from './lib/sim.js'

const PREFIX = '/robot'
const SOURCE_KIND = 'esp32-robot'
const PRESET = 'esp32-robot'
const VERSION = '1.1.0'
const TOOL_BUS_KEY = '__dsh_esp32_robot_bus__'

export const name = 'esp32-robot'
// 这三个是硬依赖：缺了就不用启动（宁可不出现在面板里，也别半死不活）。
// sessionController / workspaceRegistry / speechToText 用 ctx.get 取，取不到就报人话。
export const inject = ['webServer', 'systemPrompt', 'sessions']

// ---------------------------------------------------------------- 小工具

function makeLog(ctx) {
  const emit = (level, args) => {
    const line = args.map((a) => (a && a.stack ? a.stack : typeof a === 'string' ? a : safeJson(a))).join(' ')
    const fn = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log
    fn(`[esp32-robot] ${line}`)
    try { ctx.emit?.('esp32-robot/log', { level, line, at: Date.now() }) } catch (error) {}
  }
  return {
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    debug: () => {},
  }
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch (error) { return String(v) }
}

function int16Of(buf) {
  const n = Math.floor(buf.length / 2)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2)
  return out
}

/** 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形 */
function defineTool({ name, description, properties = {}, required = [], run }) {
  return {
    name,
    description,
    // run 也挂出来：buildTools 用它建「当前这一代」的实现表
    run,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' }],
    },
    async execute(args) {
      // 走全局总线：这个工具对象可能是插件上一次运行注册的，真正的实现要从总线上取
      const bus = globalThis[TOOL_BUS_KEY]
      const fn = bus && bus.handlers ? bus.handlers[name] : undefined
      if (typeof fn !== 'function') return { ok: false, message: '这个能力现在没开' }
      try {
        return JSON.parse(JSON.stringify((await fn(args || {})) ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    },
  }
}

const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', description })
const bool = (description) => ({ type: 'boolean', description })

// ---------------------------------------------------------------- 插件

export function apply(ctx, config) {
  const log = makeLog(ctx)
  let cfg = load()
  // 面板/preset 有变化时旧会话可能带着旧组合报 error，升级后自动重开一个
  if (cfg.brain?.version !== VERSION) {
    cfg.brain = { ...cfg.brain, sessionId: '', version: VERSION }
  }
  save(cfg) // 首次运行把默认配置落盘，面板才有东西可看
  const mood = createMood(() => cfg)

  // 工具挂在 agent 的上下文上，不是插件自己的 fiber 上——插件重载时旧的那批不会被自动收走，
  // 而 register 遇到重名又会拒绝新工具，结果就是模型一直调到上一个实例的旧工具（动作进了一个
  // 已经死掉的数组，看起来「说了但没做」）。所以用 globalThis 记着上一代，启动时先把它们收掉。
  const TOOL_REGISTRY_KEY = '__dsh_esp32_robot_tools__'
  const toolReg = (() => {
    const prev = globalThis[TOOL_REGISTRY_KEY]
    if (prev && Array.isArray(prev.offs)) {
      for (const off of prev.offs) {
        try { if (typeof off === 'function') off() } catch (error) {}
      }
    }
    const next = { offs: [] }
    globalThis[TOOL_REGISTRY_KEY] = next
    return next
  })()

  const state = {
    startedAt: Date.now(),
    lastTurn: null,
    lastError: '',
    turns: 0,
    events: [],
    devices: new Map(),
  }

  let agentRef = null
  let agentPromise = null
  const mounted = new WeakSet()
  let mountedNames = []
  const pending = new Map() // sessionId -> { resolve, reject, text, timer }
  let currentActions = null

  function persist() {
    try { save(cfg) } catch (error) { log.warn('保存配置失败：', error.message) }
  }

  function note(type, data) {
    state.events.push({ at: Date.now(), type, ...(data || {}) })
    if (state.events.length > 120) state.events.shift()
  }

  function publicConfig() {
    return JSON.parse(JSON.stringify(cfg))
  }

  // ------------------------------------------------ 会话与大脑

  function controller() {
    const sc = ctx.get('sessionController')
    if (!sc) throw new Error('宿主没有 sessionController（需要桌面版 / Web 组合）')
    return sc
  }

  async function ensureWorkspace() {
    const reg = ctx.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    const dir = workspaceDir()
    mkdirSync(dir, { recursive: true })
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    let ws = reg.list().find((w) => norm(w.path) === norm(dir))
    if (!ws) ws = await reg.create(dir, 'ESP32 小机器人')
    return ws
  }

  const sidOf = (agent) => String(agent?.session?.id ?? agent?.id ?? '').replace(/^session-/, '')

  async function ensureAgent() {
    if (agentRef) return agentRef
    if (agentPromise) return agentPromise
    agentPromise = (async () => {
      const sc = controller()
      if (cfg.brain.sessionId) {
        try {
          const r = await sc.resolveAgent(cfg.brain.sessionId)
          if (r?.agent) {
            mountTools(r.agent)
            return r.agent
          }
        } catch (error) {
          log.warn('旧会话恢复不了，重新建一个：', error.message)
        }
      }
      const ws = await ensureWorkspace()
      const r = await sc.create({ workspaceId: ws.id, agentPreset: PRESET })
      const sid = String(r.sessionId)
      cfg.brain.sessionId = sid
      persist()
      log.info('建好了机器人会话：', sid)
      const resolved = await sc.resolveAgent(sid)
      if (!resolved?.agent) throw new Error('会话建好了但拿不到 agent')
      mountTools(resolved.agent)
      applyModel(resolved.agent)
      return resolved.agent
    })()
    try {
      agentRef = await agentPromise
      return agentRef
    } catch (error) {
      agentPromise = null
      throw error
    }
  }

  /** 面板里选了模型就用它；留空就跟 DSH 现在默认的模型走。 */
  function applyModel(agent) {
    const m = cfg.model || {}
    if (!m.provider || !m.model) return
    try {
      const sc = controller()
      const sel = { provider: m.provider, model: m.model }
      if (m.reasoningEffort) sel.reasoningEffort = m.reasoningEffort
      if (sc.agents && typeof sc.agents.selectForNextRequest === 'function') sc.agents.selectForNextRequest(agent, sel)
      else agent.session.append('model/selection', sel)
    } catch (error) {
      log.debug?.('设置模型失败：', error.message)
    }
  }

  // ------------------------------------------------ 受限动作工具

  function actionsOf() {
    if (!currentActions) currentActions = []
    return currentActions
  }

  function buildTools() {
    const p = cfg.permissions || {}
    const tools = []

    // 表情：这是它唯一能「做动作」的地方。心情模块关掉时，这个工具根本不存在。
    if (p.face && cfg.mood?.enabled && cfg.mood?.autoFace !== false) {
      tools.push(defineTool({
        name: 'robot_face',
        description: `换表情（你唯一能改变自己的方式）。emotion 只能是：${EMOTION_KEYS.join('/')}。`,
        properties: {
          emotion: { type: 'string', enum: EMOTION_KEYS, description: '表情' },
          intensity: { type: 'number', description: '强度 0.2-1' },
          reason: str('一句话理由（可选）'),
        },
        required: ['emotion'],
        run: async (args) => {
          const emotion = cleanEmotion(args.emotion, '')
          if (!emotion) return { ok: false, message: '表情只能从这些里选：' + EMOTION_KEYS.join(' / ') }
          const intensity = cleanIntensity(args.intensity)
          mood.set(emotion, { intensity, reason: args.reason || '模型自己换的' })
          actionsOf().push({ type: 'face', emotion, intensity })
          note('face', { emotion, intensity })
          return { ok: true, message: `表情换成「${EMOTIONS[emotion].label}」`, face: { emotion, intensity } }
        },
      }))
    }

    // 联网搜索：查事实 / 新闻 / 天气 / 价格都靠它
    if (p.search !== false) {
      tools.push(defineTool({
        name: 'robot_search',
        description: '联网查事实、新闻、天气、价格。用自己的话说结论，不要念网址。',
        properties: { query: str('关键词，别写整句') },
        required: ['query'],
        run: async (args) => {
          const q = String(args.query || '').trim()
          if (!q) return { ok: false, message: '要搜什么？' }
          const web = ctx.get('web')
          if (!web || typeof web.search !== 'function') return { ok: false, message: '宿主没有联网搜索服务' }
          const max = Math.max(1, Math.min(10, Number(p.maxSearchResults) || 5))
          try {
            // 用「当前 agent」的身份去搜：DeepSeek 的搜索默认走账号登录态，
            // 插件的裸调用没有这层身份，会报 "has no API key"。withInitiator 把它补上。
            const agentsSvc = ctx.get('agents')
            const runSearch = () => web.search({ query: q, maxResults: max })
            const r = (agentsSvc && typeof agentsSvc.withInitiator === 'function' && agentRef)
              ? await agentsSvc.withInitiator(agentRef, runSearch)
              : await runSearch()
            const sources = (r.sources || []).slice(0, max)
            const results = sources.map((s) => ({ title: s.title || '', url: s.url, snippet: (s.snippet || '').slice(0, 400) }))
            let summary = String(r.content || '').trim()
            let fetched = 0
            // 搜索接口常常只给标题和链接。没有正文的时候，自己抓第一条读一段，
            // 否则模型只会看到一堆空壳，最后说「我查到了但读不出来」。
            const snippetChars = results.reduce((n, x) => n + x.snippet.length, 0)
            if (summary.length < 40 && snippetChars < 80) {
              for (const src of results.slice(0, 2)) {
                try {
                  const page = await web.fetch({ url: src.url })
                  const text = String(page.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                  if (text.length > 80) {
                    summary = (summary ? summary + '\n\n' : '') + `【${src.title || src.url}】${text.slice(0, 1800)}`
                    fetched++
                  }
                } catch (error) {}
                if (summary.length > 1600) break
              }
            }
            note('search', { query: q, count: results.length, summary: summary.length, fetched })
            return {
              ok: true,
              message: summary ? `查到 ${results.length} 条，摘到 ${summary.length} 字正文` : `查到 ${results.length} 条，但都没拿到正文`,
              query: q,
              summary: summary ? summary.slice(0, 3000) : '',
              results,
            }
          } catch (error) {
            const raw = String(error?.message || error)
            const hint = /API key|CREDENTIAL_MISSING|credential/i.test(raw)
              ? '联网搜索还没配好：DSH 里没有 DeepSeek 搜索密钥。这次你查不到，直接说查不了，别编。'
              : /abort/i.test(raw)
                ? '搜索超时了，这次没查到。'
                : '搜索失败：' + raw.slice(0, 120)
            note('search-error', { message: raw.slice(0, 200) })
            return { ok: false, message: hint }
          }
        },
      }))
    }

    if (p.look) {
      tools.push(defineTool({
        name: 'robot_look',
        description: '拍一张现在的画面。设备还没接上摄像头时会返回失败。',
        run: async () => {
          const d = latestDevice()
          if (!d || !d.frame) return { ok: false, message: '摄像头没有画面（设备还没上报，或者摄像头没接）' }
          actionsOf().push({ type: 'look' })
          return { ok: true, message: `拍到了（${Math.round(d.frame.at / 1000)} 秒前的画面，${d.frame.bytes} 字节）` }
        },
      }))
    }

    tools.push(defineTool({
      name: 'robot_status',
      description: '看看自己现在的状态：在不在线、电量、当前表情、上次做了什么。',
      run: async () => {
        const d = latestDevice()
        const m = mood.snapshot()
        const label = EMOTIONS[m.emotion]?.label || '平静'
        return {
          ok: true,
          message: d ? `在线（${d.id}），现在${label}` : `现在没有设备连着我，自己在这儿${label}`,
          online: Boolean(d),
          battery: d?.battery ?? null,
          mood: cfg.mood?.enabled ? { emotion: m.emotion, label, intensity: m.intensity, reason: m.reason } : null,
          lastAction: actionsOf()[actionsOf().length - 1] || null,
        }
      },
    }))

    // 工具对象本身可能还是上一代注册的（重名注册会被拒绝），所以真正干活的是这张表：
    // 每次挂载都换成当前这一代，旧工具对象调过来也能落到新实现上。
    globalThis[TOOL_BUS_KEY] = {
      handlers: Object.fromEntries(tools.map((t) => [t.name, t.run])),
      at: Date.now(),
    }

    return tools
  }

  /**
   * 每轮的「身体说明书」。
   *
   * 这段文字每轮都会进上下文，所以只写**会变的东西**：权限、心情、设备、记忆规则。
   * 静态人设（性格、语气）归人格卡管，别在这里重复——重复一次就是每轮多花一份 token。
   */
  function bodyContext() {
    const p = cfg.permissions || {}
    const m = mood.snapshot()
    const d = latestDevice()
    const L = []
    L.push(`## 身体`)
    L.push(`- 屏幕 72×40，只有眼睛和嘴。没有轮子、不会移动；让你动就说做不到。`)
    const can = []
    if (cfg.mood?.enabled && p.face) can.push(`换表情(robot_face，${EMOTION_KEYS.join('/')})`)
    if (p.search) can.push('联网查(robot_search)')
    if (p.look) can.push('看画面(robot_look)')
    L.push(`- 你现在能做：${can.length ? can.join('、') : '只能说话和看自己的状态'}。`)
    L.push(`- 心情：${EMOTIONS[m.emotion]?.label || '平静'}；设备：${d ? (d.battery != null ? `在线 ${d.battery}%` : '在线') : '没连着'}。`)
    L.push('')
    L.push('## 记忆')
    if (cfg.memory?.enabled !== false) {
      L.push('- 关于对方的稳定小事（喜好、习惯、重要的日子）→ mnemon_runtime_memory，一句说清，会每轮自动带上。')
      L.push('- 更具体、以后要翻查的（约定、经历、他说过的话）→ mnemon_remember，写完整一句带时间。')
      L.push('- 他说"上次""之前讲的"而你想不起来 → 先 mnemon_recall，再回答；查不到就说记不住，别编。')
      L.push('- 同一件事别重复记；记忆空间不存在时不要反复重试，改用 runtime_memory。')
    } else {
      L.push('- 你没有长期记忆。对方让你记住什么，就说"我这次记不住，再说一遍"。')
    }
    return L.join('\n')
  }

  /**
   * 机器人能看到哪些工具。
   *
   * 这张表直接决定每轮要发多少 token：每个工具都带完整 JSON schema，而 Mnemon 那几个工具
   * 的 schema 特别大（mnemon_memory_body_create 一个就有几十行）。所以只留语音场景真正会用到的：
   *   热记忆 1 个（自动注入，记小事）
   *   结构化 3 个（记 / 查 / 忘）
   * 建空间、列空间、状态、文档这些都是一次性运维动作，不该常驻在每轮的上下文里。
   */
  const ALLOWED_TOOLS = new Set([
    'robot_face', 'robot_search', 'robot_look', 'robot_status',
    'mnemon_runtime_memory', 'mnemon_remember', 'mnemon_recall', 'mnemon_forget',
  ])

  function restrictTools(agent) {
    const t = agent.ctx?.tools
    if (!t || typeof t.restrict !== 'function' || typeof t.schemas !== 'function') return
    let names = []
    try { names = t.schemas().map((s) => s && s.name).filter(Boolean) } catch (error) { return }
    const deny = names.filter((n) => !ALLOWED_TOOLS.has(n))
    if (!deny.length) return
    try {
      toolReg.offs.push(t.restrict({ deny }))
      log.info(`已屏蔽 ${deny.length} 个不该给机器人的工具：${deny.slice(0, 6).join('、')}${deny.length > 6 ? '…' : ''}`)
    } catch (error) {
      log.warn('屏蔽多余工具失败：', error.message)
    }
  }

  function mountTools(agent) {
    if (!agent || mounted.has(agent)) return
    const target = agent.ctx?.tools
    if (!target || typeof target.register !== 'function') {
      log.warn('拿不到会话的工具注册表，动作工具没挂上')
      return
    }
    const names = []
    for (const tool of buildTools()) {
      try {
        toolReg.offs.push(target.register(tool))
        names.push(tool.name)
      } catch (error) {
        log.warn(`工具 ${tool.name} 挂不上：`, error.message)
      }
    }
    restrictTools(agent)
    // 每轮重新求值，权限/心情一改，模型下一句就知道
    try {
      const sp = agent.ctx?.systemPrompt
      if (sp && typeof sp.context === 'function') {
        toolReg.offs.push(sp.context({ name: 'esp32-robot-body', order: 905, text: () => bodyContext() }))
      }
    } catch (error) {
      log.warn('挂「身体说明」失败：', error.message)
    }
    mounted.add(agent)
    mountedNames = names
    log.info('动作工具已挂到机器人会话：' + names.join('、'))
  }

  /** 面板里改了权限，就把工具重挂一遍：关掉的能力要立刻从模型眼前消失。 */
  function remountTools() {
    for (const off of toolReg.offs.splice(0)) {
      try { if (typeof off === 'function') off() } catch (error) {}
    }
    if (!agentRef) return
    mounted.delete(agentRef)
    mountTools(agentRef)
  }

  // ------------------------------------------------ 一轮对话

  function onSessionEvent(session, event) {
    try {
      if (!event) return
      const sid = String(session?.id ?? '').replace(/^session-/, '')
      const p = pending.get(sid)
      if (!p) return
      if (event.type === 'assistant/message') {
        const d = event.data || {}
        if (d.interrupted) return
        const text = (d.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
        if (text) p.text = text
        return
      }
      if (event.type === 'turn/end') {
        const d = event.data || {}
        const ok = d.reason && d.reason.kind === 'completed'
        pending.delete(sid)
        clearTimeout(p.timer)
        if (ok) p.resolve(p.text)
        else p.reject(new Error('这一轮没正常结束：' + (d.reason?.kind || '?')))
      }
    } catch (error) {
      log.warn('处理会话事件出错：', error.message)
    }
  }

  /** 把一句话交给大脑，等它说完；期间工具调用记进 actions。 */
  async function runTurn(text, opts = {}) {
    const clean = String(text || '').trim()
    if (!clean) throw new Error('没有听到内容')
    const agent = await ensureAgent()
    const sid = sidOf(agent)
    if (pending.has(sid)) throw new Error('上一轮还没说完，等一下')
    const timeoutMs = Number(opts.timeoutMs) || 90000
    currentActions = []
    const actions = currentActions
    const result = new Promise((resolve, reject) => {
      const entry = { text: '', resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        pending.delete(sid)
        reject(new Error('等太久了（' + Math.round(timeoutMs / 1000) + ' 秒还没说完）'))
      }, timeoutMs)
      pending.set(sid, entry)
    })
    Promise.resolve()
      .then(() => agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: clean }], source: { kind: SOURCE_KIND } }))
      .catch((error) => {
        const entry = pending.get(sid)
        if (!entry) return
        pending.delete(sid)
        clearTimeout(entry.timer)
        entry.reject(error)
      })
    const reply = await result
    return { reply: String(reply || '').trim(), actions }
  }

  // ------------------------------------------------ 语音

  function latestDevice() {
    let best = null
    for (const d of state.devices.values()) {
      if (!best || d.at > best.at) best = d
    }
    return best
  }

  async function speechToText(body, query) {
    const provider = cfg.asr?.provider || 'dsh'
    if (provider === 'off') throw new Error('语音识别关着（面板里 asr.provider = off）；可以直接发文字测试')
    const wav = parseWav(body)
    let pcm
    if (wav) pcm = toPcm16k(wav.pcm, wav.sampleRate, wav.channels)
    else pcm = toPcm16k(int16Of(body), Number(query.rate) || Number(cfg.device.sampleRate) || OUT_RATE, Number(query.ch) || 1)
    if (!pcm.length) throw new Error('没收到音频')
    const audio = buildWav(new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2), OUT_RATE, 1)

    if (provider === 'http') {
      const c = cfg.asr.http || {}
      if (!c.url) throw new Error('asr.provider = http，但没填识别接口地址')
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', c.model || 'whisper-1')
      if (cfg.asr.language) form.append('language', cfg.asr.language)
      const res = await fetch(c.url, {
        method: 'POST',
        headers: c.key ? { authorization: 'Bearer ' + c.key } : {},
        body: form,
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) throw new Error(`识别接口 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 160)}`)
      const data = await res.json().catch(() => ({}))
      const text = String(data.text || data.result || '').trim()
      if (!text) throw new Error('识别接口没返回文字')
      return text
    }

    const svc = ctx.get('speechToText')
    if (!svc) throw new Error('DSH 里没有语音识别服务（speechToText）')
    const snap = svc.snapshot?.()
    if (snap && Array.isArray(snap.providers) && snap.providers.length === 0) {
      throw new Error('DSH 里还没有装语音识别模型：设置 → 插件 里启用 voice-input 那个官方包，或者把 asr.provider 改成 http 填一个 OpenAI 兼容的识别接口')
    }
    const spec = svc.resolve({ audio: new Uint8Array(audio), language: cfg.asr.language || 'zh' })
    const r = await svc.transcribe(spec, AbortSignal.timeout(60000))
    return String(r?.text || '').trim()
  }

  // ------------------------------------------------ HTTP

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    try {
      res.statusCode = code
      res.setHeader?.('content-type', type)
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    } catch (error) {}
  }

  const readBody = async (req, limit = 8 * 1024 * 1024) => {
    const parts = []
    let n = 0
    for await (const c of req) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      n += b.length
      if (n > limit) throw new Error('上传的音频太大了')
      parts.push(b)
    }
    return Buffer.concat(parts)
  }

  const query = (req) => {
    try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams) } catch (error) { return {} }
  }

  function deviceAuthorized(req, q) {
    const token = String(cfg.device?.token || '')
    if (!token) return true
    const h = req.headers || {}
    let given = String(h['x-robot-token'] || '')
    if (!given) {
      const auth = String(h.authorization || '')
      if (auth.toLowerCase().startsWith('bearer ')) given = auth.slice(7).trim()
    }
    if (!given) given = String(q.token || '')
    return given === token
  }

  function touchDevice(id, extra) {
    const key = String(id || 'robot-1')
    const prev = state.devices.get(key) || { id: key, firstSeen: Date.now() }
    const next = { ...prev, ...(extra || {}), id: key, at: Date.now() }
    state.devices.set(key, next)
    return next
  }

  /** 设备主接口：POST 音频（或文字）→ 返回「一行 JSON 头 + 16k PCM 流」 */
  async function handleTurn(req, res) {
    const q = query(req)
    if (!deviceAuthorized(req, q)) return send(res, 401, { ok: false, message: 'token 不对' })
    const t0 = Date.now()
    let body
    try { body = await readBody(req) } catch (error) { return send(res, 413, { ok: false, message: error.message }) }
    if (!cfg.enabled) return send(res, 200, { ok: false, message: '插件总开关关着' })

    const ctype = String(req.headers['content-type'] || '')
    let text = ''
    let asrMs = 0
    try {
      if (ctype.includes('application/json')) {
        const j = JSON.parse(body.toString('utf8') || '{}')
        text = String(j.text || '').trim()
        if (j.battery !== undefined || j.id) touchDevice(j.id, { battery: j.battery, firmware: j.firmware })
      } else if (ctype.includes('text/plain')) {
        text = body.toString('utf8').trim()
      } else {
        const d = touchDevice(q.id || req.headers['x-robot-id'], { bytes: body.length })
        state.devices.set(d.id, d)
        const asrStart = Date.now()
        text = await speechToText(body, q)
        asrMs = Date.now() - asrStart
        note('asr', { text, ms: asrMs })
      }
    } catch (error) {
      state.lastError = error.message
      note('error', { where: 'asr', message: error.message })
      return send(res, 200, { ok: false, message: error.message })
    }

    let result
    try {
      result = await runTurn(text, { timeoutMs: Number(q.timeout) || 90000 })
    } catch (error) {
      state.lastError = error.message
      note('error', { where: 'brain', message: error.message })
      return send(res, 200, { ok: false, message: error.message, heard: text })
    }

    const header = {
      ok: true,
      reply: result.reply,
      actions: result.actions,
      // 这一轮该显示什么表情：说话中；真正的「心情」由 ping 持续同步
      face: { ...mood.snapshot('speaking'), blink: cfg.face?.blink !== false },
      heard: text,
      rate: OUT_RATE,
      format: 's16le',
      stream: true,
      ms: { asr: asrMs, total: Date.now() - t0 },
    }
    state.turns++
    state.lastTurn = { at: Date.now(), heard: text, reply: result.reply, actions: result.actions, asrMs, totalMs: Date.now() - t0 }
    note('turn', { heard: text, reply: result.reply.slice(0, 120), actions: result.actions.length })

    // 只要文字 / 不用出声的客户端
    const wantsJson = String(req.headers.accept || '').includes('application/json') || q.fmt === 'json'
    if (wantsJson) {
      const chunks = []
      for (const s of splitSentences(result.reply)) {
        try { chunks.push(await synthesize(s, cfg.voice, log)) } catch (error) { log.warn('合成失败：', error.message) }
      }
      const pcm = Buffer.concat(chunks)
      return send(res, 200, { ...header, stream: false, audio: pcm.toString('base64'), pcmBytes: pcm.length })
    }

    // 设备：先把第一句合成出来，这样出错还能回 JSON
    const sentences = splitSentences(result.reply)
    let first = Buffer.alloc(0)
    let ttsError = ''
    if (sentences.length) {
      try { first = await synthesize(sentences[0], cfg.voice, log) } catch (error) { ttsError = error.message }
    }
    try {
      // 裸流：不套 chunked 编码。ESP32 那边只要读到连接关闭就是一段完整的 PCM，
      // 不用自己解 chunk 头，代码少一半、也不会因为分包卡住。
      res.useChunkedEncodingByDefault = false
      res.writeHead(200, {
        'content-type': 'application/vnd.robot.pcm',
        'cache-control': 'no-store',
        'x-robot-rate': String(OUT_RATE),
        'x-robot-format': 's16le',
        connection: 'close',
      })
      res.flushHeaders?.()
      res.write(JSON.stringify({ ...header, ttsError: ttsError || undefined }) + '\n')
      if (first.length) res.write(first)
      for (let i = 1; i < sentences.length; i++) {
        try {
          const pcm = await synthesize(sentences[i], cfg.voice, log)
          if (pcm.length) res.write(pcm)
        } catch (error) {
          log.warn('后半句合成失败：', error.message)
          break
        }
      }
      res.end()
    } catch (error) {
      log.warn('写音频流出错：', error.message)
      try { res.end() } catch (e) {}
    }
  }

  // ------------------------------------------------ 模拟器页面


  // ------------------------------------------------ 路由注册

  const web = ctx.get('webServer')
  if (web && typeof web.register === 'function') {
    const route = (kind, path, handler, label) => {
      try {
        ctx.effect(() => web.register({ kind, path: PREFIX + path, handler: async (req, res) => {
          try {
            const out = await handler(req, res)
            if (out !== undefined) send(res, 200, out)
          } catch (error) {
            try { send(res, 200, { ok: false, message: String(error?.message || error) }) } catch (e) {}
          }
        } }), label)
      } catch (error) {
        log.warn(`路由 ${path} 注册失败：`, error.message)
      }
    }

    route('exact', '/sim', async (req, res) => send(res, 200, simPage(cfg.device?.token || ''), 'text/html; charset=utf-8'), 'esp32-robot: 模拟器')

    route('exact', '/api/state', async () => {
      const m = mood.snapshot()
      return {
      ok: true,
      version: '1.0.0',
      config: publicConfig(),
      runtime: {
        enabled: cfg.enabled,
        sessionId: cfg.brain.sessionId,
        turns: state.turns,
        lastTurn: state.lastTurn,
        lastError: state.lastError,
        mood: { ...m, label: EMOTIONS[m.emotion]?.label || '平静' },
        tools: mountedNames.slice(),
        faces: EMOTION_KEYS.map((k) => ({ key: k, ...EMOTIONS[k] })),
        devices: [...state.devices.values()].map((d) => ({ id: d.id, at: d.at, battery: d.battery })),
        events: state.events.slice(-12),
        simUrl: PREFIX + '/sim?token=' + encodeURIComponent(cfg.device?.token || ''),
        turnUrl: PREFIX + '/api/turn',
      },
      }
    }, 'esp32-robot: 状态')

    // 面板上的表情按钮 / 将来的手机端都走这个
    route('exact', '/api/face', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: '只接受 POST' })
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      if (!cfg.mood?.enabled) return { ok: false, message: '心情模块关着（在上面的开关里打开它）' }
      const emotion = cleanEmotion(body.emotion, '')
      if (!emotion) return { ok: false, message: '不认识这个表情：' + String(body.emotion || '') }
      const m = mood.set(emotion, { intensity: cleanIntensity(body.intensity), reason: '面板手动' })
      note('face', { emotion, manual: true })
      return { ok: true, mood: { ...m, label: EMOTIONS[m.emotion]?.label || '平静' } }
    }, 'esp32-robot: 换表情')

    route('exact', '/api/voices', async () => ({ ok: true, voices: await listVoices(true) }), 'esp32-robot: 音色')

    // 面板「检查联网」用：只回能不能用，不回内容（诊断细节留在服务端日志里）
    route('exact', '/api/search', async (req) => {
      const q = query(req).q || '上海天气'
      const web = ctx.get('web')
      if (!web) return { ok: true, available: false, message: '宿主没有 web 服务' }
      try {
        const agentsSvc = ctx.get('agents')
        const run = () => web.search({ query: q, maxResults: 2 })
        const r = (agentsSvc && typeof agentsSvc.withInitiator === 'function' && agentRef)
          ? await agentsSvc.withInitiator(agentRef, run)
          : await run()
        return { ok: true, available: true, count: (r.sources || []).length }
      } catch (error) {
        return { ok: true, available: false, message: String(error?.message || error).split(';')[0].slice(0, 160) }
      }
    }, 'esp32-robot: 联网检查')

    route('exact', '/api/config', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: '只接受 POST' })
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const { resetSession, ...patch } = body
      // 深合并：面板只发半边（比如只改 permissions.search）时不能把同层其它开关冲掉
      cfg = mergeConfig(cfg, patch)
      if (resetSession) {
        cfg.brain = { ...cfg.brain, sessionId: '' }
        agentRef = null
        agentPromise = null
      }
      persist()
      note('config', { keys: Object.keys(patch), resetSession: Boolean(resetSession) })
      remountTools()
      applyModelIfPossible()
      return { ok: true, config: publicConfig() }
    }, 'esp32-robot: 保存配置')

    route('exact', '/api/turn', handleTurn, 'esp32-robot: 对话接口')

    route('exact', '/api/frame', async (req, res) => {
      if (!deviceAuthorized(req, query(req))) return send(res, 401, { ok: false, message: 'token 不对' })
      const body = await readBody(req)
      const d = touchDevice(query(req).id || req.headers['x-robot-id'], { frame: { at: Date.now(), bytes: body.length } })
      state.devices.set(d.id, d)
      try {
        mkdirSync(join(DATA_DIR, 'frames'), { recursive: true })
        const file = join(DATA_DIR, 'frames', 'latest.jpg')
        writeFileSync(file, body)
        ;(d.frame).file = file
      } catch (error) {}
      return { ok: true }
    }, 'esp32-robot: 画面')

    route('exact', '/api/ping', async (req, res) => {
      const q = query(req)
      if (!deviceAuthorized(req, q)) return send(res, 401, { ok: false, message: 'token 不对' })
      const d = touchDevice(q.id || req.headers['x-robot-id'], { firmware: q.fw, battery: q.battery ? Number(q.battery) : undefined })
      state.devices.set(d.id, d)
      return {
        ok: true, name: cfg.name, serverTime: Date.now(), offlineMs: cfg.device.offlineMs, hasFrame: Boolean(d.frame),
        // 设备空闲时靠这个同步心情和表情（每 10~30 秒 ping 一次就够）
        face: { ...mood.snapshot('idle'), blink: cfg.face?.blink !== false },
      }
    }, 'esp32-robot: 握手')
  } else {
    log.warn('宿主没有 webServer，机器人接口起不来')
  }

  function applyModelIfPossible() {
    if (agentRef) applyModel(agentRef)
  }

  // ------------------------------------------------ 提示词变量

  try {
    const sp = ctx.get('systemPrompt')
    if (sp && typeof sp.variable === 'function') {
      ctx.effect(() => sp.variable('robot_persona', () => cfg.persona || ''), 'esp32-robot: 人格变量')
    } else {
      log.warn('宿主没有 systemPrompt，人格变量挂不上')
    }
  } catch (error) {
    log.warn('提示词变量注册失败：', error.message)
  }

  // ------------------------------------------------ 会话事件

  try {
    ctx.effect(() => {
      const off = ctx.on('session/event', (session, event) => onSessionEvent(session, event))
      return () => { try { if (typeof off === 'function') off() } catch (error) {} }
    }, 'esp32-robot: 盯会话')
  } catch (error) {
    log.warn('监听会话事件失败：', error.message)
  }

  // 清掉旧的临时音频
  try {
    const dir = join(DATA_DIR, 'tmp')
    if (existsSync(dir)) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        try { if (Date.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p) } catch (error) {}
      }
    }
  } catch (error) {}

  log.info(`机器人「${cfg.name}」的大脑已就绪：${PREFIX}/sim 可以模拟，${PREFIX}/api/turn 给真机用`)

  return () => {
    for (const p of pending.values()) { try { clearTimeout(p.timer); p.reject(new Error('插件停了')) } catch (error) {} }
    pending.clear()
    for (const off of toolReg.offs.splice(0)) {
      try { if (typeof off === 'function') off() } catch (error) {}
    }
    if (globalThis[TOOL_REGISTRY_KEY] === toolReg) globalThis[TOOL_REGISTRY_KEY] = null
  }
}
