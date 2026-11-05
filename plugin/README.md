# dsh-esp32-robot

给 ESP32 语音小车当大脑的 DeepSeek Harness 插件。

## 它做什么

- **网关**：`/robot/api/turn` 收 16k PCM、回「一行 JSON 头 + PCM 流」
- **耳朵**：PCM → 文字（DSH 内置识别，或 OpenAI 兼容接口）
- **大脑**：送进一个专用 DSH 会话（preset `esp32-robot`），人格可配
- **嘴巴**：文字 → 16k PCM（Windows 系统语音，或自建 TTS）
- **手脚**：只挂 `robot_move / robot_led / robot_pose / robot_look / robot_status` 五个工具，
  按面板权限裁剪，参数带硬上限
- **面板**：设置 → 机器人。人格、模型、嗓音、权限、设备口令都在这里改
- **模拟器**：`/robot/sim`，用电脑麦克风和喇叭把整条链路跑一遍

## 安装

```js
// 已经在 DSH 里装好了。重新装：
plugin_manager({ action: 'install_bundle', target: '<这个目录的绝对路径>' })
```

装完**需要重启 DSH** 才会加载。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半边：路由、会话、工具、语音编排 |
| `client.js` | 网页半边：设置页 |
| `lib/config.js` | 默认配置 + 默认人格，落在 `~/.dsh/plugins-data/esp32-robot/config.json` |
| `lib/tts.js` | SAPI / 自建 TTS → 16k 单声道 PCM；WAV 解析与重采样 |
| `cordis.patch.yml` | 挂载插件本体 + 机器人专用的 agent preset |

## 数据

```
~/.dsh/plugins-data/esp32-robot/
├─ config.json          配置（含人格、口令）
├─ workspace/           机器人会话的工作区
├─ frames/latest.jpg    设备上传的最后一帧
└─ tmp/                 语音合成的临时 wav（一小时自动清）
```

## 注意

- 机器人会话的 preset 里**没有任何文件/命令/网络工具**，只有动作工具
- 设备接口要 token；面板接口不校验（同源，靠 DSH 自己的登录态）
- TTS 只接受 wav / 裸 pcm16，**不支持 MP3**（设备端不解码）
