// 表情表：和插件里的 plugin/lib/face.js 一一对应。
// 屏幕只有 72×40，所以只有两只眼睛 + 一张嘴，靠眼型和嘴型表达情绪。
#pragma once
#include <stdint.h>

enum EyeShape : uint8_t { EYE_OPEN, EYE_ARC, EYE_HALF, EYE_CLOSED };
enum MouthShape : uint8_t { MOUTH_FLAT, MOUTH_SMILE, MOUTH_FROWN, MOUTH_TINY, MOUTH_OPEN, MOUTH_TALK, MOUTH_WAVE };
enum Activity : uint8_t { ACT_IDLE, ACT_LISTEN, ACT_THINK, ACT_TALK };

struct FaceDef {
  const char* key;
  EyeShape eye;
  int8_t eyeW;
  int8_t eyeH;
  int8_t tilt;
  MouthShape mouth;
};

// 顺序必须和 face.js 一致（面板里的预览就是这么画的）
static const FaceDef FACES[] = {
  { "neutral",  EYE_OPEN,   12, 13,  0, MOUTH_FLAT  },
  { "happy",    EYE_ARC,    13, 12,  0, MOUTH_SMILE },
  { "excited",  EYE_ARC,    14, 14,  0, MOUTH_OPEN  },
  { "curious",  EYE_OPEN,   12, 15,  6, MOUTH_TINY  },
  { "thinking", EYE_HALF,   12,  7, -4, MOUTH_FLAT  },
  { "listening",EYE_OPEN,   13, 16,  0, MOUTH_TINY  },
  { "speaking", EYE_OPEN,   12, 13,  0, MOUTH_TALK  },
  { "sleepy",   EYE_CLOSED, 12,  2,  0, MOUTH_TINY  },
  { "sad",      EYE_HALF,   12,  9, -8, MOUTH_FROWN },
  { "confused", EYE_OPEN,   11, 12,  0, MOUTH_WAVE  },
};
static const uint8_t FACE_COUNT = sizeof(FACES) / sizeof(FACES[0]);

void faceBegin();
/** 按情绪名切表情；认不出来的退回 neutral */
void faceSet(const char* key);
/** 临时活动状态：说话 / 聆听 / 思考 / 空闲，盖住情绪，活动结束后自动回到情绪 */
void faceSetActivity(Activity a);
/** 主循环里每 20~30ms 调一次 */
void faceTick();
/** 当前在显示的表情名（调试用） */
const char* faceCurrent();
