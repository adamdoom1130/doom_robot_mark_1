// 语音合成：文字 → 16kHz / 单声道 / s16le 的裸 PCM（ESP32 拿到直接塞 I2S，不用解码）。
//
// 三条路：
//   windows：系统自带 SAPI（离线、免费、零依赖，中文是 Huihui）。本机现在就能用。
//   http   ：自己填一个 TTS 地址（{text} 占位），返回 wav 或裸 pcm16 都行。
//   off    ：不出声，只返回文字（调固件的时候用）。
//
// 为什么要转成 16k PCM：MAX98357A 只吃 I2S 数字音频，设备端不做 MP3/AAC 解码就不用带解码器、
// 不用 PSRAM 缓冲，固件能短很多。代价是网络流量大一点（16k×2 字节/秒 = 32KB/s），局域网无所谓。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './config.js'

export const OUT_RATE = 16000

function run(cmd, args, { timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch (error) {}
      err += '\n超时'
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    if (input !== undefined) child.stdin.end(input, 'utf8')
  })
}

function tmpFile(ext) {
  const dir = join(DATA_DIR, 'tmp')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${randomUUID()}.${ext}`)
}

// ---------- WAV ----------

/** 解析 RIFF WAV，返回 { sampleRate, channels, pcm: Int16Array }。认不出来的返回 null。 */
export function parseWav(buf) {
  if (!buf || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12
  let fmt = null
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      const end = Math.min(body + size, buf.length)
      data = buf.subarray(body, end)
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null
  const pcm = new Int16Array(data.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2)
  return { sampleRate: fmt.sampleRate, channels: fmt.channels || 1, pcm }
}

export function buildWav(pcm, sampleRate = OUT_RATE, channels = 1) {
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + bytes.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(bytes.length, 40)
  return Buffer.concat([header, bytes])
}

/** 任意采样率/声道 → 16k 单声道 s16le。线性插值就够（语音带宽本来就窄）。 */
export function toPcm16k(pcm, sampleRate, channels = 1) {
  if (!pcm.length) return Buffer.alloc(0)
  // 先降成单声道
  let mono = pcm
  if (channels > 1) {
    const n = Math.floor(pcm.length / channels)
    mono = new Int16Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += pcm[i * channels + c]
      mono[i] = sum / channels
    }
  }
  if (sampleRate === OUT_RATE) return Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength)
  const ratio = sampleRate / OUT_RATE
  const outLen = Math.floor(mono.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, mono.length - 1)
    const frac = src - i0
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength)
}

// ---------- 系统语音 ----------

let voiceCache = { at: 0, list: [] }

/** 用 -EncodedCommand 调 PowerShell：脚本里有引号、竖线、中文都不会被外面的 shell 再解释一遍。 */
function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

export async function listVoices(force = false) {
  if (!force && Date.now() - voiceCache.at < 60000 && voiceCache.list.length) return voiceCache.list
  if (process.platform === 'darwin') {
    // macOS：say -v ? 输出形如 "Tingting            zh_CN    # 你好"
    const r = await run('say', ['-v', '?'], { timeoutMs: 20000 })
    if (r.code === 0) {
      const list = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(.+?)\s{2,}([a-zA-Z_]+)\s*(?:#|$)/)
        if (!m) return null
        return { name: m[1].trim(), culture: m[2].replace('_', '-'), gender: '' }
      }).filter(Boolean)
      voiceCache = { at: Date.now(), list }
      return list
    }
    return []
  }
  if (process.platform !== 'win32') return []
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$sep=[char]124;',
    'try{ $s.GetInstalledVoices()|ForEach-Object{ $_.VoiceInfo.Name + $sep + $_.VoiceInfo.Culture.Name + $sep + $_.VoiceInfo.Gender } }catch{};',
    '$s.Dispose()',
  ].join('')
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const r = await run(exe, psArgs(script), { timeoutMs: 20000 })
    if (r.code === 0 && r.out.trim()) {
      const list = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, culture, gender] = l.split('|')
        return { name, culture, gender }
      }).filter((v) => v.name)
      voiceCache = { at: Date.now(), list }
      return list
    }
  }
  return []
}

function runWithEnv(cmd, args, opts, env) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env } })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch (e) {} ; err += '\n超时' }, opts.timeoutMs || 30000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
    if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8')
  })
}

async function synthWindows(text, voice) {
  const file = tmpFile('wav')
  const script = [
    '[Console]::InputEncoding=[Text.Encoding]::UTF8;',
    'Add-Type -AssemblyName System.Speech;',
    '$t=[Console]::In.ReadToEnd();',
    'if(-not $t){exit 2};',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    'if($env:RB_VOICE){try{$s.SelectVoice($env:RB_VOICE)}catch{}};',
    'try{$s.Rate=[int]$env:RB_RATE}catch{};',
    'try{$s.Volume=[int]$env:RB_VOL}catch{};',
    '$s.SetOutputToWaveFile($env:RB_OUT);',
    '$s.Speak($t);',
    '$s.Dispose()',
  ].join('')
  const env = {
    RB_VOICE: String(voice?.name || ''),
    RB_RATE: String(Math.max(-10, Math.min(10, Math.round(Number(voice?.rate) || 0) / 5))),
    RB_VOL: String(Math.max(0, Math.min(100, Number(voice?.volume) || 100))),
    RB_OUT: file,
  }
  let last = { err: 'no powershell' }
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    last = await runWithEnv(exe, psArgs(script), { timeoutMs: 30000, input: text }, env)
    if (existsSync(file) && statSync(file).size > 1000) break
  }
  if (!existsSync(file) || statSync(file).size < 1000) {
    throw new Error('系统语音合成失败：' + String(last.err || last.out || '').slice(-200))
  }
  const wav = parseWav(readFileSync(file))
  try { unlinkSync(file) } catch (error) {}
  if (!wav) throw new Error('系统语音输出的不是 16bit PCM WAV')
  return toPcm16k(wav.pcm, wav.sampleRate, wav.channels)
}

/** macOS：say 直接吐 16k 单声道 WAV，不用自己重采样 */
async function synthSay(text, voice) {
  const file = tmpFile('wav')
  const args = ['-o', file, '--data-format=LEI16@16000']
  if (voice?.name) args.push('-v', voice.name)
  // say 的语速是「每分钟词数」，中文默认 180 左右；rate 是 -50~50 的百分比
  const wpm = Math.round(180 * (1 + (Number(voice?.rate) || 0) / 100))
  args.push('-r', String(Math.max(90, Math.min(400, wpm))))
  args.push(text)
  const r = await run('say', args, { timeoutMs: 30000 })
  if (!existsSync(file) || statSync(file).size < 1000) {
    throw new Error('系统语音合成失败：' + String(r.err || r.out || '').slice(-200))
  }
  const wav = parseWav(readFileSync(file))
  try { unlinkSync(file) } catch (error) {}
  if (!wav) throw new Error('say 输出的不是 WAV')
  return toPcm16k(wav.pcm, wav.sampleRate, wav.channels)
}

// ---------- 自建 HTTP TTS ----------

async function synthHttp(text, voice) {
  const c = voice?.http || {}
  const tpl = String(c.urlTemplate || '')
  if (!tpl.includes('{text}')) throw new Error('自建 TTS 地址里要有 {text} 占位符')
  const url = tpl.split('{text}').join(encodeURIComponent(text))
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 200) throw new Error('TTS 返回的音频太短')
  const wav = parseWav(buf)
  if (wav) return toPcm16k(wav.pcm, wav.sampleRate, wav.channels)
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    throw new Error('自建 TTS 返回了 MP3：请让它返回 wav 或裸 pcm16（本插件不做 MP3 解码）')
  }
  // 裸 pcm16
  const rate = Number(c.sampleRate) || 24000
  const pcm = new Int16Array(buf.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2)
  return toPcm16k(pcm, rate, 1)
}

// ---------- 对外 ----------

/**
 * 一句话 → 16k s16le PCM。
 * @returns {Promise<Buffer>} 空 Buffer 表示「这次不出声」
 */
export async function synthesize(text, voice, log) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return Buffer.alloc(0)
  // 'windows' 是旧配置里的写法，等价于现在的 'system'（系统自带语音）
  const provider = voice?.provider === 'windows' ? 'system' : (voice?.provider || 'system')
  if (provider === 'off') return Buffer.alloc(0)
  if (provider === 'http' && voice?.http?.urlTemplate) return synthHttp(clean, voice)
  if (provider === 'http') throw new Error('选了自建 TTS，但没填地址')
  try {
    if (process.platform === 'darwin') return await synthSay(clean, voice)
    if (process.platform !== 'win32') throw new Error('这个系统没有自带语音，请改用自建 TTS')
    return await synthWindows(clean, voice)
  } catch (error) {
    log?.warn?.('系统语音失败：' + error.message)
    throw error
  }
}

/** 把一段话切成适合逐句合成的短句（第一句单独出声，后面 60 字左右合并一次）。 */
export function splitSentences(text) {
  const src = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>]/g, '')
  const parts = src.split(/(?<=[。！？!?…；;\n])/).map((s) => s.trim()).filter(Boolean)
  const out = []
  let buf = ''
  for (const p of parts) {
    // 第一句立刻单独送，让人更快听到声音
    if (!out.length && !buf) { out.push(p); continue }
    if ((buf + p).length > 60 && buf) { out.push(buf); buf = p } else buf += p
  }
  if (buf) out.push(buf)
  return out
}
