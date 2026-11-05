// doom_robot_mark_1 固件
//
// 职责只有一个：把「声音进、声音出」这条链路接起来，顺便画脸。
// 思考全在电脑上的 DSH 里，这里不做任何 AI 相关的事。
//
// 流程：
//   按住 BOOT → 录 16k 单声道 → POST /robot/api/turn
//   → 读到一行 JSON 头（里面有它说的话和要做的动作）
//   → 剩下的字节全是 16k PCM，边收边往 I2S 灌
//
// 注意：这份固件**没有在真实硬件上验证过**（板子还没到）。烧之前先单独测
// 麦克风和功放（见 README 的「上板顺序」）。

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>

#include "config.h"
#include "face.h"

// ---------------------------------------------------------------- I2S

static i2s_chan_handle_t s_rx = nullptr; // 麦克风
static i2s_chan_handle_t s_tx = nullptr; // 功放

static void audioBegin() {
  // 麦克风：32bit 槽装 24bit 数据，单声道取左
  i2s_chan_config_t rxcfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  rxcfg.dma_desc_num = 8;
  rxcfg.dma_frame_num = 256;
  ESP_ERROR_CHECK(i2s_new_channel(&rxcfg, nullptr, &s_rx));
  i2s_std_config_t rxstd = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg = {.mclk = I2S_GPIO_UNUSED,
                   .bclk = (gpio_num_t)MIC_BCLK,
                   .ws = (gpio_num_t)MIC_WS,
                   .dout = I2S_GPIO_UNUSED,
                   .din = (gpio_num_t)MIC_SD,
                   .invert_flags = {false, false, false}},
  };
  rxstd.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_rx, &rxstd));
  ESP_ERROR_CHECK(i2s_channel_enable(s_rx));

  // 功放：16bit 单声道，数据同时送左右两个槽（不管 SD 脚接哪边都能响）
  i2s_chan_config_t txcfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  txcfg.dma_desc_num = 8;
  txcfg.dma_frame_num = 256;
  ESP_ERROR_CHECK(i2s_new_channel(&txcfg, &s_tx, nullptr));
  i2s_std_config_t txstd = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg = {.mclk = I2S_GPIO_UNUSED,
                   .bclk = (gpio_num_t)SPK_BCLK,
                   .ws = (gpio_num_t)SPK_LRC,
                   .dout = (gpio_num_t)SPK_DIN,
                   .din = I2S_GPIO_UNUSED,
                   .invert_flags = {false, false, false}},
  };
  txstd.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(s_tx, &txstd));
  ESP_ERROR_CHECK(i2s_channel_enable(s_tx));
}

// ---------------------------------------------------------------- 录音

// PSRAM 里放录音缓冲：8 秒 16k 单声道 = 256KB，放内部 RAM 会挤爆
static int16_t* recBuf = nullptr;
static size_t recCap = 0;

static bool recordAlloc() {
  if (recBuf) return true;
  recCap = (size_t)SAMPLE_RATE * RECORD_MAX_MS / 1000;
  recBuf = (int16_t*)heap_caps_malloc(recCap * sizeof(int16_t), MALLOC_CAP_SPIRAM);
  if (!recBuf) {
    Serial.println(F("[audio] PSRAM 分配失败，检查 board_build.psram_type 是否 opi"));
    return false;
  }
  return true;
}

static int32_t micRaw[256];

/** 读一块并返回 RMS（用于 VAD） */
static int readBlock(int16_t* out, size_t maxSamples, size_t* got) {
  size_t bytes = 0;
  esp_err_t err = i2s_channel_read(s_rx, micRaw, sizeof(micRaw), &bytes, 100);
  if (err != ESP_OK || bytes == 0) {
    *got = 0;
    return 0;
  }
  size_t n = bytes / sizeof(int32_t);
  if (n > maxSamples) n = maxSamples;
  int64_t sum = 0;
  for (size_t i = 0; i < n; i++) {
    // INMP441 是 24bit 左对齐在 32bit 槽里，右移 16 位得到 int16
    int16_t s = (int16_t)(micRaw[i] >> 16);
    out[i] = s;
    sum += (int32_t)s * s;
  }
  *got = n;
  return n ? (int)sqrtf((float)(sum / (int64_t)n)) : 0;
}

/** 录一段；返回样本数（0 表示太短/没说话） */
static size_t recordOnce() {
  if (!recordAlloc()) return 0;
  size_t total = 0;
  uint32_t start = millis();
  uint32_t silenceSince = 0;
  bool speaking = USE_VAD ? false : true;

  faceSetActivity(ACT_LISTEN);

  while (total < recCap) {
    size_t got = 0;
    int rms = readBlock(recBuf + total, recCap - total, &got);
    total += got;
    uint32_t now = millis();

    if (USE_VAD) {
      if (!speaking) {
        // 还没开口：等音量过阈值
        if (rms > VAD_RMS_ON) {
          speaking = true;
          silenceSince = 0;
          total = 0; // 丢掉触发前的静音
        } else {
          total = 0;
        }
      } else if (rms < VAD_RMS_OFF) {
        if (!silenceSince) silenceSince = now;
        else if (now - silenceSince > VAD_SILENCE_MS) break;
      } else {
        silenceSince = 0;
      }
    } else {
      // 按住说话：松手就结束
      if (digitalRead(BTN_PIN) == HIGH && now - start > RECORD_MIN_MS) break;
    }

    if (now - start > RECORD_MAX_MS) break;
    faceTick();
  }

  faceSetActivity(ACT_THINK);
  uint32_t durMs = millis() - start;
  Serial.printf("[rec] %u 样本 / %u ms\n", (unsigned)total, (unsigned)durMs);
  if (total * 1000 / SAMPLE_RATE < RECORD_MIN_MS) return 0;
  return total;
}

