// 表情表：0.36 寸 SSD1306（72×40）上画的那张脸。
//
// 这张表是「唯一真相」：网页面板的预览用它画，固件照着同一组数字画。
// 屏幕很小（72×40），所以只有两只眼睛 + 一张嘴，靠眼型和嘴型表达情绪。
//
// 坐标都以 72×40 的画布为准：
//   左眼中心 (24,16)、右眼中心 (48,16)，眼宽 eyeW、眼高 eyeH
//   嘴中心 (36, 30)
// 固件里照着这几个数画，就能和在面板里看到的一致。

export const SCREEN = { w: 72, h: 40, eyeY: 16, leftX: 24, rightX: 48, mouthY: 30 }

/**
 * eye:
 *   open   圆角矩形睁眼（带瞳孔）
 *   arc    ^ 形笑眼（开心）
 *   half   半闭（犯困 / 思考）
 *   closed 一条线（睡着）
 * mouth:
 *   flat   一条横线        smile  上弯
 *   frown  下弯            tiny   小圆点
 *   open   张开（兴奋）    talk   说话时上下动
 *   wave   波浪（困惑）
 */
export const EMOTIONS = {
  neutral:  { label: '平静', eye: 'open',   eyeW: 12, eyeH: 13, tilt: 0,  mouth: 'flat',  brow: 0,  blink: 'normal' },
  happy:    { label: '开心', eye: 'arc',    eyeW: 13, eyeH: 12, tilt: 0,  mouth: 'smile', brow: 0,  blink: 'slow' },
  excited:  { label: '兴奋', eye: 'arc',    eyeW: 14, eyeH: 14, tilt: 0,  mouth: 'open',  brow: 2,  blink: 'fast' },
  curious:  { label: '好奇', eye: 'open',   eyeW: 12, eyeH: 15, tilt: 6,  mouth: 'tiny',  brow: 1,  blink: 'slow' },
  thinking: { label: '思考', eye: 'half',   eyeW: 12, eyeH: 7,  tilt: -4, mouth: 'flat',  brow: 1,  blink: 'none' },
  listening:{ label: '聆听', eye: 'open',   eyeW: 13, eyeH: 16, tilt: 0,  mouth: 'tiny',  brow: 2,  blink: 'none' },
  speaking: { label: '说话', eye: 'open',   eyeW: 12, eyeH: 13, tilt: 0,  mouth: 'talk',  brow: 0,  blink: 'slow' },
  sleepy:   { label: '困',   eye: 'closed', eyeW: 12, eyeH: 2,  tilt: 0,  mouth: 'tiny',  brow: -2, blink: 'none' },
  sad:      { label: '难过', eye: 'half',   eyeW: 12, eyeH: 9,  tilt: -8, mouth: 'frown', brow: -2, blink: 'slow' },
  confused: { label: '困惑', eye: 'open',   eyeW: 11, eyeH: 12, tilt: 0,  mouth: 'wave',  brow: 1,  blink: 'normal' },
}

export const EMOTION_KEYS = Object.keys(EMOTIONS)

/** 模型可能瞎填，统一收敛到这里；认不出来就是 neutral */
export function cleanEmotion(name, fallback = 'neutral') {
  const k = String(name || '').trim().toLowerCase()
  return EMOTIONS[k] ? k : fallback
}

export function cleanIntensity(v, fallback = 0.7) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.2, Math.min(1, n))
}

/**
 * 心情：一个会自己慢慢淡掉的表情状态。
 *
 * 规则很简单，够用就好：
 *   - 被设定之后，过 decayMinutes 分钟自己回到平静
 *   - 深夜（默认 23:00-06:00）自动变困，除非关掉
 *   - 思考 / 聆听 / 说话 是「临时表情」，不覆盖心情，只在当下盖住它
 */
export function createMood(getConfig) {
  let mood = { emotion: 'neutral', intensity: 0.6, since: Date.now(), reason: '刚醒来' }

  function enabled() {
    return Boolean(getConfig().mood?.enabled)
  }

  function set(emotion, opts = {}) {
    if (!enabled()) return mood
    mood = {
      emotion: cleanEmotion(emotion),
      intensity: cleanIntensity(opts.intensity),
      since: Date.now(),
      reason: String(opts.reason || '').slice(0, 120),
    }
    return mood
  }

  /** 每次读状态时调一下：过期的情绪自己淡掉，深夜自己变困 */
  function tick() {
    const cfg = getConfig()
    if (!cfg.mood?.enabled) {
      if (mood.emotion !== 'neutral') mood = { emotion: 'neutral', intensity: 0.5, since: Date.now(), reason: '关闭了心情' }
      return mood
    }
    const decay = Number(cfg.mood?.decayMinutes)
    if (Number.isFinite(decay) && decay > 0 && mood.emotion !== 'neutral') {
      if (Date.now() - mood.since > decay * 60000) {
        mood = { emotion: 'neutral', intensity: 0.5, since: Date.now(), reason: '过一会儿自己平静了' }
      }
    }
    if (cfg.mood?.nightSleepy) {
      const h = new Date().getHours()
      const night = h >= 23 || h < 6
      if (night && mood.emotion !== 'sleepy' && Date.now() - mood.since > 30 * 60000) {
        mood = { emotion: 'sleepy', intensity: 0.6, since: Date.now(), reason: '这个点了，有点困' }
      }
    }
    return mood
  }

  return {
    get: () => tick(),
    set,
    enabled,
    /** 给设备 / 面板看的一份快照 */
    snapshot(activity = 'idle') {
      const m = tick()
      return {
        emotion: m.emotion,
        intensity: m.intensity,
        since: m.since,
        reason: m.reason,
        enabled: enabled(),
        activity,
      }
    },
  }
}
