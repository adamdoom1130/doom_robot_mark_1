# 固件

> ⚠️ **这份固件没有在真实硬件上跑过**（板子还在路上）。它的每一段都是按 ESP-IDF / Arduino core 3.x
> 的官方 API 写的，但引脚、时序、增益这些必须上板调。**先按下面的「上板顺序」一步步验，不要一次全接上。**

## 它做什么

```
按住 BOOT ─► 录 16k 单声道 ─► POST /robot/api/turn
                              ─► 读到一行 JSON 头（说了什么、要做什么表情）
                              ─► 后面的字节全是 16k PCM，边收边灌 I2S
```

没有 AI、没有决策、没有网络协议栈之外的逻辑——思考全在电脑上的 DSH 里。

## 接线

| 器件 | 引脚 | 备注 |
|---|---|---|
| INMP441 `SCK` | GPIO41 | I2S0 位时钟 |
| INMP441 `WS` | GPIO42 | I2S0 左右时钟 |
| INMP441 `SD` | GPIO40 | I2S0 数据输入 |
| INMP441 `L/R` | GND | 左声道 |
| MAX98357A `BCLK` | GPIO14 | I2S1 位时钟 |
| MAX98357A `LRC` | GPIO21 | I2S1 左右时钟 |
| MAX98357A `DIN` | GPIO47 | I2S1 数据输出 |
| MAX98357A `SD` | GND | 左声道 + 不静音 |
| OLED `SDA` | GPIO1 | I2C |
| OLED `SCL` | GPIO2 | I2C |
| 电池分压 | GPIO48 | 220k / 100k |
| 说话按钮 | GPIO0 | 板载 BOOT，按下为低 |

> 摄像头这版**没有接**（引脚留给以后）。要加的时候注意 N16R8 的 GPIO33~37 被 PSRAM 占了。

## 编译与烧录

```bash
cd firmware
pio run -t upload        # 第一次会自动装依赖
pio device monitor       # 看串口日志
```

改三个地方：

1. `src/config.h` 里的 `WIFI_SSID` / `WIFI_PASS`
2. `src/config.h` 里的 `SERVER_HOST` / `SERVER_PORT`（DSH 面板「设备接入」里那个地址）
3. `src/config.h` 里的 `DEVICE_TOKEN`（面板里的 `rt_…`）

## 上板顺序（别跳）

| # | 测什么 | 怎么算过 |
|---|---|---|
| 1 | 串口 + WiFi | 串口打印 IP |
| 2 | **只接麦克风** | 串口打印 `[rec] N 样本`，N 大约是 秒数×16000 |
| 3 | 录音内容 | 把 `recBuf` 发到电脑存 wav，能听清自己说话 |
| 4 | **只接功放** | 先放一段正弦波（自己写个 200 行的小测试），喇叭干净无爆音 |
| 5 | 整条链路 | 按住 BOOT 说「你好」，2~5 秒内听到回答，屏幕同步变表情 |
| 6 | 空闲表情 | 不按按钮时每 20 秒 ping 一次，屏幕跟着心情变 |

## 要调的几个数

| 现象 | 改哪 |
|---|---|
| 录到的声音太小 / 全是沙沙 | `main.cpp` 里 `micRaw[i] >> 16` 改成 `>> 14`（增益翻 4 倍） |
| 说话不触发 / 老是误触发 | `config.h` 的 `VAD_RMS_ON`、`VAD_RMS_OFF`（先串口打印 rms 看实际值） |
| 回答被截断 | `main.cpp` 里 `stream->setTimeout(10)` 调大 |
| 声音一出来就爆音 | 播放前先写 2~3 块静音（`playPcm` 开头补一段 0） |
| 屏幕太亮/太暗 | `face.cpp` 里 `setContrast(180)` |

## 已知限制

- **没有摄像头**：`robot_look` 会一直说「看不见」，这是预期的
- **没有唤醒词**：现在要么按住 BOOT（默认），要么 `USE_VAD 1` 一直听
- **没有本地唤醒兜底**：断网时它只会显示难过，不会说话
- **单轮阻塞**：录音→上传→播放是串行的，播放期间按按钮没反应
- **不支持打断**：要打断得等这一句放完（想做真双工得上 WebSocket）

## 协议

服务器返回的东西长这样（`connection: close`，**故意关掉了 chunked 编码**）：

```
{"ok":true,"reply":"你好呀","actions":[{"type":"face","emotion":"happy"}],
 "face":{...},"heard":"你好","rate":16000,"format":"s16le","stream":true}
<PCM 原始字节……一直到连接关闭>
```

读到第一个 `\n` 之前是 JSON，之后全是 16k / 16bit / 单声道小端 PCM。
`body / 32000` 就是秒数。

完整字段见 [`../docs/02-架构与协议.md`](../docs/02-架构与协议.md)。
