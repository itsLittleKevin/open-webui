"""
Synthetic VMC animation preset generator.

Creates starter presets programmatically using VRM blendshape names
and head bone rotations, so users have animations immediately without
needing to record from VSeeFace first.
"""

import math
import logging
from open_webui.utils.vmc import save_preset, list_presets

log = logging.getLogger(__name__)

FPS = 30  # frames per second


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _ease_in_out(t: float) -> float:
    """Smooth ease-in-out (cubic)."""
    if t < 0.5:
        return 4 * t * t * t
    return 1 - ((-2 * t + 2) ** 3) / 2


def _quat_from_euler_deg(x: float = 0, y: float = 0, z: float = 0) -> list[float]:
    """Convert Euler angles (degrees) to quaternion [qx, qy, qz, qw]."""
    rx, ry, rz = math.radians(x), math.radians(y), math.radians(z)
    cx, sx = math.cos(rx / 2), math.sin(rx / 2)
    cy, sy = math.cos(ry / 2), math.sin(ry / 2)
    cz, sz = math.cos(rz / 2), math.sin(rz / 2)
    return [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    ]


def _make_frames(duration_s: float, fn) -> list[dict]:
    """Generate frames at FPS. fn(t_normalized) -> frame_data dict."""
    count = max(2, int(duration_s * FPS))
    frames = []
    for i in range(count):
        t_norm = i / (count - 1)
        t_ms = int(t_norm * duration_s * 1000)
        data = fn(t_norm)
        data["t"] = t_ms
        frames.append(data)
    return frames


# ── Preset definitions ───────────────────────────────────────────────────


def _gen_smile() -> list[dict]:
    """Smile: ramp Joy up, hold, ramp down. 1.5s."""
    def fn(t):
        if t < 0.2:
            v = _ease_in_out(t / 0.2)
        elif t < 0.7:
            v = 1.0
        else:
            v = _ease_in_out(1.0 - (t - 0.7) / 0.3)
        return {"blendshapes": {"Joy": v}}
    return _make_frames(1.5, fn)


def _gen_sad() -> list[dict]:
    """Sad expression: ramp Sorrow up, hold, ramp down. 2s."""
    def fn(t):
        if t < 0.25:
            v = _ease_in_out(t / 0.25)
        elif t < 0.7:
            v = 1.0
        else:
            v = _ease_in_out(1.0 - (t - 0.7) / 0.3)
        return {"blendshapes": {"Sorrow": v * 0.8}}
    return _make_frames(2.0, fn)


def _gen_angry() -> list[dict]:
    """Angry expression. 1.5s."""
    def fn(t):
        if t < 0.15:
            v = _ease_in_out(t / 0.15)
        elif t < 0.7:
            v = 1.0
        else:
            v = _ease_in_out(1.0 - (t - 0.7) / 0.3)
        return {"blendshapes": {"Angry": v * 0.9}}
    return _make_frames(1.5, fn)


def _gen_surprised() -> list[dict]:
    """Surprised expression with widened eyes. 1.2s."""
    def fn(t):
        if t < 0.1:
            v = _ease_in_out(t / 0.1)
        elif t < 0.5:
            v = 1.0
        else:
            v = _ease_in_out(1.0 - (t - 0.5) / 0.5)
        return {"blendshapes": {"Surprised": v}}
    return _make_frames(1.2, fn)


def _gen_nod() -> list[dict]:
    """Head nod: down-up-down-up. ~1.2s using Head bone rotation."""
    def fn(t):
        # Two nod cycles
        angle = math.sin(t * math.pi * 4) * 12  # ±12 degrees, 2 cycles
        # Fade envelope
        env = 1.0
        if t < 0.1:
            env = t / 0.1
        elif t > 0.85:
            env = (1.0 - t) / 0.15
        angle *= env
        rot = _quat_from_euler_deg(x=angle)
        return {
            "blendshapes": {},
            "bones": {"Head": {"pos": [0, 0, 0], "rot": rot}},
        }
    return _make_frames(1.2, fn)


def _gen_shake_head() -> list[dict]:
    """Head shake: left-right-left-right. ~1.4s."""
    def fn(t):
        angle = math.sin(t * math.pi * 4) * 15  # ±15 degrees, 2 cycles
        env = 1.0
        if t < 0.1:
            env = t / 0.1
        elif t > 0.85:
            env = (1.0 - t) / 0.15
        angle *= env
        rot = _quat_from_euler_deg(y=angle)
        return {
            "blendshapes": {},
            "bones": {"Head": {"pos": [0, 0, 0], "rot": rot}},
        }
    return _make_frames(1.4, fn)


def _gen_thinking() -> list[dict]:
    """Thinking: slight head tilt + look up. 2s."""
    def fn(t):
        if t < 0.2:
            v = _ease_in_out(t / 0.2)
        elif t < 0.75:
            v = 1.0
        else:
            v = _ease_in_out(1.0 - (t - 0.75) / 0.25)
        tilt = v * 8  # 8 degree head tilt
        rot = _quat_from_euler_deg(x=-5 * v, z=tilt)
        return {
            "blendshapes": {"LookUp": v * 0.3},
            "bones": {"Head": {"pos": [0, 0, 0], "rot": rot}},
        }
    return _make_frames(2.0, fn)


# Registry of all starter presets
STARTER_PRESETS: dict[str, callable] = {
    "smile": _gen_smile,
    "sad": _gen_sad,
    "angry": _gen_angry,
    "surprised": _gen_surprised,
    "nod": _gen_nod,
    "shake_head": _gen_shake_head,
    "thinking": _gen_thinking,
}


def generate_starter_presets(overwrite: bool = False) -> list[str]:
    """
    Generate all starter presets and save them.

    Returns list of preset names that were created.
    """
    existing = {p["name"] for p in list_presets()}
    created = []

    for name, gen_fn in STARTER_PRESETS.items():
        if not overwrite and name in existing:
            log.debug(f"Skipping existing preset: {name}")
            continue

        frames = gen_fn()
        save_preset(name, frames, mode="relative")
        created.append(name)
        log.info(f"Generated starter preset: {name} ({len(frames)} frames)")

    return created
