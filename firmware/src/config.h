// 接线与网络配置。改这里就够了，别的文件不用动。
#pragma once

// ---------------- WiFi ----------------
#define WIFI_SSID "你的WiFi名"
#define WIFI_PASS "你的WiFi密码"

// ---------------- 电脑上的 DSH ----------------
// 面板「设备接入」里显示的那个地址，只填 IP，不要 http://
#define SERVER_HOST "192.168.1.100"
#define SERVER_PORT 55383
// 面板里的「口令」，rt_ 开头
#define DEVICE_TOKEN "rt_xxxxxxxxxxxxxxxx"
#define DEVICE_ID "robot-1"

// ---------------- I2S 麦克风（INMP441）----------------
// VDD=3.3V  GND=GND  L/R=GND（左声道）
#define MIC_BCLK 41
#define MIC_WS 42
#define MIC_SD 40

// ---------------- I2S 功放（MAX98357A）----------------
// VIN=5V  GND=GND  SD=GND（左声道，不静音）  GAIN 悬空
#define SPK_BCLK 14
#define SPK_LRC 21
#define SPK_DIN 47

// ---------------- OLED 0.36" SSD1306 72x40 ----------------
#define OLED_SDA 1
#define OLED_SCL 2
#define OLED_ADDR 0x3C

// ---------------- 按钮与电池 ----------------
// 板载 BOOT 键（按下为低）：按住说话
#define BTN_PIN 0
// 电池分压（220k/100k）接 3.3V 上限以内
#define BAT_PIN 48
#define BAT_DIVIDER 3.2f // (220+100)/100

// ---------------- 音频参数 ----------------
#define SAMPLE_RATE 16000
#define RECORD_MAX_MS 8000     // 最长录这么久，防止忘了松手
#define RECORD_MIN_MS 400      // 太短就当误触
#define VAD_SILENCE_MS 800     // 静音多久算说完
#define VAD_RMS_ON 1200        // 开始录音的阈值，噪声大的房间调高
#define VAD_RMS_OFF 700        // 结束录音的阈值
#define USE_VAD 0              // 1 = 一直开着自动检测；0 = 按住 BOOT 说话

// ---------------- 表情 ----------------
#define BLINK_MIN_MS 3000
#define BLINK_MAX_MS 6000
#define BLINK_MS 110
