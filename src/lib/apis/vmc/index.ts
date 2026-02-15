import { WEBUI_API_BASE_URL } from '$lib/constants';

const VMC_BASE = `${WEBUI_API_BASE_URL}/vmc`;

function headers(token: string) {
	return {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		authorization: `Bearer ${token}`
	};
}

// ── Presets ──────────────────────────────────────────────────────────────

export const getPresets = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/presets`, {
		method: 'GET',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const deletePreset = async (token: string, name: string) => {
	const res = await fetch(`${VMC_BASE}/presets/${encodeURIComponent(name)}`, {
		method: 'DELETE',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Recording ────────────────────────────────────────────────────────────

export const startRecording = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/record/start`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const stopRecording = async (token: string, name: string) => {
	const res = await fetch(`${VMC_BASE}/record/stop`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ name })
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const getRecordingStatus = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/record/status`, {
		method: 'GET',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Playback ─────────────────────────────────────────────────────────────

export const playPreset = async (token: string, name: string, loop: boolean = false) => {
	const res = await fetch(`${VMC_BASE}/play`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ name, loop })
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const stopPlayback = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/play/stop`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const getPlaybackStatus = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/play/status`, {
		method: 'GET',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Idle ──────────────────────────────────────────────────────────────────

export const setIdle = async (token: string, name: string) => {
	const res = await fetch(`${VMC_BASE}/idle/set`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ name })
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const stopIdle = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/idle/stop`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const getIdleStatus = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/idle/status`, {
		method: 'GET',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Direct blendshapes ───────────────────────────────────────────────────

export const sendBlendshapes = async (token: string, blendshapes: Record<string, number>) => {
	const res = await fetch(`${VMC_BASE}/blendshapes`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ blendshapes })
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Emotion ──────────────────────────────────────────────────────────────

export const detectEmotion = async (token: string, text: string) => {
	const res = await fetch(`${VMC_BASE}/emotion/detect`, {
		method: 'POST',
		headers: headers(token),
		body: JSON.stringify({ text })
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const getEmotionMappings = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/emotion/mappings`, {
		method: 'GET',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const installEmotionFilter = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/emotion/filter/install`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const generateStarterPresets = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/presets/generate`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

// ── Rest Pose ────────────────────────────────────────────────────────────

export const applyRestPose = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/rest-pose/apply`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const captureRestPose = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/rest-pose/capture`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};

export const resetRestPose = async (token: string) => {
	const res = await fetch(`${VMC_BASE}/rest-pose/reset`, {
		method: 'POST',
		headers: headers(token)
	});
	if (!res.ok) throw await res.json();
	return res.json();
};
