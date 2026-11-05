// ESP32 小机器人 —— 网页半边（DSH 设置 → 机器人）
//
// 面板只做一件事：把 ~/.dsh/plugins-data/esp32-robot/config.json 里的东西变成能点的控件。
// 所有数据都走插件自己的 HTTP 接口（/robot/api/*），和网页同源，不需要额外的 RPC 管道。

window.__ModuleLoader__.load({
  id: 'dsh-esp32-robot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const CSS = `
.rb-wrap{display:flex;flex-direction:column;gap:14px;color:inherit;font-size:14px;line-height:1.6;padding:2px 0 24px}
.rb-card{border:1px solid rgba(128,128,128,.28);border-radius:12px;padding:14px 16px;background:rgba(127,127,127,.04)}
.rb-h{font-weight:600;font-size:13px;letter-spacing:.02em;margin:0 0 2px;display:flex;align-items:center;gap:8px}
.rb-sub{opacity:.62;font-size:12px;margin:0 0 10px}
.rb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
.rb-row>label{min-width:88px;opacity:.75;font-size:13px}
.rb-in{font:inherit;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(128,128,128,.32);border-radius:8px;padding:6px 9px;min-width:120px;outline:none}
.rb-in:focus{border-color:rgba(90,150,255,.75)}
.rb-in.grow{flex:1;min-width:220px}
textarea.rb-in{width:100%;box-sizing:border-box;min-height:190px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.55}
select.rb-in{min-width:170px}
.rb-btn{font:inherit;font-size:13px;padding:6px 13px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:rgba(127,127,127,.10);color:inherit;cursor:pointer}
.rb-btn:hover{background:rgba(127,127,127,.20)}
.rb-btn.primary{background:rgba(64,120,255,.16);border-color:rgba(90,150,255,.6)}
.rb-btn:disabled{opacity:.45;cursor:default}
.rb-chip{font-size:11.5px;padding:2px 8px;border-radius:99px;border:1px solid rgba(128,128,128,.35);opacity:.8}
.rb-chip.on{border-color:rgba(60,190,120,.6);color:rgba(60,190,120,1)}
.rb-chip.off{border-color:rgba(220,90,90,.55);color:rgba(220,110,110,1)}
.rb-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.8;word-break:break-all}
.rb-ok{color:rgba(50,180,110,1);font-size:12.5px}
.rb-err{color:rgba(225,90,90,1);font-size:12.5px;white-space:pre-wrap}
.rb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.rb-face{image-rendering:pixelated;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:#000;display:block}
.rb-face-row{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-top:10px}
.rb-emos{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:240px}
.rb-emo{font:inherit;font-size:12px;padding:5px 10px;border-radius:99px;border:1px solid rgba(128,128,128,.35);background:rgba(127,127,127,.08);color:inherit;cursor:pointer}
.rb-emo:hover{background:rgba(127,127,127,.2)}
.rb-emo.on{border-color:rgba(90,150,255,.7);background:rgba(64,120,255,.18)}
.rb-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box}
.rb-head{flex:0 0 auto;padding:22px 28px 0}
.rb-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px 28px 48px;box-sizing:border-box}
.rb-inner{max-width:900px;margin:0 auto}
.rb-bar{position:sticky;top:0;z-index:6;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  padding:10px 12px;border:1px solid rgba(128,128,128,.3);border-radius:12px;
  background:Canvas;box-shadow:0 6px 16px rgba(0,0,0,.16)}
