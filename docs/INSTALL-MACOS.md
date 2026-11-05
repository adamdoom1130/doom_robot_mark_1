# 在 macOS 上安装

## 0. 你需要

- macOS 12 及以上（Apple Silicon 或 Intel 都行）
- 可用的 **DeepSeek Harness 桌面版**
- 一个放插件的地方（建议 `~/Aurabot/plugins/doom_robot_mark_1`，**别放临时目录**）

## 1. 放好文件

把仓库里的 `plugin/` 整个目录复制到你选的位置：

```bash
mkdir -p ~/Aurabot/plugins
cp -R doom_robot_mark_1/plugin ~/Aurabot/plugins/
```

复制完这个目录里应该有 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`lib/`。
DSH 安装的是**这个 `plugin` 目录**，不是它的上一层。

## 2. 安装

1. 打开 DSH → 左侧栏 **插件**
2. **从本地目录安装** → 选到 `~/Aurabot/plugins/plugin`
3. 安装完成会提示需要重启 → **重启 DSH**

## 3. 第一次打开

左侧栏会出现 **「机器人」**。点进去：

1. 点 **试一句** → 听到它说话
2. 没声音？面板红字里看是不是「这个系统没有自带语音」——macOS 一定有 `say`，
   多半是**中文音色没装**：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音 → 下载中文（Tingting / 婷婷）
3. 点 **打开模拟器** → 对着麦克风说话
   > 第一次会弹「DSH 想访问麦克风」，必须允许；
   > 否则去 系统设置 → 隐私与安全性 → 麦克风 里手动打开

## 4. 语音（macOS）

默认走系统 **`say`**，比 Windows 的音色自然得多。

- 面板「嗓音」里的音色列表来自 `say -v ?`
- 推荐 `Tingting`（zh-CN）
- 语速在面板里拖，内部会换算成 `say -r` 的每分钟字数

需要更特别的音色，把引擎改成**自建 TTS**，填一个带 `{text}` 占位、返回 wav 或裸 pcm16 的地址
（不支持 MP3）。

## 5. 记忆（可选，但推荐）

热记忆开箱即用。想要结构化记忆需要装 Mnemon 官方 CLI：

```bash
npm install -g @mnemon-dev/mnemon
# 如果用 pnpm：pnpm add -g @mnemon-dev/mnemon
```

Apple Silicon 会自动装 `@mnemon-dev/mnemon-darwin-arm64`，Intel 装 `darwin-x64`。
装完确认：

```bash
mnemon --version
```

> 装完**重启 DSH**，宿主才能在自己的 PATH 里找到它。

然后对机器人说「建一个记忆空间叫小豆的记忆」，它自己会建好。

## 6. 接硬件

固件还没写。协议与硬件参数在 [`03-固件与硬件.md`](03-固件与硬件.md)。

macOS 上做 ESP32 开发：`brew install platformio`，或用 VS Code + PlatformIO 插件。

## 与 Windows 版的差异

代码是同一份，只有两处平台差异（插件内部自动处理）：

| | Windows | macOS |
|---|---|---|
| 系统语音 | PowerShell + SAPI | `say -o out.wav --data-format=LEI16@16000` |
| 音色列表 | `GetInstalledVoices()` | `say -v ?` |

除此之外行为完全一致。

## 常见问题

| 现象 | 原因 |
|---|---|
| 左侧栏没有「机器人」 | 插件没加载。重启 DSH；看日志有没有 `[esp32-robot]` |
| 模拟器录不到声音 | 麦克风权限没给 DSH（系统设置 → 隐私与安全性 → 麦克风） |
| 它不说话 | 面板红字；多半是音色没下载 |
| 换表情没反应 | 看「最近一轮」里的 `actions`；空的就点「重新开始一个新会话」 |
