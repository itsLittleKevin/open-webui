"""
Emotion detection and VMC animation triggering.

Provides keyword-based sentiment analysis of LLM responses and maps
detected emotions to VMC animation presets for the VRM avatar.
"""

import re
import logging
from typing import Optional

log = logging.getLogger(__name__)

# ── Emotion keyword patterns ─────────────────────────────────────────────

EMOTION_PATTERNS: dict[str, list[str]] = {
    "joy": [
        r"\bhappy\b", r"\bglad\b", r"\bgreat\b", r"\bwonderful\b",
        r"\bawesome\b", r"\blove\b", r"\benjoy\b", r"\bexcited\b",
        r"\bfantastic\b", r"\bexcellent\b", r"\bamazing\b", r"\bdelighted\b",
        r"\bthrill", r"\bcheer", r"\bpleasur", r"\bjoy\b",
        r"\bhaha\b", r"\blol\b",
    ],
    "sad": [
        r"\bsad\b", r"\bsorry\b", r"\bunfortunately\b", r"\bregret\b",
        r"\bdisappoint", r"\bmiss(?:ing|ed)\b", r"\bunhappy\b",
        r"\btragic", r"\bgriev", r"\bheartbreak",
    ],
    "anger": [
        r"\bangry\b", r"\bfurious\b", r"\bannoy", r"\bfrustrat",
        r"\birritat", r"\brage\b", r"\binfuriat", r"\boutrag",
    ],
    "surprise": [
        r"\bwow\b", r"\bincredible\b", r"\bunbelievable\b",
        r"\bunexpect", r"\bshock", r"\bastound", r"\bastonish",
        r"\bwhoa\b", r"\bomg\b",
    ],
    "agree": [
        r"\byes\b", r"\bsure\b", r"\babsolutely\b", r"\bcertainly\b",
        r"\bof course\b", r"\bindeed\b", r"\bcorrect\b",
        r"\bagree\b", r"\bdefinitely\b", r"\bexactly\b",
    ],
    "disagree": [
        r"\bdon'?t think\b", r"\bincorrect\b", r"\bwrong\b",
        r"\bdisagree\b", r"\bnot really\b", r"\bnot quite\b",
        r"\bthat'?s not\b",
    ],
    "think": [
        r"\bhmm+\b", r"\blet me think\b", r"\bconsider", r"\bperhaps\b",
        r"\bmaybe\b", r"\bpossibly\b", r"\bwonder\b",
        r"\binteresting(?:ly)?\b",
    ],
}

# Compile patterns once at import time
_COMPILED: dict[str, list[re.Pattern]] = {
    emotion: [re.compile(p, re.IGNORECASE) for p in patterns]
    for emotion, patterns in EMOTION_PATTERNS.items()
}

# Default emotion → VMC preset name mapping
EMOTION_PRESET_MAP: dict[str, str] = {
    "joy": "smile",
    "sad": "sad",
    "anger": "angry",
    "surprise": "surprised",
    "agree": "nod",
    "disagree": "shake_head",
    "think": "thinking",
}

# Minimum keyword hits required to trigger an animation
MIN_SCORE = 2


def detect_emotion(text: str, min_score: int = MIN_SCORE) -> Optional[str]:
    """
    Detect the dominant emotion in text using keyword matching.

    Returns the emotion name (e.g. "joy", "agree") or None if no
    strong signal is found.
    """
    scores: dict[str, int] = {}

    for emotion, patterns in _COMPILED.items():
        score = sum(1 for p in patterns if p.search(text))
        if score > 0:
            scores[emotion] = score

    if not scores:
        return None

    best = max(scores, key=lambda k: scores[k])
    if scores[best] < min_score:
        return None

    return best


def get_preset_for_emotion(emotion: str) -> Optional[str]:
    """Map an emotion name to its VMC preset name."""
    return EMOTION_PRESET_MAP.get(emotion)


def trigger_animation(text: str, min_score: int = MIN_SCORE) -> Optional[str]:
    """
    Detect emotion in text and trigger the corresponding VMC preset.

    Returns the triggered preset name, or None.
    """
    emotion = detect_emotion(text, min_score)
    if not emotion:
        return None

    preset_name = get_preset_for_emotion(emotion)
    if not preset_name:
        log.debug(f"No preset mapped for emotion: {emotion}")
        return None

    try:
        from open_webui.utils.vmc import get_player, load_preset, convert_to_relative

        preset = load_preset(preset_name)
        frames = preset["frames"]
        if preset.get("mode", "absolute") == "absolute":
            frames = convert_to_relative(frames)
        player = get_player()
        player.play(frames, loop=False)
        log.info(f"VMC animation triggered: {preset_name} (emotion: {emotion})")
        return preset_name
    except FileNotFoundError:
        log.debug(f"VMC preset not found: {preset_name} — record it first")
        return None
    except Exception as e:
        log.warning(f"Failed to trigger VMC animation: {e}")
        return None


# ── Filter function content (to be stored in the Functions DB) ───────────

FILTER_ID = "vmc_emotion_trigger"
FILTER_NAME = "VMC Emotion Trigger"
FILTER_CONTENT = '''\
"""
title: VMC Emotion Trigger
description: Detects emotions in LLM responses and triggers VRM avatar animations via VMC protocol.
author: Agent
version: 0.1.0
"""

from pydantic import BaseModel
from typing import Optional


class Filter:
    class Valves(BaseModel):
        enabled: bool = True
        min_score: int = 2

    def __init__(self):
        self.valves = self.Valves()

    def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        if not self.valves.enabled:
            return body

        messages = body.get("messages", [])
        if not messages:
            return body

        # Find the last assistant message
        last_assistant = None
        for msg in reversed(messages):
            if msg.get("role") == "assistant":
                last_assistant = msg
                break

        if not last_assistant:
            return body

        text = last_assistant.get("content", "")
        if not text:
            return body

        try:
            from open_webui.utils.vmc_emotion import trigger_animation
            trigger_animation(text, min_score=self.valves.min_score)
        except Exception as e:
            print(f"VMC emotion trigger error: {e}")

        return body
'''


def install_filter(user_id: str) -> bool:
    """
    Install the VMC emotion trigger filter function into the DB.

    Returns True if created, False if it already exists.
    """
    from open_webui.models.functions import Functions, FunctionForm, FunctionMeta

    existing = Functions.get_function_by_id(FILTER_ID)
    if existing is not None:
        return False

    form = FunctionForm(
        id=FILTER_ID,
        name=FILTER_NAME,
        content=FILTER_CONTENT,
        meta=FunctionMeta(
            description="Detects emotions in LLM responses and triggers VRM avatar animations.",
        ),
    )

    result = Functions.insert_new_function(user_id, "filter", form)
    if result:
        Functions.update_function_by_id(
            FILTER_ID, {"is_global": True, "is_active": True}
        )
        log.info(f"VMC emotion filter installed: {FILTER_ID}")
        return True

    log.error("Failed to install VMC emotion filter")
    return False