.rb-dirty{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid rgba(230,170,60,.65);color:rgba(230,170,60,1)}
.rb-eb{border:1px solid rgba(220,90,90,.6);border-radius:12px;padding:16px 18px;margin:16px 0}
.rb-eb pre{white-space:pre-wrap;font-size:12px;opacity:.8;max-height:260px;overflow:auto}
`

    function chip(text, ok) {
      return h('span', { className: 'rb-chip ' + (ok ? 'on' : 'off') }, text)
    }

    function Card({ title, sub, right, children }) {
      return h('div', { className: 'rb-card' },
        h('div', { className: 'rb-row', style: { margin: 0, justifyContent: 'space-between' } },
          h('div', null,
            h('div', { className: 'rb-h' }, title),
            sub ? h('p', { className: 'rb-sub' }, sub) : null),
          right || null),
        children)
    }

    function Field({ label, children }) {
      return h('div', { className: 'rb-row' }, h('label', null, label), children)
    }

    /** 把 lib/face.js 的那张表情表画出来——面板预览和固件用的是同一组数字 */
    function drawFace(g, f, s) {
      const W = 72
      const H = 40
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.fillStyle = '#000'
      g.fillRect(0, 0, W * s, H * s)
      g.scale(s, s)
      g.fillStyle = '#e8f0ff'
      g.strokeStyle = '#e8f0ff'
      g.lineCap = 'round'
      g.lineJoin = 'round'
      const eyeY = 16
      const mouthY = 30
      const eye = (cx, mirror) => {
        const tilt = ((f.tilt || 0) * (mirror ? -1 : 1) * Math.PI) / 180
        g.save()
        g.translate(cx, eyeY)
        g.rotate(tilt)
        const w = f.eyeW || 12
        const h = f.eyeH || 13
        if (f.eye === 'closed') {
          g.lineWidth = 2.4
          g.beginPath()
          g.moveTo(-w / 2, 0)
          g.lineTo(w / 2, 0)
          g.stroke()
        } else if (f.eye === 'arc') {
          g.lineWidth = 2.8
          g.beginPath()
          g.moveTo(-w / 2, h * 0.18)
          g.quadraticCurveTo(0, -h * 0.62, w / 2, h * 0.18)
          g.stroke()
        } else if (f.eye === 'half') {
          g.lineWidth = 2.2
          g.beginPath()
          g.moveTo(-w / 2, -h * 0.1)
          g.quadraticCurveTo(0, -h * 1.15, w / 2, -h * 0.1)
          g.stroke()
        } else {
          const r = Math.min(w, h) / 2
          g.beginPath()
          if (typeof g.roundRect === 'function') g.roundRect(-w / 2, -h / 2, w, h, r)
          else g.rect(-w / 2, -h / 2, w, h)
          g.fill()
          g.fillStyle = '#000'
          g.beginPath()
          g.arc(0, h * 0.06, Math.max(1.8, h * 0.3), 0, Math.PI * 2)
          g.fill()
          g.fillStyle = '#e8f0ff'
        }
        g.restore()
      }
      eye(24, false)
      eye(48, true)

      g.lineWidth = 2.2
      const mx = 36
      const mw = 12
      const m = f.mouth || 'flat'
      g.beginPath()
      if (m === 'smile') {
        g.moveTo(mx - mw / 2, mouthY - 1)
        g.quadraticCurveTo(mx, mouthY + 4.5, mx + mw / 2, mouthY - 1)
        g.stroke()
      } else if (m === 'frown') {
        g.moveTo(mx - mw / 2, mouthY + 2)
        g.quadraticCurveTo(mx, mouthY - 3.5, mx + mw / 2, mouthY + 2)
        g.stroke()
      } else if (m === 'tiny') {
        g.arc(mx, mouthY, 2, 0, Math.PI * 2)
        g.fill()
      } else if (m === 'open') {
        g.ellipse(mx, mouthY, 5, 4, 0, 0, Math.PI * 2)
        g.fill()
      } else if (m === 'talk') {
        g.ellipse(mx, mouthY, 4, 3, 0, 0, Math.PI * 2)
        g.fill()
      } else if (m === 'wave') {
        g.moveTo(mx - 6, mouthY)
        g.quadraticCurveTo(mx - 3, mouthY - 3, mx, mouthY)
        g.quadraticCurveTo(mx + 3, mouthY + 3, mx + 6, mouthY)
        g.stroke()
      } else {
        g.moveTo(mx - 5, mouthY)
        g.lineTo(mx + 5, mouthY)
        g.stroke()
      }
      g.restore()
    }

    function FacePreview({ face, scale }) {
      const ref = useRef(null)
      const key = face ? JSON.stringify(face) : ''
      useEffect(() => {
        const cv = ref.current
        if (!cv || !face) return
        const g = cv.getContext('2d')
        if (g) drawFace(g, face, scale)
      }, [key, scale])
      return h('canvas', {
        ref,
        className: 'rb-face',
        width: 72 * scale,
        height: 40 * scale,
        'aria-label': '屏幕预览',
      })
    }

    // 共用一个 AudioContext：每次 new 一个会撞上浏览器的自动播放策略（新建的上下文是 suspended，
    // 没被 resume 就一点声音都没有），而且频繁开关容易出杂音。
    let sharedAudio = null
    function ensureAudio() {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) throw new Error('这个浏览器没有 Web Audio')
      if (!sharedAudio || sharedAudio.state === 'closed') sharedAudio = new Ctor()
      if (sharedAudio.state === 'suspended') sharedAudio.resume().catch(() => {})
      return sharedAudio
    }

    /** 出错了也不能白屏：把错误画出来，别的页面不受影响 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (!this.state.error) return this.props.children
        const e = this.state.error
        return h('div', { className: 'rb-eb' },
          h('div', { className: 'rb-h' }, '机器人页面出错了'),
          h('p', { className: 'rb-sub' }, '把下面这段发给作者就行；配置本身没坏，机器人照常能用。'),
          h('pre', null, String(e && (e.stack || e.message || e))))
      }
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [voices, setVoices] = useState([])
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [reply, setReply] = useState(null)
      const [sayText, setSayText] = useState('')
      const audioRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const r = await fetch('/robot/api/state', { cache: 'no-store' })
          const j = await r.json()
          if (!j.ok) throw new Error(j.message || '读取失败')
          setState(j)
          setDraft(j.config)
          setMsg(null)
        } catch (error) {
          setMsg({ type: 'err', text: '连不上机器人插件：' + error.message + '（DSH 重启过？刷新一下页面）' })
        }
      }, [])

      useEffect(() => { load() }, [load])

      /** 只刷新运行状态（最近一轮、在线设备），不动用户正在改的草稿 */
      const refreshRuntime = useCallback(async () => {
        try {
          const r = await fetch('/robot/api/state', { cache: 'no-store' })
          const j = await r.json()
          if (j.ok) setState((s) => (s ? { ...s, runtime: j.runtime } : j))
        } catch (error) {}
      }, [])

      const loadVoices = useCallback(async () => {
        try {
          const r = await fetch('/robot/api/voices', { cache: 'no-store' })
          const j = await r.json()
          setVoices(j.voices || [])
          if (!j.voices || !j.voices.length) {
            setMsg({ type: 'err', text: '没找到可用的系统语音（这台机器可能没装中文语音包）' })
          }
        } catch (error) {
          setMsg({ type: 'err', text: '读音色列表失败：' + error.message })
        }
      }, [])

      useEffect(() => {
        if (!draft?.voice?.provider || draft.voice.provider === 'windows' || draft.voice.provider === 'system') loadVoices()
      }, [draft?.voice?.provider, loadVoices])

      if (!state || !draft) {
        return h('div', { className: 'rb-wrap' },
          h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
          h('div', { className: 'rb-sub' }, msg ? msg.text : '读取中…'))
      }

      const set = (path, value) => {
        setDraft((d) => {
          const next = JSON.parse(JSON.stringify(d))
          let cur = next
          const keys = path.split('.')
          for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]]
          cur[keys[keys.length - 1]] = value
          return next
        })
      }
      const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), draft)

      async function save(patch, label) {
        setBusy(label)
        setMsg(null)
        try {
          const r = await fetch('/robot/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || draft),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.message || '保存失败')
          setState((s) => ({ ...s, config: j.config }))
          setDraft(j.config)
          setMsg({ type: 'ok', text: '已保存，下一句话就生效' })
        } catch (error) {
          setMsg({ type: 'err', text: '保存失败：' + error.message })
        } finally {
          setBusy('')
        }
      }

      async function say(text) {
        const clean = String(text || '').trim()
        if (!clean) return
        setBusy('say')
        setMsg(null)
        setReply(null)
        try {
          try { ensureAudio() } catch (e) {}
          const r = await fetch('/robot/api/turn?fmt=json', {
            method: 'POST',
            headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robot-token': state.config.device.token },
            body: clean,
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.message || '没成功')
          setReply(j)
          if (j.audio) playB64(j.audio, j.rate || 16000)
          else if (j.ttsError) setMsg({ type: 'err', text: '它回话了，但没合成出声音：' + j.ttsError })
          refreshRuntime()
        } catch (error) {
          setMsg({ type: 'err', text: '说这句话失败：' + error.message })
        } finally {
          setBusy('')
        }
      }

      function tryTurn() {
        return say('你好呀，介绍一下你自己')
      }

      /** 面板上点一下表情，立刻生效（不走草稿，直接改服务端心情） */
      async function setEmotion(emotion) {
        try {
          const r = await fetch('/robot/api/face', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ emotion }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.message || '没成功')
          refreshRuntime()
        } catch (error) {
          setMsg({ type: 'err', text: '换表情失败：' + error.message })
        }
      }

      /** 试一下联网搜索到底能不能用（很多环境里 DSH 还没配搜索密钥） */
      async function checkSearch() {
        setBusy('search')
        try {
          const r = await fetch('/robot/api/search?q=' + encodeURIComponent('上海天气'), { cache: 'no-store' })
          const j = await r.json()
          if (j.available) {
            setMsg({ type: 'ok', text: `联网搜索可用，拿到 ${j.count || 0} 条结果` })
          } else {
            setMsg({ type: 'err', text: '联网搜索不可用：' + (j.message || '未知原因') })
          }
        } catch (error) {
          setMsg({ type: 'err', text: '检查失败：' + error.message })
        } finally {
          setBusy('')
        }
      }

      function playB64(b64, rate) {
        try {
          const bin = atob(b64)
          const u8 = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
          const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2))
          const f32 = new Float32Array(i16.length)
          for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
          const ac = ensureAudio()
          const buf = ac.createBuffer(1, f32.length, rate || 16000)
          buf.copyToChannel(f32, 0)
          const src = ac.createBufferSource()
          src.buffer = buf
          src.connect(ac.destination)
          src.start()
        } catch (error) {
          setMsg({ type: 'err', text: '播放失败：' + error.message })
        }
      }

      const voice = draft.voice || {}
      const asr = draft.asr || {}
      const perm = draft.permissions || {}
      const moodCfg = draft.mood || {}
      const faces = state.runtime?.faces || []
      const currentEmotion = state.runtime?.mood?.emotion || 'neutral'
      const currentFace = faces.find((f) => f.key === currentEmotion) || faces[0] || null
      const dev = state.runtime?.devices || []
      const online = dev.length > 0 && Date.now() - (dev[0].at || 0) < (draft.device.offlineMs || 120000)
      const dirty = JSON.stringify(draft) !== JSON.stringify(state.config)

      return h('div', { className: 'rb-wrap' },
        h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),

        // ------- 操作栏：粘在顶部，保存按钮不用翻到最底下找 -------
        h('div', { className: 'rb-bar' },
          h('button', {
            className: 'rb-btn primary', disabled: Boolean(busy), onClick: () => save(null, 'save'),
          }, busy === 'save' ? '保存中…' : '保存全部'),
          dirty
            ? h('span', { className: 'rb-dirty' }, '有未保存的修改')
            : h('span', { className: 'rb-sub', style: { margin: 0 } }, '改完保存，下一句话就生效'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'rb-btn', disabled: busy === 'try', onClick: tryTurn }, busy === 'try' ? '思考中…' : '试一句'),
          h('button', { className: 'rb-btn', onClick: () => load() }, '重新读取'),
          h('a', {
            className: 'rb-btn', href: state.runtime?.simUrl || '/robot/sim', target: '_blank', rel: 'noreferrer',
            style: { textDecoration: 'none', display: 'inline-block' },
          }, '模拟器')),

        // ------- 状态 -------
        h(Card, {
          title: h('span', null, '机器人 · ', draft.name || '未命名'),
          sub: '它是 DSH 里的一个专用会话：只有五官（麦克风、喇叭、摄像头）和手脚（移动、灯光、姿态），没有这台电脑的任何权限。',
          right: h('div', { className: 'rb-row', style: { margin: 0 } },
            chip(draft.enabled ? '已开启' : '已关闭', draft.enabled),
            chip(online ? '设备在线' : '设备离线', online)),
        },
          h('div', { className: 'rb-row' },
            h('label', null, '名字'),
            h('input', {
              className: 'rb-in', value: draft.name || '',
              onChange: (e) => set('name', e.target.value),
            }),
            h('label', { style: { minWidth: 0, marginLeft: 8 } }, '总开关'),
            h('input', {
              type: 'checkbox', checked: Boolean(draft.enabled),
              onChange: (e) => set('enabled', e.target.checked),
            })),
          h('div', { className: 'rb-row' },
            h('label', null, '最近一轮'),
            h('span', { className: 'rb-sub', style: { margin: 0 } },
              state.runtime?.lastTurn
                ? `听到「${state.runtime.lastTurn.heard}」→ 说了「${String(state.runtime.lastTurn.reply).slice(0, 40)}…」（${state.runtime.lastTurn.totalMs}ms）`
                : '还没说过话'),
          ),
          h('div', { className: 'rb-row' },
            h('label', null, '会话'),
            h('span', { className: 'rb-mono' }, draft.brain?.sessionId ? draft.brain.sessionId.slice(-12) : '（还没建）'),
            h('button', {
              className: 'rb-btn', disabled: busy === 'reset',
              onClick: () => save({ resetSession: true }, 'reset'),
            }, '重新开始一个新会话'),
            h('a', {
              className: 'rb-btn', href: state.runtime?.simUrl || '/robot/sim', target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', display: 'inline-block' },
            }, '打开模拟器')),
          h('div', { className: 'rb-row' },
            h('label', null, '对它说'),
            h('input', {
              className: 'rb-in grow',
              value: sayText,
              placeholder: '打一句它听得见的话，回车发送（不接麦克风也能聊）',
              onChange: (e) => setSayText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) say(sayText)
              },
            }),
            h('button', {
              className: 'rb-btn primary', disabled: Boolean(busy), onClick: () => say(sayText),
            }, busy === 'say' ? '它正在想…' : '发送'),
            h('button', { className: 'rb-btn', disabled: Boolean(busy), onClick: tryTurn }, '试一句')),
          reply ? h('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(128,128,128,.18)' } },
            h('div', { style: { fontSize: 12, opacity: 0.55, marginBottom: 3 } },
              `听到「${reply.heard || '（没听清）'}」` +
              (reply.ms ? ` · ${reply.ms.asr ? `识别 ${reply.ms.asr}ms · ` : ''}总共 ${reply.ms.total}ms` : '')),
            h('div', { style: { fontSize: 14 } }, reply.reply),
            reply.actions?.length ? h('div', { className: 'rb-mono', style: { marginTop: 6 } }, '动作：' + JSON.stringify(reply.actions)) : null) : null,
          msg ? h('div', { className: msg.type === 'ok' ? 'rb-ok' : 'rb-err' }, msg.text) : null,
        ),

        // ------- 心情与表情 -------
        h(Card, {
          title: '心情与表情',
          sub: '它有一块 0.36 寸的小屏（72×40），上面是一双眼睛和一张嘴。开着心情模块，它会按情绪自己换表情；关掉就固定在平静，模型也拿不到换表情的工具。',
          right: chip(moodCfg.enabled ? '心情开着' : '心情关着', moodCfg.enabled),
        },
          h('div', { className: 'rb-row' },
            h('label', null, '心情模块'),
            h('input', {
              type: 'checkbox', checked: Boolean(moodCfg.enabled),
              onChange: (e) => set('mood.enabled', e.target.checked),
            }),
            h('span', { className: 'rb-sub', style: { margin: 0 } }, '关掉之后表情不跟着情绪走，只有中性的脸')),
          moodCfg.enabled ? h('div', null,
            h('div', { className: 'rb-face-row' },
              h(FacePreview, { face: currentFace, scale: 3 }),
              h('div', { className: 'rb-emos' },
                faces.map((f) => h('button', {
                  key: f.key,
                  className: 'rb-emo' + (f.key === currentEmotion ? ' on' : ''),
                  onClick: () => setEmotion(f.key),
                }, f.label)))),
            h('div', { className: 'rb-sub', style: { margin: '10px 0 0' } },
              `现在：${state.runtime?.mood?.label || '平静'}` +
              (state.runtime?.mood?.reason ? ` · ${state.runtime.mood.reason}` : '') +
              ' · 点上面的表情可以立刻让它做给你看'),
            h('details', { style: { marginTop: 6 } },
              h('summary', { className: 'rb-sub', style: { cursor: 'pointer' } }, '细节：多久回平静、夜里会不会困、允不允许它自己换表情'),
              h('div', { className: 'rb-grid', style: { marginTop: 8 } },
                h(Field, { label: '多久回平静' },
                  h('input', {
                    className: 'rb-in', type: 'number', min: 0, max: 180, step: 1,
                    value: moodCfg.decayMinutes ?? 15,
                    onChange: (e) => set('mood.decayMinutes', Number(e.target.value)),
                  }),
                  h('span', { className: 'rb-sub', style: { margin: 0 } }, '分钟，0 = 不回落')),
                h(Field, { label: '夜里会困' },
                  h('input', {
                    type: 'checkbox', checked: moodCfg.nightSleepy !== false,
                    onChange: (e) => set('mood.nightSleepy', e.target.checked),
                  })),
                h(Field, { label: '自己换表情' },
                  h('input', {
                    type: 'checkbox', checked: moodCfg.autoFace !== false,
                    onChange: (e) => set('mood.autoFace', e.target.checked),
                  }))))) : null,
        ),

        // ------- 长期记忆 -------
        h(Card, {
          title: '长期记忆',
          sub: '用你装好的 Mnemon。开着的时候，它能把「主人喜欢蓝色」这种事记在自己的工作区里，换个新会话也还记得。',
          right: chip(draft.memory?.enabled !== false ? '记忆开着' : '记忆关着', draft.memory?.enabled !== false),
        },
          h('div', { className: 'rb-row' },
            h('label', null, '长期记忆'),
            h('input', {
              type: 'checkbox', checked: draft.memory?.enabled !== false,
              onChange: (e) => set('memory.enabled', e.target.checked),
            }),
            h('span', { className: 'rb-sub', style: { margin: 0 } }, '关掉后它只记得当前这轮对话，问「上次那个」会说记不住')),
          h('div', { className: 'rb-sub', style: { margin: '8px 0 0' } },
            '记忆存在它自己的工作区（plugins-data/esp32-robot/workspace），和你平时会话的记忆分开。它每轮只带 4 个记忆工具（runtime / remember / recall / forget），其余全部屏蔽，省上下文。'),
        ),

        // ------- 人格 -------
        h(Card, {
          title: '人格',
          sub: '这段文字放在系统提示词最前面。写性格和说话方式，别写能力（能力由权限和「身体说明书」每轮自动带上），也别写输出格式——它的话会被读出来。',
          right: h('button', {
            className: 'rb-btn primary', disabled: busy === 'persona',
            onClick: () => save({ persona: draft.persona }, 'persona'),
          }, '保存人格'),
        },
          h('textarea', {
            className: 'rb-in', value: draft.persona || '', spellCheck: false,
            onChange: (e) => set('persona', e.target.value),
          }),
        ),

        // ------- 大脑 -------
        h(Card, {
          title: '大脑',
          sub: '留空就跟 DSH 现在默认的模型一致；填了只影响机器人这个会话，不动你平时的默认模型。',
        },
          h('div', { className: 'rb-grid' },
            h(Field, { label: 'provider' },
              h('input', { className: 'rb-in grow', placeholder: 'deepseek-account', value: draft.model?.provider || '', onChange: (e) => set('model.provider', e.target.value) })),
            h(Field, { label: 'model' },
              h('input', { className: 'rb-in grow', placeholder: 'deepseek-flash', value: draft.model?.model || '', onChange: (e) => set('model.model', e.target.value) })),
            h(Field, { label: '思考强度' },
              h('select', { className: 'rb-in', value: draft.model?.reasoningEffort || '', onChange: (e) => set('model.reasoningEffort', e.target.value) },
                h('option', { value: '' }, '跟模型默认'),
                h('option', { value: 'low' }, 'low'),
                h('option', { value: 'medium' }, 'medium'),
                h('option', { value: 'high' }, 'high'))))),

        // ------- 语音 -------
        h(Card, {
          title: '嗓音',
          sub: '默认用系统自带语音（Windows 用 SAPI，macOS 用 say），离线、免费、第一句出声最快。',
        },
          h(Field, { label: '引擎' },
            h('select', {
              className: 'rb-in',
              value: voice.provider === 'windows' ? 'system' : (voice.provider || 'system'),
              onChange: (e) => set('voice.provider', e.target.value),
            },
              h('option', { value: 'system' }, '系统自带语音（离线，Win/macOS）'),
              h('option', { value: 'http' }, '自建 TTS（填地址）'),
              h('option', { value: 'off' }, '不出声'))),
          (voice.provider === 'system' || voice.provider === 'windows') ? h('div', null,
            h(Field, { label: '音色' },
              h('select', {
                className: 'rb-in grow', value: voice.name || '',
                onChange: (e) => set('voice.name', e.target.value),
              },
                voices.length === 0 ? h('option', { value: voice.name || '' }, voice.name || '（点一下刷新）') : null,
                voices.map((v) => h('option', { key: v.name, value: v.name }, `${v.name} · ${v.culture}`))),
              h('button', { className: 'rb-btn', onClick: loadVoices }, '刷新')),
            h(Field, { label: '语速' },
              h('input', {
                type: 'range', min: -50, max: 50, step: 5, value: Number(voice.rate) || 0,
                onChange: (e) => set('voice.rate', Number(e.target.value)), style: { flex: 1, maxWidth: 260 },
              }),
              h('span', { className: 'rb-mono' }, String(voice.rate || 0)))) : null,
          voice.provider === 'http' ? h('div', null,
            h(Field, { label: '地址' },
              h('input', {
                className: 'rb-in grow', placeholder: 'http://127.0.0.1:9880/tts?text={text}',
                value: voice.http?.urlTemplate || '', onChange: (e) => set('voice.http.urlTemplate', e.target.value),
              })),
            h(Field, { label: '采样率' },
              h('input', {
                className: 'rb-in', type: 'number', value: voice.http?.sampleRate || 24000,
                onChange: (e) => set('voice.http.sampleRate', Number(e.target.value)),
              }),
              h('span', { className: 'rb-sub', style: { margin: 0 } }, '返回 wav 或裸 pcm16 都行（不支持 MP3）'))) : null,
        ),

        // ------- 耳朵 -------
        h(Card, {
          title: '耳朵',
          sub: '真机传上来的 16k PCM 要先变成文字。默认走 DSH 自己的语音识别；也可以填一个 OpenAI 兼容的识别接口。',
        },
          h(Field, { label: '方式' },
            h('select', { className: 'rb-in', value: asr.provider || 'dsh', onChange: (e) => set('asr.provider', e.target.value) },
              h('option', { value: 'dsh' }, 'DSH 内置识别'),
              h('option', { value: 'http' }, 'OpenAI 兼容接口'),
              h('option', { value: 'off' }, '不识别（只收文字）'))),
          asr.provider === 'http' ? h('div', null,
            h(Field, { label: '地址' },
              h('input', {
                className: 'rb-in grow', placeholder: 'https://api.siliconflow.cn/v1/audio/transcriptions',
                value: asr.http?.url || '', onChange: (e) => set('asr.http.url', e.target.value),
              })),
            h(Field, { label: '密钥' },
              h('input', {
                className: 'rb-in grow', type: 'password', placeholder: 'sk-…',
                value: asr.http?.key || '', onChange: (e) => set('asr.http.key', e.target.value),
              })),
            h(Field, { label: '模型' },
              h('input', {
                className: 'rb-in', value: asr.http?.model || 'whisper-1',
                onChange: (e) => set('asr.http.model', e.target.value),
              }))) : null,
          h(Field, { label: '语言' },
            h('input', {
              className: 'rb-in', value: asr.language || 'zh',
              onChange: (e) => set('asr.language', e.target.value),
            })),
        ),

        // ------- 权限 -------
        h(Card, {
          title: '权限（受限指令）',
          sub: '关掉哪一项，模型连那个工具都看不到——不是「说了不做」，是根本调不到。',
        },
          h('div', { className: 'rb-grid' },
            ...[
              ['face', '表情 robot_face', Boolean(moodCfg.enabled)],
              ['search', '联网搜索 robot_search', true],
              ['look', '看画面 robot_look', true],
            ].map(([key, label, usable]) =>
              h('label', { key, className: 'rb-row', style: { margin: 0, gap: 6, opacity: usable ? 1 : 0.45 } },
                h('input', {
                  type: 'checkbox', checked: Boolean(perm[key]), disabled: !usable,
                  onChange: (e) => set('permissions.' + key, e.target.checked),
                }),
                h('span', { style: { fontSize: 13 } }, label)))),
          h('div', { className: 'rb-row' },
            h('label', null, '搜索条数'),
            h('input', {
              className: 'rb-in', type: 'number', min: 1, max: 10, step: 1, value: perm.maxSearchResults ?? 5,
              onChange: (e) => set('permissions.maxSearchResults', Number(e.target.value)),
            }),
            h('span', { className: 'rb-sub', style: { margin: 0 } }, '单次最多带几条结果给模型参考'),
            h('button', {
              className: 'rb-btn', disabled: busy === 'search', onClick: checkSearch,
            }, busy === 'search' ? '检查中…' : '检查联网'),
            moodCfg.enabled ? null : h('span', { className: 'rb-sub', style: { margin: 0 } }, '（表情要先打开上面的心情模块）'))),

        // ------- 设备 -------
        h(Card, {
          title: '设备接入',
          sub: '烧进固件的三样东西：地址、口令、格式。口令等于门钥匙，泄漏了就在这里换一个。',
        },
          h(Field, { label: '对话接口' },
            h('span', { className: 'rb-mono' }, 'POST ' + location.origin + (state.runtime?.turnUrl || '/robot/api/turn'))),
          h(Field, { label: '口令' },
            h('input', {
              className: 'rb-in grow rb-mono', value: draft.device?.token || '',
              onChange: (e) => set('device.token', e.target.value),
            }),
            h('button', {
              className: 'rb-btn',
              onClick: () => {
                const t = 'rt_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
                set('device.token', t)
              },
            }, '换一个')),
          h(Field, { label: '采样率' },
            h('input', {
              className: 'rb-in', type: 'number', value: draft.device?.sampleRate || 16000,
              onChange: (e) => set('device.sampleRate', Number(e.target.value)),
            })),
          dev.length ? h('div', { className: 'rb-row' },
            h('label', null, '在线设备'),
            ...dev.map((d) => h('span', { key: d.id, className: 'rb-chip' }, `${d.id}${d.battery != null ? ' · ' + d.battery + '%' : ''}`))
          ) : null,
          h('div', { className: 'rb-row' },
            h('button', { className: 'rb-btn primary', disabled: Boolean(busy) || busy === 'save', onClick: () => save(null, 'save') }, busy === 'save' ? '保存中…' : '保存全部'),
            h('span', { className: 'rb-sub', style: { margin: 0 } }, '人格那一段有单独的保存按钮')),
      ))
    }

    /** 左侧栏的图标：跟着主题色走，选中时更实一点 */
    function RobotIcon(props) {
      const size = props && props.size ? props.size : 20
      const active = props && props.active
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
        h('rect', { x: 3.2, y: 4.8, width: 17.6, height: 13, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 9.1, cy: 10.4, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 14.9, cy: 10.4, r: 1.5, fill: 'currentColor' }),
        h('rect', { x: 9.1, y: 13.9, width: 5.8, height: 1.5, rx: 0.75, fill: 'currentColor', opacity: 0.7 }),
        h('rect', { x: 11.2, y: 2.4, width: 1.6, height: 2.6, rx: 0.8, fill: 'currentColor' }),
        h('path', { d: 'M2.3 9.6v3.8M21.7 9.6v3.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    /** 设置里的那一份（外壳自己管滚动和背景） */
    function SettingsPanel() {
      return h(PanelBoundary, null, h(Panel, null))
    }

    /** 左侧栏点进来看到的整页（main 槽位）：标题固定，内容自己滚 */
    function RobotPage() {
      return h('div', { className: 'rb-page' },
        h('div', { className: 'rb-head' },
          h('div', { className: 'rb-inner' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } },
              h('span', {
                style: { display: 'inline-flex', width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
              }, h(RobotIcon, { size: 26, active: true })),
              h('h1', { style: { fontSize: 19, fontWeight: 600, margin: 0 } }, 'ESP32 小机器人')),
            h('p', { style: { margin: '0 0 4px', opacity: 0.6, fontSize: 13 } },
              '这台小车的脑子。人格、模型、嗓音、权限都在下面；改完立刻生效。'))),
        h('div', { className: 'rb-scroll' },
          h('div', { className: 'rb-inner' },
            h(PanelBoundary, null, h(Panel, null)))))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        // 左侧栏：一个图标 + 一个整页。id 就是 main 的 key，点图标就切到这一页
        slots.inject('main', () => slots.register({ name: 'main', key: 'esp32-robot' }, RobotPage))
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'esp32-robot',
          order: 25,
          label: () => '机器人',
        }, RobotIcon))
        // 设置里也留一个入口，习惯从设置进的人也能找到
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'esp32-robot',
          order: 46,
          label: () => '机器人',
        }, SettingsPanel))
      },
    }
  },
})
