# 在 Windows 上安装

## 0. 你需要

- Windows 10 / 11
- 可用的 **DeepSeek Harness 桌面版**（已经能正常打开、能对话）
- 一个放插件的地方（建议 `%USERPROFILE%\dsh-plugins\doom_robot_mark_1`，**别放临时目录**）

> 为什么单开一个 `dsh-plugins`：DSH 装插件是**按路径链接**的，源目录一旦改名或删掉，
> 插件下次启动就失效。所以它得放在一个**你自己的、不会被别的软件清理**的地方——
> 别放进 `C:\Aurabot` 这类应用目录，也别放进 `.dsh`（那是 DSH 自己的数据目录）。

## 1. 放好文件

把仓库里的 `plugin/` 整个目录复制到你选的位置。复制完这个目录里应该有：

```
plugin\
  package.json
  cordis.patch.yml
  index.js
  client.js
  lib\ (config.js face.js tts.js sim.js)
  locale\ icon.svg
```

> 注意：DSH 安装的是**这个 `plugin` 目录**，不是它的上一层。

## 2. 安装

1. 打开 DSH → 左侧栏 **插件**
2. **从本地目录安装**（或叫「安装本地插件」）→ 选到刚才那个 `plugin` 目录
3. 安装完成会提示需要重启 → **重启 DSH**

> 如果提示 `ERR_PNPM_UNEXPECTED_STORE`，说明你的 DSH 配置过自定义 pnpm store：
> 在 `%USERPROFILE%\.dsh\profiles\<你的profile>\pnpm-workspace.yaml` 里加一行
> `storeDir: <原来的 store 路径>`，再重试。

## 3. 第一次打开

重启后，左侧栏会出现 **「机器人」**（排在 Aurabot / 记忆系统之间）。点进去：

1. 点 **试一句** → 应该听到它说话
2. 说不了话？看面板红字，多数是**中文语音包没装**：
   设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 语音包
3. 点 **打开模拟器** → 对着电脑麦克风说话，能听到回答就说明听觉也通了

## 4. 语音（Windows）

默认用 **SAPI**（系统自带，离线免费）。中文音色一般叫 `Microsoft Huihui Desktop`，
面板「嗓音」里点刷新能看到本机所有音色。

需要更好听的音色，把「引擎」改成**自建 TTS**，填一个支持 `{text}` 占位、返回 wav 或裸 pcm16 的地址
（不支持 MP3）。

## 5. 记忆（可选，但推荐）

热记忆开箱即用（记「主人喜欢蓝色」这种小事，每轮自动带上）。
想要**可检索的结构化记忆**，需要装 Mnemon 的官方 CLI：

```powershell
pnpm add -g @mnemon-dev/mnemon
# 或 npm install -g @mnemon-dev/mnemon
```

装完确认：

```powershell
mnemon --version
```

> 如果命令找不到：把 npm 的全局 bin 目录（通常 `%LOCALAPPDATA%\pnpm\bin` 或 `%APPDATA%\npm`）
> 加进 PATH，然后**重启 DSH**——宿主进程的环境变量是启动时继承的。

然后在 DSH 的「记忆系统」页面确认 Provider 就绪，再对机器人说一句
「建一个记忆空间叫小豆的记忆」，它自己会建好。

## 6. 接硬件

固件还没写（故意不给未验证的 C++）。协议、引脚、I2S 参数都在
[`03-固件与硬件.md`](03-固件与硬件.md)。

调试顺序：先 `GET /robot/api/ping` 通 → 再录音上传 → 再放音 → 最后画脸。

## 常见问题

| 现象 | 原因 |
|---|---|
| 左侧栏没有「机器人」 | 插件没加载。重启 DSH；看日志里有没有 `[esp32-robot]` |
| 点「试一句」报错 | 把红字完整看完。常见：模型没配 / 会话创建失败 |
| 换表情没反应 | 看「最近一轮」里的 `actions`；空的说明工具没挂上 → 点「重新开始一个新会话」 |
| 它说「查不到」 | 这台 DSH 没配搜索密钥。面板「检查联网」能确认 |