// ---------------------------------------------------------------- 联网

static String turnUrl() {
  return String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/robot/api/turn?id=" + DEVICE_ID + "&rate=" + SAMPLE_RATE;
}
static String pingUrl(int battery) {
  return String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/robot/api/ping?id=" + DEVICE_ID +
         "&battery=" + battery + "&fw=1.1.0";
}

static int readBattery() {
  int mv = analogReadMilliVolts(BAT_PIN);
  float v = mv / 1000.0f * BAT_DIVIDER;
  // 单节锂电 3.3~4.2V 映射到 0~100%
  int pct = (int)((v - 3.3f) / (4.2f - 3.3f) * 100.0f);
  return constrain(pct, 0, 100);
}

/** 把 PCM 灌进 I2S；边写边刷脸 */
static void playPcm(const uint8_t* data, size_t len) {
  size_t off = 0;
  size_t written = 0;
  while (off + 1 < len) {
    size_t chunk = len - off;
    if (chunk > 1024) chunk = 1024;
    i2s_channel_write(s_tx, data + off, chunk, &written, 1000);
    off += written ? written : chunk;
    faceTick();
  }
}

/**
 * 一轮对话：把录音发上去，读出「一行 JSON + 裸 PCM」。
 * 服务器那边特意关掉了 chunked 编码，所以读到连接关闭就是一段完整音频。
 */
static bool doTurn(const int16_t* pcm, size_t samples) {
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(30000);
  http.setConnectTimeout(5000);
  if (!http.begin(client, turnUrl())) {
    Serial.println(F("[net] begin 失败"));
    return false;
  }
  http.addHeader("content-type", "application/octet-stream");
  http.addHeader("x-robot-token", DEVICE_TOKEN);

  int code = http.POST((uint8_t*)pcm, samples * sizeof(int16_t));
  if (code != 200) {
    Serial.printf("[net] turn HTTP %d\n", code);
    http.end();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  stream->setTimeout(10);

  // 1) 读到第一个换行：这是 JSON 头
  String line = stream->readStringUntil('\n');
  if (!line.length()) {
    Serial.println(F("[net] 没读到头"));
    http.end();
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, line) != DeserializationError::Ok) {
    Serial.println(F("[net] 头解析失败"));
    http.end();
    return false;
  }
  if (doc["ok"] != true) {
    Serial.printf("[net] 服务器说: %s\n", (const char*)(doc["message"] | "?"));
    http.end();
    return false;
  }

  const char* heard = doc["heard"] | "";
  const char* reply = doc["reply"] | "";
  const char* emotion = doc["face"]["emotion"] | "";
  Serial.printf("[turn] 听到「%s」\n[turn] 回答「%s」\n", heard, reply);

  // 表情先切（屏幕比声音快）
  if (emotion[0]) faceSet(emotion);
  for (JsonObject a : doc["actions"].as<JsonArray>()) {
    const char* type = a["type"] | "";
    if (strcmp(type, "face") == 0) {
      const char* e = a["emotion"] | "";
      if (e[0]) faceSet(e);
    }
  }

  // 2) 剩下的全是 16k 单声道 PCM
  faceSetActivity(ACT_TALK);
  uint8_t buf[1024];
  size_t totalBytes = 0;
  for (;;) {
    size_t n = stream->readBytes(buf, sizeof(buf));
    if (n == 0) break;
    playPcm(buf, n);
    totalBytes += n;
    faceTick();
  }
  faceSetActivity(ACT_IDLE);
  Serial.printf("[turn] 播放了 %u 字节（%.1f 秒）\n", (unsigned)totalBytes, totalBytes / 32000.0f);
  http.end();
  return true;
}

/** 空闲时每 20 秒问一次：同步心情和电量 */
static void doPing() {
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(4000);
  if (!http.begin(client, pingUrl(readBattery()))) return;
  int code = http.GET();
  if (code == 200) {
    JsonDocument doc;
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      const char* emotion = doc["face"]["emotion"] | "";
      if (emotion[0]) faceSet(emotion);
    }
  }
  http.end();
}

// ---------------------------------------------------------------- 主循环

static uint32_t lastPingAt = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println(F("\n=== doom_robot_mark_1 ==="));

  pinMode(BTN_PIN, INPUT_PULLUP);
  analogReadResolution(12);

  faceBegin();
  faceSet("neutral");

  audioBegin();
  recordAlloc();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // 语音要低延迟，别省这点电
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print(F("[wifi] 连接中"));
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(300);
    Serial.print('.');
    faceTick();
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[wifi] IP "));
    Serial.println(WiFi.localIP());
    faceSet("happy");
  } else {
    Serial.println(F("[wifi] 连不上，先离线待着"));
    faceSet("sad");
  }

  lastPingAt = millis();
}

void loop() {
  faceTick();

  // 联网了才做事
  if (WiFi.status() != WL_CONNECTED) {
    static uint32_t lastTry = 0;
    if (millis() - lastTry > 5000) lastTry = millis(), WiFi.reconnect();
    delay(50);
    return;
  }

  bool pressed = (digitalRead(BTN_PIN) == LOW);
#if USE_VAD
  bool shouldTalk = true; // VAD 模式：一直在听
#else
  bool shouldTalk = pressed;
#endif

  if (shouldTalk) {
    size_t n = recordOnce();
    if (n > 0) doTurn(recBuf, n);
    else faceSetActivity(ACT_IDLE);
    lastPingAt = millis();
    // 松手后等一下再接受下一次，防止连按
    delay(150);
    return;
  }

  if (millis() - lastPingAt > 20000) {
    lastPingAt = millis();
    doPing();
  }
  delay(20);
}
