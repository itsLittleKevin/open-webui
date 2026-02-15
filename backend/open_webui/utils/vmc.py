"""
VMC (Virtual Motion Capture) protocol module.

Handles OSC communication with VSeeFace for:
- Receiving blendshape/bone data (recording)
- Sending blendshape/bone data (playback)

VSeeFace defaults:
  - Sends OSC on port 39539
  - Receives OSC on port 39540

VMC Protocol reference: https://protocol.vmc.info/
"""

import json
import math
import time
import threading
import logging
from pathlib import Path
from typing import Optional

from pythonosc import udp_client, osc_server, dispatcher

from open_webui.env import DATA_DIR


# ── Quaternion helpers ───────────────────────────────────────────────────

def _quat_identity() -> list[float]:
    return [0.0, 0.0, 0.0, 1.0]


def _quat_multiply(a: list[float], b: list[float]) -> list[float]:
    """Hamilton product: a * b. Format [x, y, z, w]."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def _quat_inverse(q: list[float]) -> list[float]:
    """Inverse of a unit quaternion (conjugate). Format [x, y, z, w]."""
    return [-q[0], -q[1], -q[2], q[3]]


def _quat_normalize(q: list[float]) -> list[float]:
    mag = math.sqrt(sum(c * c for c in q))
    if mag < 1e-10:
        return _quat_identity()
    return [c / mag for c in q]


# ── Blendshape clamping / eye-conflict resolution ────────────────────────

_EYE_BLINK_NAMES = frozenset({
    "Blink", "Blink_L", "Blink_R",
    "BlinkLeft", "BlinkRight",
    "EyeBlinkLeft", "EyeBlinkRight",
    "eyeBlinkLeft", "eyeBlinkRight",
})
_EXPRESSIONS_AFFECTING_EYES = frozenset({"Joy", "Angry"})


def _clamp_blendshapes(bs: dict[str, float]) -> dict[str, float]:
    """Clamp all blendshape values to [0,1] and resolve eye conflicts.

    VRM expression presets like *Joy* and *Angry* internally close the
    eyes.  When individual eye-blink blendshapes are also active, the
    combined effect can exceed 1.0 and poke geometry through the mesh.
    This helper caps eye-blink values so the total stays within limits.
    """
    result = {k: max(0.0, min(1.0, v)) for k, v in bs.items()}

    expr_eye = max(
        (result.get(n, 0.0) for n in _EXPRESSIONS_AFFECTING_EYES),
        default=0.0,
    )
    if expr_eye > 0.05:
        # Assume expressions close eyes at ~70% of their value
        cap = max(0.0, 1.0 - expr_eye * 0.7)
        for name in _EYE_BLINK_NAMES:
            if name in result:
                result[name] = min(result[name], cap)
    return result


log = logging.getLogger(__name__)

# Default ports (VSeeFace conventions)
VMC_RECV_PORT = 39539  # We listen here (VSeeFace sends to us)
VMC_SEND_PORT = 39540  # We send here (VSeeFace listens)
VMC_SEND_HOST = "127.0.0.1"

# Presets directory (inside DATA_DIR so it won't trigger Vite/uvicorn reload)
PRESETS_DIR = DATA_DIR / "vmc_presets"


# ── Rest pose (arms-down baseline) ───────────────────────────────────────

_REST_POSE_PATH = DATA_DIR / "vmc_rest_pose.json"

# Default rest pose: rotates arms from T-pose to natural sides.
# Quaternion [x, y, z, w] — only Z rotation needed for arms.
_DEFAULT_REST_POSE: dict[str, dict] = {
    "LeftUpperArm":  {"pos": [0, 0, 0], "rot": [0.0, 0.0,  0.5736, 0.8192]},   # ~70° Z
    "RightUpperArm": {"pos": [0, 0, 0], "rot": [0.0, 0.0, -0.5736, 0.8192]},   # ~-70° Z
    "LeftLowerArm":  {"pos": [0, 0, 0], "rot": [0.0, 0.0,  0.0436, 0.9990]},   # ~5° Z
    "RightLowerArm": {"pos": [0, 0, 0], "rot": [0.0, 0.0, -0.0436, 0.9990]},   # ~-5° Z
}

_rest_pose: dict[str, dict] = {}


def _load_rest_pose():
    global _rest_pose
    if _REST_POSE_PATH.exists():
        try:
            _rest_pose = json.loads(_REST_POSE_PATH.read_text(encoding="utf-8"))
            log.info(f"Loaded custom rest pose ({len(_rest_pose)} bones)")
            return
        except (json.JSONDecodeError, KeyError):
            pass
    _rest_pose = {k: dict(v) for k, v in _DEFAULT_REST_POSE.items()}


def get_rest_pose() -> dict[str, dict]:
    """Return the current rest pose (loads from disk on first call)."""
    if not _rest_pose:
        _load_rest_pose()
    return _rest_pose


def set_rest_pose(bones: dict[str, dict]):
    """Set a custom rest pose from captured bone data and persist it."""
    global _rest_pose
    _rest_pose = {k: v for k, v in bones.items() if k != "Hips"}
    _REST_POSE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _REST_POSE_PATH.write_text(
        json.dumps(_rest_pose, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log.info(f"Rest pose saved ({len(_rest_pose)} bones)")


def reset_rest_pose():
    """Reset rest pose to the default arms-down values."""
    global _rest_pose
    _rest_pose = {k: dict(v) for k, v in _DEFAULT_REST_POSE.items()}
    if _REST_POSE_PATH.exists():
        _REST_POSE_PATH.unlink()
    log.info("Rest pose reset to default")


def apply_rest_pose():
    """Send the rest pose bones once to VSeeFace (quick T-pose fix)."""
    sender = get_sender()
    sender._ensure_client()
    for name, data in get_rest_pose().items():
        if name == "Hips":
            continue
        r = data.get("rot", [0, 0, 0, 1])
        sender._client.send_message(
            "/VMC/Ext/Bone/Pos",
            [name, 0.0, 0.0, 0.0] + [float(v) for v in r],
        )
    log.info("Rest pose applied to VSeeFace")


class VMCSender:
    """Sends VMC/OSC messages to VSeeFace."""

    def __init__(self, host: str = VMC_SEND_HOST, port: int = VMC_SEND_PORT):
        self.host = host
        self.port = port
        self._client: Optional[udp_client.SimpleUDPClient] = None

    def _ensure_client(self):
        if self._client is None:
            self._client = udp_client.SimpleUDPClient(self.host, self.port)

    def send_blendshape(self, name: str, value: float):
        """Send a single blendshape value (0.0–1.0)."""
        self._ensure_client()
        # VMC protocol: /VMC/Ext/Blend/Val <string name> <float value>
        self._client.send_message("/VMC/Ext/Blend/Val", [name, float(value)])

    def send_blendshape_apply(self):
        """Signal VSeeFace to apply all pending blendshape changes."""
        self._ensure_client()
        self._client.send_message("/VMC/Ext/Blend/Apply", [])

    def send_blendshapes(self, blendshapes: dict[str, float]):
        """Send multiple blendshapes and apply them atomically."""
        self._ensure_client()
        clamped = _clamp_blendshapes(blendshapes)
        for name, value in clamped.items():
            self._client.send_message("/VMC/Ext/Blend/Val", [name, float(value)])
        self._client.send_message("/VMC/Ext/Blend/Apply", [])

    def send_bone(self, name: str, pos: list[float], rot: list[float]):
        """Send a bone position + rotation (quaternion xyzw)."""
        self._ensure_client()
        # /VMC/Ext/Bone/Pos <name> <px> <py> <pz> <rx> <ry> <rz> <rw>
        self._client.send_message(
            "/VMC/Ext/Bone/Pos",
            [name] + [float(v) for v in pos] + [float(v) for v in rot],
        )

    def send_bones(self, bones: dict[str, dict]):
        """Send multiple bones. Each value: {"pos": [x,y,z], "rot": [x,y,z,w]}."""
        self._ensure_client()
        for name, data in bones.items():
            p = data.get("pos", [0, 0, 0])
            r = data.get("rot", [0, 0, 0, 1])
            self._client.send_message(
                "/VMC/Ext/Bone/Pos",
                [name] + [float(v) for v in p] + [float(v) for v in r],
            )

    def send_frame(self, frame: dict, include_bones: bool = False):
        """Send a complete frame (blendshapes + rest-pose bones).

        The rest pose (arms-down) is always sent as a baseline so the
        model never T-poses.  When *include_bones* is True the frame's
        own bone data overrides matching rest-pose entries.

        The Hips bone is always skipped to prevent teleportation.
        Bone positions are sent as zero — only rotations matter.
        """
        bs = _clamp_blendshapes(frame.get("blendshapes", {}))
        self._ensure_client()
        for name, value in bs.items():
            self._client.send_message("/VMC/Ext/Blend/Val", [name, float(value)])
        self._client.send_message("/VMC/Ext/Blend/Apply", [])

        # Always send rest-pose bones; frame bones override when present
        merged_bones = dict(get_rest_pose())
        if include_bones:
            merged_bones.update(frame.get("bones", {}))
        for name, data in merged_bones.items():
            if name == "Hips":
                continue
            r = data.get("rot", [0, 0, 0, 1])
            self._client.send_message(
                "/VMC/Ext/Bone/Pos",
                [name, 0.0, 0.0, 0.0] + [float(v) for v in r],
            )

    def close(self):
        self._client = None


class VMCRecorder:
    """Records incoming VMC/OSC data from VSeeFace into keyframe files."""

    def __init__(self, listen_port: int = VMC_RECV_PORT):
        self.listen_port = listen_port
        self._server: Optional[osc_server.ThreadingOSCUDPServer] = None
        self._server_thread: Optional[threading.Thread] = None
        self._recording = False
        self._start_time = 0.0
        self._frames: list[dict] = []
        self._current_blendshapes: dict[str, float] = {}
        self._current_bones: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._sample_interval = 1.0 / 30  # 30 fps capture
        self._last_sample_time = 0.0

    def _on_blendshape(self, address: str, *args):
        """Handle /VMC/Ext/Blend/Val messages."""
        if len(args) >= 2:
            name, value = str(args[0]), float(args[1])
            with self._lock:
                self._current_blendshapes[name] = value

    def _on_bone(self, address: str, *args):
        """Handle /VMC/Ext/Bone/Pos messages."""
        if len(args) >= 8:
            name = str(args[0])
            pos = [float(args[1]), float(args[2]), float(args[3])]
            rot = [float(args[4]), float(args[5]), float(args[6]), float(args[7])]
            with self._lock:
                was_empty = len(self._current_bones) == 0
                self._current_bones[name] = {"pos": pos, "rot": rot}
                if was_empty:
                    log.info(f"VMC first bone received: {name}")

    def _on_blendshape_apply(self, address: str, *args):
        """Handle /VMC/Ext/Blend/Apply — snapshot the current state as a frame."""
        if not self._recording:
            return

        now = time.perf_counter()
        if now - self._last_sample_time < self._sample_interval:
            return

        with self._lock:
            t_ms = int((now - self._start_time) * 1000)
            frame = {
                "t": t_ms,
                "blendshapes": dict(self._current_blendshapes),
            }
            if self._current_bones:
                frame["bones"] = {k: dict(v) for k, v in self._current_bones.items()}
            self._frames.append(frame)
            self._last_sample_time = now

    def start_server(self):
        """Start the OSC listener (call once at app startup)."""
        if self._server is not None:
            return

        disp = dispatcher.Dispatcher()
        disp.map("/VMC/Ext/Blend/Val", self._on_blendshape)
        disp.map("/VMC/Ext/Blend/Apply", self._on_blendshape_apply)
        disp.map("/VMC/Ext/Bone/Pos", self._on_bone)

        self._server = osc_server.ThreadingOSCUDPServer(
            ("0.0.0.0", self.listen_port), disp
        )
        self._server_thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._server_thread.start()
        log.info(f"VMC recorder listening on port {self.listen_port}")

    def stop_server(self):
        """Stop the OSC listener."""
        if self._server:
            self._server.shutdown()
            self._server = None
            self._server_thread = None

    def start_recording(self):
        """Begin capturing frames."""
        with self._lock:
            self._frames = []
            self._current_blendshapes = {}
            self._current_bones = {}
            self._start_time = time.perf_counter()
            self._last_sample_time = 0.0
            self._recording = True
        log.info("VMC recording started")

    def stop_recording(self) -> list[dict]:
        """Stop capturing and return raw absolute frames."""
        with self._lock:
            self._recording = False
            frames = list(self._frames)
        log.info(f"VMC recording stopped: {len(frames)} frames captured")
        return frames

    def get_current_state(self) -> dict:
        """Snapshot the latest blendshape/bone values from VSeeFace."""
        with self._lock:
            state: dict = {"blendshapes": dict(self._current_blendshapes)}
            if self._current_bones:
                state["bones"] = {k: dict(v) for k, v in self._current_bones.items()}
            return state

    @property
    def is_recording(self) -> bool:
        return self._recording

    @property
    def frame_count(self) -> int:
        return len(self._frames)

    @property
    def bone_count(self) -> int:
        """Number of distinct bones currently being tracked."""
        return len(self._current_bones)

    @property
    def bone_names(self) -> list[str]:
        """Names of bones currently being tracked."""
        return list(self._current_bones.keys())


class VMCPlayer:
    """Layered animation player with idle + action layers.

    Two layers are rendered at ~30 fps and merged before sending:
      - **Idle layer** : absolute frames, loops forever (crossfade at
        loop boundary for seamless looping).  Overrides T-pose.
      - **Action layer**: relative delta frames, one-shot (or looped),
        layered additively on top of idle.

    When an action finishes the output reverts to pure idle.
    When neither layer is active a neutral-reset frame is sent.
    """

    RENDER_FPS = 30
    CROSSFADE_MS = 500  # ms to blend at idle loop boundary

    def __init__(self, sender: VMCSender):
        self.sender = sender
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False

        # Idle state
        self._idle_frames: list[dict] = []
        self._idle_active = False
        self._idle_name = ""

        # Active actions: list of {frames, loop, start_time}
        # Multiple actions can play simultaneously (layered on top of each other)
        self._active_actions: list[dict] = []
        # Track blendshape/bone names touched by any action for clean reset
        self._dirty_blendshapes: set[str] = set()
        self._dirty_bones: set[str] = set()

    # ── Public API ────────────────────────────────────────────────────

    def set_idle(self, frames: list[dict], name: str = ""):
        """Set and start looping idle animation (absolute frames)."""
        with self._lock:
            self._idle_frames = list(frames)
            self._idle_active = True
            self._idle_name = name
        self._ensure_thread()

    def stop_idle(self):
        """Stop the idle loop."""
        with self._lock:
            self._idle_active = False
            self._idle_name = ""

    @property
    def idle_name(self) -> str:
        return self._idle_name

    @property
    def is_idle_active(self) -> bool:
        return self._idle_active

    def play_action(self, frames: list[dict], loop: bool = False):
        """Add a new action to play on top of existing actions.

        Multiple actions can play simultaneously. They layer on top of
        each other and the idle animation. Each action runs independently.
        """
        with self._lock:
            action = {
                "frames": list(frames),
                "loop": loop,
                "start_time": time.perf_counter(),
            }
            self._active_actions.append(action)
            # Track dirty names for cleanup when all actions finish
            for f in frames:
                self._dirty_blendshapes.update(f.get("blendshapes", {}).keys())
                self._dirty_bones.update(f.get("bones", {}).keys())
        self._ensure_thread()

    def play(self, frames: list[dict], loop: bool = False):
        """Backward-compatible alias for play_action."""
        self.play_action(frames, loop=loop)

    def stop(self):
        """Stop all playback (idle + all actions) and send neutral reset."""
        with self._lock:
            self._idle_active = False
            self._active_actions.clear()
            self._dirty_blendshapes.clear()
            self._dirty_bones.clear()
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    def stop_action(self):
        """Stop all currently playing actions; idle continues."""
        with self._lock:
            self._active_actions.clear()

    @property
    def is_playing(self) -> bool:
        return self._idle_active or bool(self._active_actions)

    # ── Internal ──────────────────────────────────────────────────────

    def _ensure_thread(self):
        if self._running:
            return
        if self._thread:
            self._thread.join(timeout=1)
            self._thread = None
        self._running = True
        self._thread = threading.Thread(target=self._render_loop, daemon=True)
        self._thread.start()

    def _send_reset(self):
        """Send neutral blendshapes to clear any lingering VSeeFace state."""
        names: set[str] = set(self._dirty_blendshapes)
        for action in self._active_actions:
            for f in action["frames"]:
                names.update(f.get("blendshapes", {}).keys())
        for f in self._idle_frames:
            names.update(f.get("blendshapes", {}).keys())
        if names:
            self.sender.send_frame(
                {"blendshapes": {n: 0.0 for n in names}},
                include_bones=False,
            )
        self._dirty_blendshapes.clear()
        self._dirty_bones.clear()

    # ── Frame helpers ─────────────────────────────────────────────────

    @staticmethod
    def _find_frame(frames: list[dict], target_ms: float) -> dict:
        """Nearest frame at or before *target_ms*."""
        best = frames[0]
        for f in frames:
            if f["t"] <= target_ms:
                best = f
            else:
                break
        return best

    @staticmethod
    def _blend_frames(a: dict, b: dict, t: float) -> dict:
        """Linearly blend two frames: result = a*(1-t) + b*t."""
        result: dict = {}

        # Blendshapes
        a_bs = a.get("blendshapes", {})
        b_bs = b.get("blendshapes", {})
        result["blendshapes"] = {}
        for name in set(a_bs) | set(b_bs):
            va = a_bs.get(name, 0.0)
            vb = b_bs.get(name, 0.0)
            result["blendshapes"][name] = va + (vb - va) * t

        # Bones (rotation nlerp only — positions zeroed)
        a_bones = a.get("bones", {})
        b_bones = b.get("bones", {})
        if a_bones or b_bones:
            result["bones"] = {}
            for name in set(a_bones) | set(b_bones):
                ar = a_bones.get(name, {}).get("rot", [0, 0, 0, 1])
                br = b_bones.get(name, {}).get("rot", [0, 0, 0, 1])
                # Quaternion hemisphere check for shortest-path nlerp
                if sum(ar[i] * br[i] for i in range(4)) < 0:
                    br = [-c for c in br]
                result["bones"][name] = {
                    "pos": [0.0, 0.0, 0.0],
                    "rot": _quat_normalize(
                        [ar[i] + (br[i] - ar[i]) * t for i in range(4)]
                    ),
                }
        return result

    # ── Layer sampling ────────────────────────────────────────────────

    def _get_idle_frame(self, elapsed_s: float) -> Optional[dict]:
        frames = self._idle_frames
        if not frames:
            return None
        duration_ms = frames[-1]["t"]
        if duration_ms <= 0:
            return dict(frames[0])

        elapsed_ms = (elapsed_s * 1000) % duration_ms
        current = self._find_frame(frames, elapsed_ms)

        # Crossfade near loop boundary
        cf_ms = min(self.CROSSFADE_MS, duration_ms * 0.3)
        if cf_ms > 0 and elapsed_ms > duration_ms - cf_ms:
            blend = (elapsed_ms - (duration_ms - cf_ms)) / cf_ms
            current = self._blend_frames(current, frames[0], blend)
        return current

    def _get_active_action_frames(self) -> list[dict]:
        """Get current frame from each active action, remove expired ones.

        Actions that have finished (non-looping) are removed from the list.
        Looping actions restart.  Returns list of current frames to merge.
        """
        active_frames = []
        expired_indices = []

        for i, action in enumerate(self._active_actions):
            frames = action["frames"]
            if not frames:
                continue

            elapsed_ms = (time.perf_counter() - action["start_time"]) * 1000
            duration_ms = frames[-1]["t"]

            if elapsed_ms >= duration_ms:
                if action["loop"]:
                    # Restart the loop (but keep in the list)
                    action["start_time"] = time.perf_counter()
                    elapsed_ms = 0.0
                else:
                    # Mark for removal
                    expired_indices.append(i)
                    continue

            # Get frame at current time
            frame = self._find_frame(frames, elapsed_ms)
            active_frames.append(frame)

        # Remove expired actions (in reverse to avoid index issues)
        for i in reversed(expired_indices):
            self._active_actions.pop(i)

        return active_frames

    # ── Layer merging ─────────────────────────────────────────────────

    def _merge_multiple_actions(
        self, idle: Optional[dict], action_frames: list[dict]
    ) -> Optional[dict]:
        """Merge idle + multiple action frames (all layer on top).

        All actions layer additively on top of each other and the idle
        animation. Blendshapes are summed (clamped 0-1), bones are
        composed via quaternion multiplication.
        """
        if not action_frames:
            return idle

        # Start with idle or empty
        result = dict(idle) if idle else {}

        # Merge each action frame on top (in order)
        for action_frame in action_frames:
            result = self._merge_layers(result, action_frame)

        return result

    @staticmethod
    def _merge_layers(idle: Optional[dict], action: Optional[dict]) -> Optional[dict]:
        """Merge absolute idle + relative action delta."""
        if not action:
            return idle
        if not idle:
            return action

        result: dict = {}

        # Blendshapes: clamp(idle + delta, 0, 1)
        i_bs = idle.get("blendshapes", {})
        a_bs = action.get("blendshapes", {})
        result["blendshapes"] = {}
        for name in set(i_bs) | set(a_bs):
            result["blendshapes"][name] = max(
                0.0, min(1.0, i_bs.get(name, 0.0) + a_bs.get(name, 0.0))
            )

        # Bones: only merge rotations (pos zeroed to prevent teleportation)
        i_bones = idle.get("bones", {})
        a_bones = action.get("bones", {})
        if i_bones or a_bones:
            result["bones"] = {}
            for name in set(i_bones) | set(a_bones):
                ir = i_bones.get(name, {}).get("rot", [0, 0, 0, 1])
                dr = a_bones.get(name, {}).get("rot", [0, 0, 0, 1])
                result["bones"][name] = {
                    "pos": [0.0, 0.0, 0.0],
                    "rot": _quat_normalize(_quat_multiply(ir, dr)),
                }
        return result

    # ── Render loop ───────────────────────────────────────────────────

    def _render_loop(self):
        """Main render loop at ~30 fps."""
        idle_epoch = time.perf_counter()
        interval = 1.0 / self.RENDER_FPS

        while self._running:
            t0 = time.perf_counter()

            with self._lock:
                if not self._idle_active and not self._active_actions:
                    break

                idle_frame = (
                    self._get_idle_frame(t0 - idle_epoch)
                    if self._idle_active and self._idle_frames
                    else None
                )
                action_frames = self._get_active_action_frames()

            merged = self._merge_multiple_actions(idle_frame, action_frames)

            if merged:
                # Zero blendshapes / reset bones that were set by previous
                # actions but are no longer in the merged frame — prevents
                # stale values lingering on VSeeFace after interruptions.
                with self._lock:
                    if self._dirty_blendshapes:
                        bs = merged.get("blendshapes", {})
                        for name in self._dirty_blendshapes:
                            if name not in bs:
                                bs[name] = 0.0
                        merged["blendshapes"] = bs
                    if self._dirty_bones:
                        bones = merged.setdefault("bones", {})
                        for name in self._dirty_bones:
                            if name not in bones and name != "Hips":
                                bones[name] = {"pos": [0, 0, 0], "rot": _quat_identity()}
                    # Clear dirty tracking once ALL actions finish
                    if not self._idle_active and not self._active_actions:
                        self._dirty_blendshapes.clear()
                        self._dirty_bones.clear()

                has_bones = bool(merged.get("bones"))
                self.sender.send_frame(merged, include_bones=has_bones)

            dt = interval - (time.perf_counter() - t0)
            if dt > 0:
                time.sleep(dt)

        # Exiting — send neutral reset so VSeeFace doesn't freeze on
        # the last expression
        self._send_reset()
        self._running = False


# ── Relative frame conversion ────────────────────────────────────────────

def convert_to_relative(frames: list[dict]) -> list[dict]:
    """Convert absolute recorded frames to deltas from frame 0.

    Blendshapes: delta = value - frame0_value
    Bone positions: delta = pos - frame0_pos
    Bone rotations: delta = inverse(frame0_rot) * rot
    """
    if not frames:
        return frames

    ref = frames[0]
    ref_bs = ref.get("blendshapes", {})
    ref_bones = ref.get("bones", {})

    relative_frames = []
    for frame in frames:
        rframe: dict = {"t": frame["t"]}

        # Blendshape deltas
        fbs = frame.get("blendshapes", {})
        delta_bs = {}
        for name in set(fbs) | set(ref_bs):
            delta_bs[name] = fbs.get(name, 0.0) - ref_bs.get(name, 0.0)
        rframe["blendshapes"] = delta_bs

        # Bone deltas (rotation only — positions are zeroed to prevent teleportation)
        fbones = frame.get("bones", {})
        if fbones or ref_bones:
            delta_bones = {}
            for name in set(fbones) | set(ref_bones):
                fr = fbones.get(name, {}).get("rot", [0, 0, 0, 1])
                rr = ref_bones.get(name, {}).get("rot", [0, 0, 0, 1])
                delta_bones[name] = {
                    "pos": [0.0, 0.0, 0.0],
                    "rot": _quat_normalize(_quat_multiply(_quat_inverse(rr), fr)),
                }
            rframe["bones"] = delta_bones

        relative_frames.append(rframe)

    return relative_frames


# ── Preset file I/O ──────────────────────────────────────────────────────

def ensure_presets_dir():
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)


def save_preset(name: str, frames: list[dict], mode: str = "absolute") -> Path:
    """Save frames to a JSON preset file.

    mode: 'absolute' for recorded animations (idle-capable),
          'relative' for synthetic delta animations (actions only).
    """
    ensure_presets_dir()
    duration_ms = frames[-1]["t"] if frames else 0
    preset = {
        "name": name,
        "mode": mode,
        "duration_ms": duration_ms,
        "frame_count": len(frames),
        "frames": frames,
    }
    path = PRESETS_DIR / f"{name}.json"
    path.write_text(json.dumps(preset, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info(f"Preset saved: {path} ({len(frames)} frames, {duration_ms}ms)")
    return path


def load_preset(name: str) -> dict:
    """Load a preset by name."""
    path = PRESETS_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"Preset not found: {name}")
    return json.loads(path.read_text(encoding="utf-8"))


def list_presets() -> list[dict]:
    """List all available presets (name, duration, frame count, mode)."""
    ensure_presets_dir()
    presets = []
    for p in sorted(PRESETS_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            presets.append({
                "name": data.get("name", p.stem),
                "duration_ms": data.get("duration_ms", 0),
                "frame_count": data.get("frame_count", 0),
                "mode": data.get("mode", "absolute"),
            })
        except (json.JSONDecodeError, KeyError):
            continue
    return presets


def delete_preset(name: str) -> bool:
    """Delete a preset file."""
    path = PRESETS_DIR / f"{name}.json"
    if path.exists():
        path.unlink()
        return True
    return False


# ── Singleton instances ──────────────────────────────────────────────────

_sender: Optional[VMCSender] = None
_recorder: Optional[VMCRecorder] = None
_player: Optional[VMCPlayer] = None


def get_sender() -> VMCSender:
    global _sender
    if _sender is None:
        _sender = VMCSender()
    return _sender


def get_recorder() -> VMCRecorder:
    global _recorder
    if _recorder is None:
        _recorder = VMCRecorder()
    return _recorder


def get_player() -> VMCPlayer:
    global _player
    if _player is None:
        _player = VMCPlayer(get_sender())
    return _player
