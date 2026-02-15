"""
VMC (Virtual Motion Capture) API router.

Endpoints for recording, managing, and playing back VMC animation presets.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from open_webui.utils.auth import get_verified_user
from open_webui.utils.vmc import (
    get_sender,
    get_recorder,
    get_player,
    save_preset,
    load_preset,
    list_presets,
    delete_preset,
    convert_to_relative,
    get_rest_pose,
    set_rest_pose,
    reset_rest_pose,
    apply_rest_pose,
)
from open_webui.utils.vmc_emotion import (
    detect_emotion,
    get_preset_for_emotion,
    EMOTION_PRESET_MAP,
    install_filter,
)
from open_webui.utils.vmc_presets import generate_starter_presets

log = logging.getLogger(__name__)
router = APIRouter()


# ── Models ────────────────────────────────────────────────────────────────


class PresetNameRequest(BaseModel):
    name: str


class PlayRequest(BaseModel):
    name: str
    loop: bool = False


class BlendshapeRequest(BaseModel):
    blendshapes: dict[str, float]


# ── Recording ─────────────────────────────────────────────────────────────


@router.post("/record/start")
async def start_recording(user=Depends(get_verified_user)):
    """Start the VMC recorder (begins capturing from VSeeFace)."""
    recorder = get_recorder()
    if recorder.is_recording:
        raise HTTPException(status_code=409, detail="Already recording")
    recorder.start_server()  # idempotent — no-op if already running
    recorder.start_recording()
    return {"status": "recording"}


@router.post("/record/stop")
async def stop_recording(
    request: PresetNameRequest, user=Depends(get_verified_user)
):
    """Stop recording and save as a named preset."""
    recorder = get_recorder()
    if not recorder.is_recording:
        raise HTTPException(status_code=409, detail="Not recording")

    frames = recorder.stop_recording()
    # Keep server running so the player can snapshot baseline state

    if not frames:
        raise HTTPException(status_code=400, detail="No frames captured")

    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Preset name is required")

    save_preset(name, frames)

    bones_in_frames = sum(1 for f in frames if "bones" in f)
    max_bones = max((len(f.get("bones", {})) for f in frames), default=0)

    return {
        "status": "saved",
        "name": name,
        "frame_count": len(frames),
        "duration_ms": frames[-1]["t"] if frames else 0,
        "bone_frames": bones_in_frames,
        "bone_count": max_bones,
    }


@router.get("/record/status")
async def recording_status(user=Depends(get_verified_user)):
    """Check if recording is active."""
    recorder = get_recorder()
    return {
        "recording": recorder.is_recording,
        "frame_count": recorder.frame_count,
        "bone_count": recorder.bone_count,
    }


# ── Presets ───────────────────────────────────────────────────────────────


@router.get("/presets")
async def get_presets(user=Depends(get_verified_user)):
    """List all saved animation presets."""
    return list_presets()


@router.get("/presets/{name}")
async def get_preset(name: str, user=Depends(get_verified_user)):
    """Get a specific preset's full data."""
    try:
        return load_preset(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Preset '{name}' not found")


@router.delete("/presets/{name}")
async def remove_preset(name: str, user=Depends(get_verified_user)):
    """Delete a preset."""
    if not delete_preset(name):
        raise HTTPException(status_code=404, detail=f"Preset '{name}' not found")
    return {"status": "deleted", "name": name}


# ── Playback ──────────────────────────────────────────────────────────────


@router.post("/play")
async def play_preset(request: PlayRequest, user=Depends(get_verified_user)):
    """Play a saved preset as an action (layered on top of idle)."""
    try:
        preset = load_preset(request.name)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"Preset '{request.name}' not found"
        )

    frames = preset["frames"]
    mode = preset.get("mode", "absolute")

    # Absolute presets need to be converted to relative deltas for actions
    if mode == "absolute":
        frames = convert_to_relative(frames)

    player = get_player()
    player.play_action(frames, loop=request.loop)
    return {
        "status": "playing",
        "name": request.name,
        "loop": request.loop,
    }


@router.post("/play/stop")
async def stop_playback(user=Depends(get_verified_user)):
    """Stop current action playback (idle continues)."""
    player = get_player()
    player.stop_action()
    return {"status": "stopped"}


