// 在 72×40 的 SSD1306 上画那张脸。
// 坐标和插件面板里的预览完全一致：左右眼中心 (24,16) / (48,16)，嘴 (36,30)。
#include "face.h"
#include "config.h"
#include <U8g2lib.h>
#include <Arduino.h>

// 0.36 寸 72×40，软件模拟 I2C（引脚在 config.h 里）
static U8G2_SSD1306_72X40_ER_F_SW_I2C u8g2(U8G2_R0, OLED_SCL, OLED_SDA, U8X8_PIN_NONE);

static const FaceDef* cur = &FACES[0];
static Activity act = ACT_IDLE;
static uint32_t nextBlinkAt = 0;
static uint32_t blinkUntil = 0;
static uint32_t lastDraw = 0;
static bool talking = false;

static const FaceDef* findFace(const char* key) {
  if (!key) return &FACES[0];
  for (uint8_t i = 0; i < FACE_COUNT; i++) {
    if (strcmp(FACES[i].key, key) == 0) return &FACES[i];
  }
  return &FACES[0];
}

static void drawEye(int16_t cx, int16_t cy, const FaceDef* f, bool mirrored, bool blink) {
  int16_t w = f->eyeW;
  int16_t h = f->eyeH;
  // 倾斜是"近似"的：72×40 的屏上看不出来，用整体上下偏移模拟
  int16_t tiltOff = (f->tilt * (mirrored ? -1 : 1)) / 4;

  EyeShape shape = f->eye;
  // 只在睁眼和弯眼时眨
  if (blink && (shape == EYE_OPEN || shape == EYE_ARC)) shape = EYE_CLOSED;

  if (shape == EYE_CLOSED) {
    u8g2.drawLine(cx - w / 2, cy + tiltOff, cx + w / 2, cy + tiltOff);
    return;
  }
  if (shape == EYE_ARC) {
    // ^ 形笑眼：三段折线
    int16_t a = w / 4;
    int16_t top = cy - h / 2 + tiltOff;
    u8g2.drawLine(cx - w / 2, cy + h / 4 + tiltOff, cx - a, top);
    u8g2.drawLine(cx - a, top, cx + a, top);
    u8g2.drawLine(cx + a, top, cx + w / 2, cy + h / 4 + tiltOff);
    return;
  }
  if (shape == EYE_HALF) {
    // 上眼皮一条弧 + 下眼线
    int16_t top = cy - h / 2 + tiltOff;
    u8g2.drawLine(cx - w / 2, cy + tiltOff, cx - w / 4, top);
    u8g2.drawLine(cx - w / 4, top, cx + w / 4, top);
    u8g2.drawLine(cx + w / 4, top, cx + w / 2, cy + tiltOff);
    u8g2.drawLine(cx - w / 2, cy + tiltOff, cx + w / 2, cy + tiltOff);
    return;
  }
  // EYE_OPEN：圆角方块 + 挖一个瞳孔
  u8g2.drawRBox(cx - w / 2, cy - h / 2 + tiltOff, w, h, min(w, h) / 2);
  u8g2.setDrawColor(0);
  u8g2.drawDisc(cx, cy + h / 10 + tiltOff, max(2, (int)(h * 0.30f)));
  u8g2.setDrawColor(1);
}

static void drawMouth(const FaceDef* f, bool talkingNow) {
  const int16_t mx = 36;
  const int16_t my = 30;
  const int16_t mw = 12;
  switch (f->mouth) {
    case MOUTH_SMILE:
      u8g2.drawLine(mx - mw / 2, my - 1, mx - mw / 4, my + 2);
      u8g2.drawLine(mx - mw / 4, my + 2, mx + mw / 4, my + 2);
      u8g2.drawLine(mx + mw / 4, my + 2, mx + mw / 2, my - 1);
      break;
    case MOUTH_FROWN:
      u8g2.drawLine(mx - mw / 2, my + 2, mx - mw / 4, my - 1);
      u8g2.drawLine(mx - mw / 4, my - 1, mx + mw / 4, my - 1);
      u8g2.drawLine(mx + mw / 4, my - 1, mx + mw / 2, my + 2);
      break;
    case MOUTH_TINY:
      u8g2.drawDisc(mx, my, 2);
      break;
    case MOUTH_OPEN:
      u8g2.drawDisc(mx, my, 4);
      break;
    case MOUTH_TALK: {
      // 说话时高度来回变，10fps 就够
      int16_t h = talkingNow ? (millis() / 120 % 2 ? 4 : 2) : 3;
      u8g2.drawDisc(mx, my, h);
      break;
    }
    case MOUTH_WAVE:
      u8g2.drawLine(mx - 6, my, mx - 3, my - 2);
      u8g2.drawLine(mx - 3, my - 2, mx, my);
      u8g2.drawLine(mx, my, mx + 3, my + 2);
      u8g2.drawLine(mx + 3, my + 2, mx + 6, my);
      break;
    case MOUTH_FLAT:
    default:
      u8g2.drawLine(mx - 5, my, mx + 5, my);
      break;
  }
}

static void draw() {
  const FaceDef* f = cur;
  // 活动状态盖住情绪
  if (act == ACT_LISTEN) f = findFace("listening");
  else if (act == ACT_THINK) f = findFace("thinking");
  else if (act == ACT_TALK) f = findFace("speaking");

  bool blink = millis() < blinkUntil;

  u8g2.clearBuffer();
  drawEye(24, 16, f, false, blink);
  drawEye(48, 16, f, true, blink);
  drawMouth(f, act == ACT_TALK);
  u8g2.sendBuffer();
}

void faceBegin() {
  u8g2.begin();
  u8g2.setContrast(180); // 太亮费电，太暗看不清；按电池情况调
  u8g2.setFont(u8g2_font_4x6_tr);
  nextBlinkAt = millis() + BLINK_MIN_MS;
  draw();
}

void faceSet(const char* key) {
  cur = findFace(key);
  // 换表情立刻画一帧，别等下一次 tick
  draw();
}

void faceSetActivity(Activity a) {
  act = a;
  talking = (a == ACT_TALK);
}

const char* faceCurrent() { return cur->key; }

void faceTick() {
  uint32_t now = millis();
  if (now - lastDraw < 60) return; // 最多 ~16fps，够用也不闪
  lastDraw = now;

  // 眨眼调度（只有睁眼类表情才眨）
  if (act == ACT_IDLE && (cur->eye == EYE_OPEN || cur->eye == EYE_ARC)) {
    if (now >= nextBlinkAt) {
      blinkUntil = now + BLINK_MS;
      nextBlinkAt = now + BLINK_MIN_MS + (esp_random() % (BLINK_MAX_MS - BLINK_MIN_MS));
    }
  }
  draw();
}