@router.get("/play/status")
async def playback_status(user=Depends(get_verified_user)):
    """Check if an animation is currently playing."""
    player = get_player()
    return {"playing": player.is_playing}


# ── Idle ──────────────────────────────────────────────────────────────────


@router.post("/idle/set")
async def set_idle(request: PresetNameRequest, user=Depends(get_verified_user)):
    """Set a preset as the continuous idle animation (replaces T-pose)."""
    try:
        preset = load_preset(request.name)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"Preset '{request.name}' not found"
        )

    player = get_player()
    player.set_idle(preset["frames"], name=request.name)
    return {"status": "idle_started", "name": request.name}


@router.post("/idle/stop")
async def stop_idle(user=Depends(get_verified_user)):
    """Stop the idle loop and send a neutral reset."""
    player = get_player()
    player.stop_idle()
    return {"status": "idle_stopped"}


@router.get("/idle/status")
async def idle_status(user=Depends(get_verified_user)):
    """Check idle animation state."""
    player = get_player()
    return {
        "active": player.is_idle_active,
        "name": player.idle_name,
    }


# ── Direct blendshape control ────────────────────────────────────────


@router.post("/rest-pose/apply")
async def apply_rest_pose_endpoint(user=Depends(get_verified_user)):
    """Send the rest pose once to VSeeFace (quick T-pose fix)."""
    apply_rest_pose()
    return {"status": "applied"}


@router.post("/rest-pose/capture")
async def capture_rest_pose(user=Depends(get_verified_user)):
    """Capture VSeeFace's current bone state as the rest pose."""
    recorder = get_recorder()
    recorder.start_server()
    state = recorder.get_current_state()
    bones = state.get("bones", {})
    if not bones:
        raise HTTPException(
            status_code=400,
            detail="No bone data received from VSeeFace. Make sure VMC sending is enabled.",
        )
    set_rest_pose(bones)
    return {"status": "captured", "bone_count": len(bones)}


@router.post("/rest-pose/reset")
async def reset_rest_pose_endpoint(user=Depends(get_verified_user)):
    """Reset rest pose to the default arms-down values."""
    reset_rest_pose()
    return {"status": "reset"}


@router.get("/rest-pose")
async def get_rest_pose_endpoint(user=Depends(get_verified_user)):
    """Get the current rest pose bone data."""
    pose = get_rest_pose()
    return {"bone_count": len(pose), "bones": list(pose.keys())}


@router.post("/blendshapes")
async def send_blendshapes(
    request: BlendshapeRequest, user=Depends(get_verified_user)
):
    """Send blendshape values directly to VSeeFace (for testing)."""
    sender = get_sender()
    sender.send_blendshapes(request.blendshapes)
    return {"status": "sent", "count": len(request.blendshapes)}


# ── Emotion filter ───────────────────────────────────────────────────────


class EmotionTestRequest(BaseModel):
    text: str


@router.post("/emotion/detect")
async def detect_emotion_endpoint(
    request: EmotionTestRequest, user=Depends(get_verified_user)
):
    """Test emotion detection on arbitrary text."""
    emotion = detect_emotion(request.text)
    preset = get_preset_for_emotion(emotion) if emotion else None
    return {"emotion": emotion, "preset": preset}


@router.get("/emotion/mappings")
async def get_emotion_mappings(user=Depends(get_verified_user)):
    """Get the current emotion → preset mapping table."""
    return EMOTION_PRESET_MAP


@router.post("/emotion/filter/install")
async def install_emotion_filter(user=Depends(get_verified_user)):
    """Install the VMC emotion trigger as a global filter function."""
    created = install_filter(user.id)
    if created:
        return {"status": "installed", "id": "vmc_emotion_trigger"}
    return {"status": "already_installed", "id": "vmc_emotion_trigger"}


# ── Starter presets ──────────────────────────────────────────────────────


@router.post("/presets/generate")
async def generate_presets(user=Depends(get_verified_user)):
    """Generate all synthetic starter presets (smile, nod, etc.)."""
    created = generate_starter_presets(overwrite=False)
    return {"status": "ok", "created": created, "count": len(created)}
