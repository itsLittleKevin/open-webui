<script lang="ts">
	import { onMount, onDestroy, tick, getContext } from 'svelte';
	import { showVrmAvatar, settings } from '$lib/stores';
	import { updateUserSettings } from '$lib/apis/users';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import {
		getPresets,
		deletePreset,
		startRecording,
		stopRecording,
		getRecordingStatus,
		playPreset,
		stopPlayback,
		getPlaybackStatus,
		installEmotionFilter,
		generateStarterPresets,
		setIdle,
		stopIdle,
		getIdleStatus,
		applyRestPose,
		captureRestPose,
		resetRestPose
	} from '$lib/apis/vmc';

	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	const i18n = getContext<Writable<i18nType>>('i18n');

	let videoEl: HTMLVideoElement;
	let canvasEl: HTMLCanvasElement;
	let stream: MediaStream | null = null;
	let devices: MediaDeviceInfo[] = [];
	let selectedDeviceId: string = '';
	let showDevicePicker = false;
	let showSettingsPanel = false;
	let cameraError = '';
	let refreshingDevices = false;
	let animFrameId: number = 0;

	// WebGL state
	let gl: WebGL2RenderingContext | null = null;
	let glProgram: WebGLProgram | null = null;
	let glTexture: WebGLTexture | null = null;
	let uKeyColor: WebGLUniformLocation | null = null;
	let uTolerance: WebGLUniformLocation | null = null;
	let uSpill: WebGLUniformLocation | null = null;

	// Dragging state
	let overlayEl: HTMLDivElement;
	let dragging = false;
	let dragOffset = { x: 0, y: 0 };
	let pos = { x: -1, y: -1 };

	// Resize
	let overlayWidth = 280;
	let overlayHeight = 280;
	let resizing = false;
	let resizeStart = { x: 0, y: 0, w: 0, h: 0 };

	// Hover-based frame visibility
	let showFrame = false;

	// Settings window state
	let settingsPos = { x: -1, y: -1 };
	let settingsDragging = false;
	let settingsDragOffset = { x: 0, y: 0 };

	// Local settings state (bound to controls, synced to store on change)
	let vrmBgTransparency = 20;
	let vrmBgColor = '#000000';
	let vrmBgBlur = 0;
	let vrmChromaKeyEnabled = true;
	let vrmChromaKeyColor = '#00FF00';
	let vrmChromaKeyTolerance = 100;
	let vrmChromaKeySpill = 50;
	let vrmFrontLayers: Array<{ url: string; opacity: number }> = [];
	let vrmBackLayers: Array<{ url: string; opacity: number }> = [];
	let vrmFrontLayerInput = '';
	let vrmBackLayerInput = '';
	// Gradient transparency
	let vrmBgGradientEnabled = false;

	// VMC Animation state
	let vmcPresets: Array<{ name: string; duration_ms: number; frame_count: number; mode?: string }> = [];
	let vmcRecording = false;
	let vmcRecordName = '';
	let vmcPlaying = false;
	let vmcPlayingName = '';
	let vmcFilterInstalled: boolean | null = null;
	let vmcStatus = '';
	let vmcLoadingPresets = false;
	let vmcGenerating = false;
	let vmcIdleActive = false;
	let vmcIdleName = '';
	let vrmBgGradientAngle = 180;
	let vrmBgGradientStartOpacity = 0;
	let vrmBgGradientMidOpacity = 50;
	let vrmBgGradientEndOpacity = 100;
	let vrmBgGradientMidpoint = 50;

	// Track the object ref we last wrote, so we can distinguish self-updates from external ones
	let _lastWrittenSettings: any = null;

	// Save settings helper — updates store + persists to server
	function saveSettings(updated: Record<string, any>) {
		const merged = { ...$settings, ...updated };
		_lastWrittenSettings = merged;
		settings.set(merged);
		updateUserSettings(localStorage.token, { ui: merged });
	}

	// ── VMC functions ──────────────────────────────────────────────────

	async function vmcLoadPresets() {
		vmcLoadingPresets = true;
		try {
			vmcPresets = await getPresets(localStorage.token);
		} catch (e: any) {
			console.error('Failed to load VMC presets', e);
			vmcPresets = [];
		}
		vmcLoadingPresets = false;
	}

	async function vmcStartRecord() {
		const name = vmcRecordName.trim();
		if (!name) {
			vmcStatus = 'Enter a preset name first';
			return;
		}
		try {
			await startRecording(localStorage.token);
			vmcRecording = true;
			vmcStatus = 'Recording...';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to start recording';
		}
	}

	async function vmcStopRecord() {
		const name = vmcRecordName.trim();
		if (!name) {
			vmcStatus = 'Enter a preset name first';
			return;
		}
		try {
			const result = await stopRecording(localStorage.token, name);
			vmcRecording = false;
			vmcRecordName = '';
			const boneInfo = result.bone_count ? `, ${result.bone_count} bones` : ', no bones';
			vmcStatus = `Saved "${result.name}" (${result.frame_count} frames, ${result.duration_ms}ms${boneInfo})`;
			await vmcLoadPresets();
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to stop recording';
		}
	}

	async function vmcPlay(name: string, loop = false) {
		try {
			await playPreset(localStorage.token, name, loop);
			vmcPlaying = true;
			vmcPlayingName = name;
			vmcStatus = `Playing "${name}"${loop ? ' (loop)' : ''}`;
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to play preset';
		}
	}

	async function vmcStop() {
		try {
			await stopPlayback(localStorage.token);
			vmcPlaying = false;
			vmcPlayingName = '';
			vmcStatus = 'Playback stopped';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to stop playback';
		}
	}

	async function vmcSetIdle(name: string) {
		try {
			await setIdle(localStorage.token, name);
			vmcIdleActive = true;
			vmcIdleName = name;
			vmcStatus = `Idle: "${name}" (looping)`;
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to set idle';
		}
	}

	async function vmcStopIdle() {
		try {
			await stopIdle(localStorage.token);
			vmcIdleActive = false;
			vmcIdleName = '';
			vmcStatus = 'Idle stopped';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to stop idle';
		}
	}

	async function vmcDeletePreset(name: string) {
		try {
			await deletePreset(localStorage.token, name);
			vmcStatus = `Deleted "${name}"`;
			await vmcLoadPresets();
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to delete preset';
		}
	}

	async function vmcInstallFilter() {
		try {
			const result = await installEmotionFilter(localStorage.token);
			vmcFilterInstalled = true;
			vmcStatus = result.status === 'installed' ? 'Emotion filter installed!' : 'Emotion filter already installed';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to install filter';
		}
	}

	async function vmcApplyRestPose() {
		try {
			await applyRestPose(localStorage.token);
			vmcStatus = 'Rest pose applied (arms down)';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to apply rest pose';
		}
	}

	async function vmcCaptureRestPose() {
		try {
			const result = await captureRestPose(localStorage.token);
			vmcStatus = `Rest pose captured (${result.bone_count} bones)`;
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to capture rest pose';
		}
	}

	async function vmcResetRestPose() {
		try {
			await resetRestPose(localStorage.token);
			vmcStatus = 'Rest pose reset to default';
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to reset rest pose';
		}
	}

	async function vmcGenerateStarter() {
		vmcGenerating = true;
		try {
			const result = await generateStarterPresets(localStorage.token);
			if (result.count > 0) {
				vmcStatus = `Generated ${result.count} presets: ${result.created.join(', ')}`;
			} else {
				vmcStatus = 'All starter presets already exist';
			}
			await vmcLoadPresets();
		} catch (e: any) {
			vmcStatus = e?.detail || 'Failed to generate presets';
		}
		vmcGenerating = false;
	}

	// Load VRM settings from store
	function loadVrmSettings() {
		vrmBgTransparency = $settings?.vrmBgTransparency ?? 20;
		vrmBgColor = $settings?.vrmBgColor ?? '#000000';
		vrmBgBlur = $settings?.vrmBgBlur ?? 0;
		vrmChromaKeyEnabled = $settings?.vrmChromaKeyEnabled ?? true;
		vrmChromaKeyColor = $settings?.vrmChromaKeyColor ?? '#00FF00';
		vrmChromaKeyTolerance = $settings?.vrmChromaKeyTolerance ?? 100;
		vrmChromaKeySpill = $settings?.vrmChromaKeySpill ?? 50;
		vrmFrontLayers = $settings?.vrmFrontLayers ?? [];
		vrmBackLayers = $settings?.vrmBackLayers ?? [];
		vrmBgGradientEnabled = $settings?.vrmBgGradientEnabled ?? false;
		vrmBgGradientAngle = $settings?.vrmBgGradientAngle ?? 180;
		vrmBgGradientStartOpacity = $settings?.vrmBgGradientStartOpacity ?? 0;
		vrmBgGradientMidOpacity = $settings?.vrmBgGradientMidOpacity ?? 50;
		vrmBgGradientEndOpacity = $settings?.vrmBgGradientEndOpacity ?? 100;
		vrmBgGradientMidpoint = $settings?.vrmBgGradientMidpoint ?? 50;
	}

	// Re-load VRM settings when the store changes externally (e.g. API fetch on startup)
	// Skip when we caused the change ourselves (same object reference)
	$: if ($settings && $settings !== _lastWrittenSettings) {
		loadVrmSettings();
	}

	// Chroma key derived values (reactive from local state)
	$: chromaEnabled = vrmChromaKeyEnabled;
	$: chromaColor = vrmChromaKeyColor;
	$: chromaTolerance = vrmChromaKeyTolerance;
	$: chromaSpill = vrmChromaKeySpill;

	// Parse chroma key color to normalized RGB [0-1]
	$: chromaR = parseInt(chromaColor.slice(1, 3), 16) / 255;
	$: chromaG = parseInt(chromaColor.slice(3, 5), 16) / 255;
	$: chromaB = parseInt(chromaColor.slice(5, 7), 16) / 255;

	function hexToRgba(hex: string, opacity: number): string {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		const a = opacity / 100;
		return `rgba(${r}, ${g}, ${b}, ${a})`;
	}

	$: overlayBg = vrmBgGradientEnabled
		? `linear-gradient(${vrmBgGradientAngle}deg, ${hexToRgba(vrmBgColor, vrmBgGradientStartOpacity)} 0%, ${hexToRgba(vrmBgColor, vrmBgGradientMidOpacity)} ${vrmBgGradientMidpoint}%, ${hexToRgba(vrmBgColor, vrmBgGradientEndOpacity)} 100%)`
		: hexToRgba(vrmBgColor, 100 - vrmBgTransparency);
	$: overlayBackdrop = vrmBgBlur > 0 ? `blur(${vrmBgBlur}px)` : 'none';
	$: titleBarHeight = showFrame ? 30 : 0;

	// ── WebGL chroma key shader ──────────────────────────────────────────
	const VERT_SRC = `#version 300 es
		in vec2 a_pos;
		in vec2 a_uv;
		out vec2 v_uv;
		void main() {
			v_uv = a_uv;
			gl_Position = vec4(a_pos, 0.0, 1.0);
		}`;

	const FRAG_SRC = `#version 300 es
		precision mediump float;
		in vec2 v_uv;
		uniform sampler2D u_tex;
		uniform vec3 u_keyColor;
		uniform float u_tolerance;
		uniform float u_spill;
		out vec4 fragColor;
		void main() {
			vec4 px = texture(u_tex, v_uv);
			vec3 color = px.rgb;

			// Determine key's dominant channel and compute excess
			float excess, keyExcess, pxMaxOther;

			if (u_keyColor.g >= u_keyColor.r && u_keyColor.g >= u_keyColor.b) {
				// Green key
				pxMaxOther = max(px.r, px.b);
				excess = max(0.0, px.g - pxMaxOther);
				keyExcess = max(0.001, u_keyColor.g - max(u_keyColor.r, u_keyColor.b));
			} else if (u_keyColor.r >= u_keyColor.g && u_keyColor.r >= u_keyColor.b) {
				// Red key
				pxMaxOther = max(px.g, px.b);
				excess = max(0.0, px.r - pxMaxOther);
				keyExcess = max(0.001, u_keyColor.r - max(u_keyColor.g, u_keyColor.b));
			} else {
				// Blue key
				pxMaxOther = max(px.r, px.g);
				excess = max(0.0, px.b - pxMaxOther);
				keyExcess = max(0.001, u_keyColor.b - max(u_keyColor.r, u_keyColor.g));
			}

			// How "key-like" is this pixel (0 = no key color, 1 = pure key)
			float greenness = excess / keyExcess;

			// ── Alpha keying: remove background ──
			// Tolerance maps: 1→conservative (threshold≈1), 200→aggressive (threshold≈0)
			float threshold = 1.0 - u_tolerance / 200.0;
			float softEdge = 0.15;
			float alpha = 1.0 - smoothstep(
				max(threshold - softEdge, 0.0),
				min(threshold + softEdge, 1.0),
				greenness
			);

			if (alpha < 0.004) {
				fragColor = vec4(0.0);
				return;
			}

			// ── Despill: remove key color tint from ALL pixels ──
			// This fixes mesh/net clothing and semi-transparent parts
			// that have key color baked in but are NOT keyed (alpha ≈ 1)
			if (u_spill > 0.0) {
				// How much excess key color this pixel has
				float spillAmount = excess * u_spill * smoothstep(0.0, 0.1, greenness);

				if (u_keyColor.g >= u_keyColor.r && u_keyColor.g >= u_keyColor.b) {
					color.g = max(0.0, color.g - spillAmount);
				} else if (u_keyColor.r >= u_keyColor.g && u_keyColor.r >= u_keyColor.b) {
					color.r = max(0.0, color.r - spillAmount);
				} else {
					color.b = max(0.0, color.b - spillAmount);
				}
			}

			fragColor = vec4(color * alpha, alpha);
		}`;

	function initWebGL() {
		if (!canvasEl) return;
		gl = canvasEl.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
		if (!gl) {
			console.error('WebGL2 not available');
			return;
		}

		// Compile shaders
		const vs = gl.createShader(gl.VERTEX_SHADER)!;
		gl.shaderSource(vs, VERT_SRC);
		gl.compileShader(vs);

		const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
		gl.shaderSource(fs, FRAG_SRC);
		gl.compileShader(fs);

		glProgram = gl.createProgram()!;
		gl.attachShader(glProgram, vs);
		gl.attachShader(glProgram, fs);
		gl.linkProgram(glProgram);
		gl.useProgram(glProgram);

		// Fullscreen quad (two triangles)
		const verts = new Float32Array([
			// pos       uv
			-1, -1,      0, 1,
			 1, -1,      1, 1,
			-1,  1,      0, 0,
			 1,  1,      1, 0,
		]);
		const buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

		const aPos = gl.getAttribLocation(glProgram, 'a_pos');
		const aUv = gl.getAttribLocation(glProgram, 'a_uv');
		gl.enableVertexAttribArray(aPos);
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(aUv);
		gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

		// Texture for video frames
		glTexture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, glTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		// Uniform locations
		uKeyColor = gl.getUniformLocation(glProgram, 'u_keyColor');
		uTolerance = gl.getUniformLocation(glProgram, 'u_tolerance');
		uSpill = gl.getUniformLocation(glProgram, 'u_spill');

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	}

	function destroyWebGL() {
		if (gl && glProgram) {
			gl.deleteProgram(glProgram);
			glProgram = null;
		}
		if (gl && glTexture) {
			gl.deleteTexture(glTexture);
			glTexture = null;
		}
		gl = null;
	}

	function renderChromaFrame() {
		if (!videoEl || !gl || !glProgram || videoEl.paused || videoEl.ended || !videoEl.videoWidth) {
			animFrameId = requestAnimationFrame(renderChromaFrame);
			return;
		}

		try {
			// Match canvas to video dimensions
			if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
				canvasEl.width = videoEl.videoWidth;
				canvasEl.height = videoEl.videoHeight;
				gl.viewport(0, 0, canvasEl.width, canvasEl.height);
			}

			// Upload video frame to GPU texture
			gl.bindTexture(gl.TEXTURE_2D, glTexture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);

			// Set uniforms
			gl.uniform3f(uKeyColor, chromaR, chromaG, chromaB);
			gl.uniform1f(uTolerance, chromaTolerance);
			gl.uniform1f(uSpill, chromaSpill / 100);

			// Clear and draw
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		} catch (e) {
			console.warn('renderChromaFrame error:', e);
		}

		animFrameId = requestAnimationFrame(renderChromaFrame);
	}

	function startChromaLoop() {
		if (!gl && canvasEl) initWebGL();
		if (animFrameId) cancelAnimationFrame(animFrameId);
		animFrameId = requestAnimationFrame(renderChromaFrame);
	}

	function stopChromaLoop() {
		if (animFrameId) {
			cancelAnimationFrame(animFrameId);
			animFrameId = 0;
		}
		destroyWebGL();
	}

	async function enumerateDevices() {
		try {
			// First try enumerating without requesting a stream —
			// if permission is already granted, labels will be populated
			let allDevices = await navigator.mediaDevices.enumerateDevices();
			let videoDevices = allDevices.filter((d) => d.kind === 'videoinput');

			// If labels are empty, we need to request permission first
			const labelsEmpty = videoDevices.length > 0 && videoDevices.every((d) => !d.label);
			if (labelsEmpty) {
				try {
					const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
					tempStream.getTracks().forEach((t) => t.stop());
					// Re-enumerate now that permission is granted
					allDevices = await navigator.mediaDevices.enumerateDevices();
					videoDevices = allDevices.filter((d) => d.kind === 'videoinput');
				} catch (_) {
					// Permission denied — proceed with unlabeled devices
				}
			}

			const prevSelected = selectedDeviceId;
			devices = videoDevices;

			// Auto-select VSeeFace camera if available and nothing is selected
			// (or if the previously selected device disappeared)
			const prevStillExists = devices.some((d) => d.deviceId === prevSelected);
			if (devices.length > 0 && (!prevSelected || !prevStillExists)) {
				const lowerLabels = [
					'vseefacecamera', 'vseeface', 'unitycapture',
					'obs virtual', 'virtual cam', 'virtualcam'
				];
				const vsf = devices.find((d) => {
					const label = d.label.toLowerCase();
					return lowerLabels.some((kw) => label.includes(kw));
				});
				selectedDeviceId = vsf ? vsf.deviceId : devices[0].deviceId;
			}
		} catch (e) {
			console.error('Failed to enumerate devices', e);
		}
	}

	// Auto-refresh when devices change (e.g., VSeeFace starts virtual cam)
	function onDeviceChange() {
		enumerateDevices();
	}

	async function startStream() {
		cameraError = '';
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
		}
		stopChromaLoop();
		if (!selectedDeviceId) {
			return;
		}
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { deviceId: { exact: selectedDeviceId }, width: 640, height: 640 },
				audio: false
			});
			// Wait for Svelte to render the video element, then assign the stream
			await tick();
			if (videoEl) {
				videoEl.srcObject = stream;
				if (chromaEnabled) {
					startChromaLoop();
				}
			}
		} catch (e: any) {
			cameraError = e?.message || 'Camera access denied';
			console.error('Camera error:', e);
		}
	}

	function stopStream() {
		stopChromaLoop();
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
		}
	}

	// Drag handlers
	function onMouseDown(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('.no-drag')) return;
		dragging = true;
		dragOffset = { x: e.clientX - pos.x, y: e.clientY - pos.y };
		e.preventDefault();
	}

	function onMouseMove(e: MouseEvent) {
		if (dragging) {
			pos = {
				x: Math.max(0, Math.min(window.innerWidth - overlayWidth, e.clientX - dragOffset.x)),
				y: Math.max(0, Math.min(window.innerHeight - overlayHeight, e.clientY - dragOffset.y))
			};
		}
		if (settingsDragging) {
			settingsPos = {
				x: Math.max(0, Math.min(window.innerWidth - 320, e.clientX - settingsDragOffset.x)),
				y: Math.max(0, Math.min(window.innerHeight - 100, e.clientY - settingsDragOffset.y))
			};
		}
		if (resizing) {
			const dw = e.clientX - resizeStart.x;
			const dh = e.clientY - resizeStart.y;
			overlayWidth = Math.max(160, Math.min(640, resizeStart.w + dw));
			overlayHeight = Math.max(160, Math.min(640, resizeStart.h + dh));
		}
	}

	function onMouseUp() {
		dragging = false;
		settingsDragging = false;
		resizing = false;
	}

	function onResizeStart(e: MouseEvent) {
		resizing = true;
		resizeStart = { x: e.clientX, y: e.clientY, w: overlayWidth, h: overlayHeight };
		e.preventDefault();
		e.stopPropagation();
	}

	// React to chroma key toggle changes while stream is live
	$: if (stream && chromaEnabled) {
		startChromaLoop();
	} else if (!chromaEnabled) {
		stopChromaLoop();
	}

	// Reactivity: start/stop stream when visibility or device changes
	$: if ($showVrmAvatar && selectedDeviceId) {
		startStream();
	} else {
		stopStream();
	}

	onMount(async () => {
		await enumerateDevices();
		// Default position: bottom-right
		pos = {
			x: window.innerWidth - overlayWidth - 24,
			y: window.innerHeight - overlayHeight - 24
		};
		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
		navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
	});

	onDestroy(() => {
		stopChromaLoop();
		stopStream();
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
			navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
		}
	});
</script>

{#if $showVrmAvatar}
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		bind:this={overlayEl}
		class="fixed z-50 overflow-hidden shadow-2xl select-none"
		class:rounded-2xl={showFrame}
		class:rounded-xl={!showFrame}
		style="left: {pos.x}px; top: {pos.y}px; width: {overlayWidth}px; height: {overlayHeight}px; background: {overlayBg}; backdrop-filter: {overlayBackdrop}; border: {showFrame ? '1px solid rgba(128,128,128,0.3)' : 'none'};"
		on:mousedown={onMouseDown}
		on:mouseenter={() => { showFrame = true; }}
		on:mouseleave={() => { if (!showDevicePicker) showFrame = false; }}
	>
		<!-- Title bar (overlay, conditionally visible) -->
		{#if showFrame}
		<div
			class="absolute top-0 left-0 right-0 flex items-center justify-between px-3 py-1.5 bg-gray-900/90 cursor-move text-white text-xs"
			style="z-index: 15; transition: opacity 0.15s ease;"
		>
			<span class="font-medium opacity-80">VRM Avatar</span>
			<div class="flex items-center gap-1.5 no-drag">
				<!-- Camera select -->
				<Tooltip content={$i18n.t('Select Camera')}>
					<button
						class="p-1 rounded hover:bg-gray-700 transition"
						on:click={() => {
							showDevicePicker = !showDevicePicker;
							showSettingsPanel = false;
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 20 20"
							fill="currentColor"
							class="w-3.5 h-3.5"
						>
							<path
								d="M3.25 4A2.25 2.25 0 0 0 1 6.25v7.5A2.25 2.25 0 0 0 3.25 16h7.5A2.25 2.25 0 0 0 13 13.75v-1.956l3.214 1.607A.75.75 0 0 0 17.25 12.75v-5.5a.75.75 0 0 0-1.036-.693L13 8.206V6.25A2.25 2.25 0 0 0 10.75 4h-7.5Z"
							/>
						</svg>
					</button>
				</Tooltip>
				<!-- Settings -->
				<Tooltip content={$i18n.t('Settings')}>
					<button
						class="p-1 rounded hover:bg-gray-700 transition {showSettingsPanel ? 'bg-gray-700' : ''}"
						on:click={() => {
							showSettingsPanel = !showSettingsPanel;
							showDevicePicker = false;
							if (showSettingsPanel) {
								vmcLoadPresets();
								// Position to the left of the overlay, or right if not enough space
								const sw = 320;
								const gap = 12;
								const leftX = pos.x - sw - gap;
								if (leftX >= 0) {
									settingsPos = { x: leftX, y: pos.y };
								} else {
									settingsPos = { x: pos.x + overlayWidth + gap, y: pos.y };
								}
							}
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 20 20"
							fill="currentColor"
							class="w-3.5 h-3.5"
						>
							<path fill-rule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd" />
						</svg>
					</button>
				</Tooltip>
				<!-- Close button -->
				<button
					class="p-1 rounded hover:bg-gray-700 transition"
					on:click={() => showVrmAvatar.set(false)}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 16 16"
						fill="currentColor"
						class="w-3.5 h-3.5"
					>
						<path
							d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z"
						/>
					</svg>
				</button>
			</div>
		</div>
		{/if}

		<!-- Device picker dropdown -->
		{#if showDevicePicker}
			<div class="absolute left-0 right-0 bg-gray-900/95 border-b border-gray-700 z-10 no-drag" style="top: {titleBarHeight}px;">
				<div class="p-2 flex flex-col gap-1 max-h-48 overflow-y-auto">
					<!-- Refresh button -->
					<button
						class="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded transition text-blue-400 hover:bg-gray-700 mb-0.5"
						on:click={async () => {
							refreshingDevices = true;
							await enumerateDevices();
							refreshingDevices = false;
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 16 16"
							fill="currentColor"
							class="w-3 h-3 {refreshingDevices ? 'animate-spin' : ''}"
						>
							<path fill-rule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.681.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-.908l.84.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44.908l-.84-.84v1.68a.75.75 0 0 1-1.5 0V9.567a.75.75 0 0 1 .75-.75h3.182a.75.75 0 0 1 0 1.5h-1.37l.84.841a4.5 4.5 0 0 0 7.08-.681.75.75 0 0 1 1.024-.274Z" clip-rule="evenodd" />
						</svg>
						{$i18n.t('Refresh Devices')}
					</button>
					{#each devices as device}
						<button
							class="text-left text-xs px-2 py-1.5 rounded transition truncate {selectedDeviceId ===
							device.deviceId
								? 'bg-blue-600 text-white'
								: 'text-gray-300 hover:bg-gray-700'}"
							on:click={() => {
								selectedDeviceId = device.deviceId;
								showDevicePicker = false;
							}}
						>
							{device.label || `Camera ${devices.indexOf(device) + 1}`}
						</button>
					{/each}
					{#if devices.length === 0}
						<div class="text-xs text-gray-500 px-2 py-1">{$i18n.t('No cameras found')}</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Video area -->
		<div class="relative w-full h-full">
			<!-- Back layers (behind video) -->
			{#each vrmBackLayers as layer}
				{#if layer.url}
					<img
						src={layer.url}
						alt=""
						class="absolute inset-0 w-full h-full object-cover pointer-events-none"
						style="opacity: {layer.opacity / 100}; z-index: 0;"
					/>
				{/if}
			{/each}

			{#if cameraError}
				<div
					class="flex items-center justify-center h-full text-xs text-red-400 px-4 text-center"
					style="z-index: 1; position: relative;"
				>
					{cameraError}
				</div>
			{:else if !stream}
				<div class="flex items-center justify-center h-full text-xs text-gray-500" style="z-index: 1; position: relative;">
					{$i18n.t('Select a camera to preview your VRM avatar')}
				</div>
			{:else}
				<!-- Hidden video source for chroma key processing -->
				<!-- svelte-ignore a11y-media-has-caption -->
				<video
					bind:this={videoEl}
					autoplay
					playsinline
					muted
					class="{chromaEnabled ? 'hidden' : 'w-full h-full object-cover'}"
					style="z-index: 1; position: relative;"
				/>
				<canvas
					bind:this={canvasEl}
					class="w-full h-full object-cover {chromaEnabled ? '' : 'hidden'}"
					style="z-index: 1; position: relative;"
				/>
			{/if}

			<!-- Front layers (above video) -->
			{#each vrmFrontLayers as layer}
				{#if layer.url}
					<img
						src={layer.url}
						alt=""
						class="absolute inset-0 w-full h-full object-cover pointer-events-none"
						style="opacity: {layer.opacity / 100}; z-index: 2;"
					/>
				{/if}
			{/each}
		</div>

		<!-- Resize handle -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize no-drag"
			style="z-index: 10;"
			on:mousedown={onResizeStart}
		>
			<svg
				class="w-3 h-3 text-gray-400 m-0.5"
				fill="currentColor"
				viewBox="0 0 12 12"
			>
				<circle cx="9" cy="9" r="1.5" />
				<circle cx="5" cy="9" r="1.5" />
				<circle cx="9" cy="5" r="1.5" />
			</svg>
		</div>
	</div>

	<!-- ── Separate Settings Window ──────────────────────────────────── -->
	{#if showSettingsPanel}
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="fixed z-[51] bg-gray-900/95 border border-gray-700 rounded-xl shadow-2xl select-none text-white"
			style="left: {settingsPos.x}px; top: {settingsPos.y}px; width: 320px; max-height: 560px; display: flex; flex-direction: column;"
			on:mousedown={(e) => {
				if ((e.target).closest('.no-drag')) return;
				settingsDragging = true;
				settingsDragOffset = { x: e.clientX - settingsPos.x, y: e.clientY - settingsPos.y };
				e.preventDefault();
			}}
		>
			<!-- Title bar -->
			<div class="flex items-center justify-between px-3 py-2 border-b border-gray-700 cursor-move shrink-0">
				<span class="text-xs font-semibold opacity-80">{$i18n.t('VRM Settings')}</span>
				<button
					class="p-1 rounded hover:bg-gray-700 transition no-drag"
					on:click={() => { showSettingsPanel = false; }}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
						<path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
					</svg>
				</button>
			</div>

			<!-- Scrollable content -->
			<div class="p-3 flex flex-col gap-2 overflow-y-auto no-drag" style="max-height: 520px;">
				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{$i18n.t('Appearance')}</div>

				<!-- Background Color -->
				<div class="flex w-full justify-between items-center">
					<div class="text-xs">{$i18n.t('Background Color')}</div>
					<input type="color" bind:value={vrmBgColor} class="w-6 h-6 rounded cursor-pointer border border-gray-600" on:input={() => saveSettings({ vrmBgColor })} />
				</div>

				<!-- Background Transparency (flat) -->
				{#if !vrmBgGradientEnabled}
				<div>
					<div class="flex w-full justify-between items-center">
						<div class="text-xs">{$i18n.t('Background Transparency')}</div>
						<span class="text-xs text-gray-400 w-8 text-right">{vrmBgTransparency}%</span>
					</div>
					<input type="range" min="0" max="100" step="1" class="w-full mt-1" bind:value={vrmBgTransparency} on:change={() => saveSettings({ vrmBgTransparency })} />
				</div>
				{/if}

				<!-- Gradient Toggle -->
				<div class="flex w-full justify-between items-center">
					<div class="text-xs">{$i18n.t('Gradient Transparency')}</div>
					<Switch bind:state={vrmBgGradientEnabled} on:change={() => saveSettings({ vrmBgGradientEnabled })} />
				</div>

				<!-- Gradient Controls -->
				{#if vrmBgGradientEnabled}
				<div class="pl-2 border-l-2 border-gray-700 flex flex-col gap-1.5">
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Angle')}</div>
							<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientAngle}°</span>
						</div>
						<input type="range" min="0" max="360" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientAngle} on:change={() => saveSettings({ vrmBgGradientAngle })} />
					</div>
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Start Opacity')}</div>
							<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientStartOpacity}%</span>
						</div>
						<input type="range" min="0" max="100" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientStartOpacity} on:change={() => saveSettings({ vrmBgGradientStartOpacity })} />
					</div>
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Mid Opacity')}</div>
							<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientMidOpacity}%</span>
						</div>
						<input type="range" min="0" max="100" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientMidOpacity} on:change={() => saveSettings({ vrmBgGradientMidOpacity })} />
					</div>
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('End Opacity')}</div>
							<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientEndOpacity}%</span>
						</div>
						<input type="range" min="0" max="100" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientEndOpacity} on:change={() => saveSettings({ vrmBgGradientEndOpacity })} />
					</div>
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Midpoint Position')}</div>
							<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientMidpoint}%</span>
						</div>
						<input type="range" min="0" max="100" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientMidpoint} on:change={() => saveSettings({ vrmBgGradientMidpoint })} />
					</div>
				</div>
				{/if}

				<!-- Background Blur -->
				<div>
					<div class="flex w-full justify-between items-center">
						<div class="text-xs">{$i18n.t('Background Blur')}</div>
						<span class="text-xs text-gray-400 w-10 text-right">{vrmBgBlur}px</span>
					</div>
					<input type="range" min="0" max="20" step="1" class="w-full mt-1" bind:value={vrmBgBlur} on:change={() => saveSettings({ vrmBgBlur })} />
				</div>

				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-2 mb-1">{$i18n.t('Chroma Key')}</div>

				<!-- Chroma Key Toggle -->
				<div class="flex w-full justify-between items-center">
					<div class="text-xs">{$i18n.t('Chroma Key (Green Screen)')}</div>
					<Switch bind:state={vrmChromaKeyEnabled} on:change={() => saveSettings({ vrmChromaKeyEnabled })} />
				</div>

				{#if vrmChromaKeyEnabled}
				<!-- Key Color -->
				<div class="flex w-full justify-between items-center">
					<div class="text-xs">{$i18n.t('Key Color')}</div>
					<input type="color" bind:value={vrmChromaKeyColor} class="w-6 h-6 rounded cursor-pointer border border-gray-600" on:input={() => saveSettings({ vrmChromaKeyColor })} />
				</div>

				<!-- Tolerance -->
				<div>
					<div class="flex w-full justify-between items-center">
						<div class="text-xs">{$i18n.t('Tolerance')}</div>
						<span class="text-xs text-gray-400 w-8 text-right">{vrmChromaKeyTolerance}</span>
					</div>
					<input type="range" min="1" max="200" step="1" class="w-full mt-1" bind:value={vrmChromaKeyTolerance} on:change={() => saveSettings({ vrmChromaKeyTolerance })} />
				</div>

				<!-- Spill Suppression -->
				<div>
					<div class="flex w-full justify-between items-center">
						<div class="text-xs">{$i18n.t('Spill Suppression')}</div>
						<span class="text-xs text-gray-400 w-8 text-right">{vrmChromaKeySpill}</span>
					</div>
					<input type="range" min="0" max="500" step="1" class="w-full mt-1" bind:value={vrmChromaKeySpill} on:change={() => saveSettings({ vrmChromaKeySpill })} />
				</div>
				{/if}

				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-2 mb-1">{$i18n.t('Layers')}</div>

				<!-- Back Layers -->
				<div>
					<div class="text-xs font-medium mb-1">{$i18n.t('Background Layers (Behind Video)')}</div>
					<div class="flex flex-col gap-1">
						{#each vrmBackLayers as layer, idx}
							<div class="flex items-center gap-1.5">
								<input type="text" class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0" placeholder="Image URL" bind:value={layer.url} on:change={() => saveSettings({ vrmBackLayers })} />
								<input type="range" min="0" max="100" step="1" class="w-12" bind:value={layer.opacity} on:change={() => saveSettings({ vrmBackLayers })} />
								<span class="text-xs text-gray-400 w-7">{layer.opacity}%</span>
								<button type="button" class="p-0.5 rounded hover:bg-gray-700 text-red-400" on:click={() => { vrmBackLayers = vrmBackLayers.filter((_, i) => i !== idx); saveSettings({ vrmBackLayers }); }}>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3"><path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" /></svg>
								</button>
							</div>
						{/each}
						<div class="flex items-center gap-1.5">
							<input type="text" class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0" placeholder={$i18n.t('Paste image URL')} bind:value={vrmBackLayerInput} />
							<button type="button" class="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700" on:click={() => { if (vrmBackLayerInput.trim()) { vrmBackLayers = [...vrmBackLayers, { url: vrmBackLayerInput.trim(), opacity: 100 }]; vrmBackLayerInput = ''; saveSettings({ vrmBackLayers }); } }}>{$i18n.t('Add')}</button>
						</div>
					</div>
				</div>

				<!-- Front Layers -->
				<div>
					<div class="text-xs font-medium mb-1 mt-1">{$i18n.t('Foreground Layers (Above Video)')}</div>
					<div class="flex flex-col gap-1">
						{#each vrmFrontLayers as layer, idx}
							<div class="flex items-center gap-1.5">
								<input type="text" class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0" placeholder="Image URL" bind:value={layer.url} on:change={() => saveSettings({ vrmFrontLayers })} />
								<input type="range" min="0" max="100" step="1" class="w-12" bind:value={layer.opacity} on:change={() => saveSettings({ vrmFrontLayers })} />
								<span class="text-xs text-gray-400 w-7">{layer.opacity}%</span>
								<button type="button" class="p-0.5 rounded hover:bg-gray-700 text-red-400" on:click={() => { vrmFrontLayers = vrmFrontLayers.filter((_, i) => i !== idx); saveSettings({ vrmFrontLayers }); }}>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3"><path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" /></svg>
								</button>
							</div>
						{/each}
						<div class="flex items-center gap-1.5">
							<input type="text" class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0" placeholder={$i18n.t('Paste image URL')} bind:value={vrmFrontLayerInput} />
							<button type="button" class="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700" on:click={() => { if (vrmFrontLayerInput.trim()) { vrmFrontLayers = [...vrmFrontLayers, { url: vrmFrontLayerInput.trim(), opacity: 100 }]; vrmFrontLayerInput = ''; saveSettings({ vrmFrontLayers }); } }}>{$i18n.t('Add')}</button>
						</div>
					</div>
				</div>

				<!-- ── VMC Animations ────────────────────────────────── -->
				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-2 mb-1">{$i18n.t('VMC Animations')}</div>

				<!-- Status bar -->
				{#if vmcStatus}
					<div class="text-xs text-blue-400 bg-blue-900/30 rounded px-2 py-1 break-words">{vmcStatus}</div>
				{/if}

				<!-- Rest Pose -->
				<div class="flex flex-col gap-1.5">
					<div class="text-xs font-medium">{$i18n.t('Rest Pose (Arms Down)')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Keeps arms at sides instead of T-pose')}</div>
					<div class="flex gap-1.5">
						<button type="button" class="text-xs px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-700 text-white flex-1" on:click={vmcApplyRestPose}>
							{$i18n.t('Apply Now')}
						</button>
						<button type="button" class="text-xs px-2 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white flex-1" on:click={vmcCaptureRestPose}>
							{$i18n.t('Capture')}
						</button>
						<button type="button" class="text-xs px-2 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white" on:click={vmcResetRestPose}>
							{$i18n.t('Reset')}
						</button>
					</div>
				</div>

				<!-- Recording -->
				<div class="flex flex-col gap-1.5">
					<div class="text-xs font-medium">{$i18n.t('Record Animation')}</div>
					<div class="flex items-center gap-1.5">
						<input
							type="text"
							class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0"
							placeholder={$i18n.t('Preset name')}
							bind:value={vmcRecordName}
						/>
						{#if !vmcRecording}
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 flex items-center gap-1"
								on:click={vmcStartRecord}
							>
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3">
									<circle cx="8" cy="8" r="5" />
								</svg>
								{$i18n.t('Rec')}
							</button>
						{:else}
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-yellow-600 text-white hover:bg-yellow-700 flex items-center gap-1 animate-pulse"
								on:click={vmcStopRecord}
							>
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3">
									<rect x="4" y="4" width="8" height="8" rx="1" />
								</svg>
								{$i18n.t('Stop')}
							</button>
						{/if}
					</div>
				</div>

				<!-- Idle status -->
				{#if vmcIdleActive}
					<div class="flex items-center justify-between bg-indigo-900/40 rounded px-2 py-1.5">
						<div class="flex items-center gap-1.5">
							<span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
							<span class="text-xs text-indigo-300">{$i18n.t('Idle')}: {vmcIdleName}</span>
						</div>
						<button
							type="button"
							class="text-xs text-red-400 hover:text-red-300"
							on:click={vmcStopIdle}
						>
							{$i18n.t('Stop')}
						</button>
					</div>
				{/if}

				<!-- Presets list -->
				<div class="flex flex-col gap-1">
					<div class="flex items-center justify-between">
						<div class="text-xs font-medium">{$i18n.t('Saved Presets')}</div>
						<button
							type="button"
							class="text-xs text-blue-400 hover:text-blue-300"
							on:click={vmcLoadPresets}
						>
							{vmcLoadingPresets ? $i18n.t('Loading...') : $i18n.t('Refresh')}
						</button>
					</div>

					{#if vmcPresets.length === 0}
						<div class="text-xs text-gray-500 py-1">{$i18n.t('No presets yet. Generate starters or record your own.')}</div>
					{/if}

					<!-- Generate starter presets button -->
					<button
						type="button"
						class="text-xs px-2 py-1.5 rounded text-white w-full {vmcGenerating ? 'bg-gray-600 cursor-wait' : 'bg-teal-600 hover:bg-teal-700'}"
						on:click={vmcGenerateStarter}
						disabled={vmcGenerating}
					>
						{vmcGenerating ? $i18n.t('Generating...') : $i18n.t('Generate Starter Presets')}
					</button>

					{#each vmcPresets as preset}
						<div class="flex items-center gap-1.5 bg-gray-800/50 rounded px-2 py-1.5">
							<div class="flex-1 min-w-0">
								<div class="text-xs font-medium truncate">{preset.name}</div>
								<div class="text-[10px] text-gray-500">{preset.frame_count} frames &middot; {(preset.duration_ms / 1000).toFixed(1)}s &middot; {preset.mode ?? 'absolute'}</div>
							</div>
							<!-- Set as Idle button -->
							<Tooltip content={vmcIdleName === preset.name ? $i18n.t('Active Idle') : $i18n.t('Set as Idle')}>
								<button
									type="button"
									class="p-1 rounded hover:bg-gray-700 {vmcIdleName === preset.name ? 'text-indigo-400' : 'text-gray-400'}"
									on:click={() => vmcSetIdle(preset.name)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
										<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.5 3a.5.5 0 0 1 1 0v4a.5.5 0 0 1-.276.447l-2 1a.5.5 0 1 1-.448-.894L7.5 7.618V4Z" />
									</svg>
								</button>
							</Tooltip>
							<!-- Play button (action on top of idle) -->
							<Tooltip content={$i18n.t('Play')}>
								<button
									type="button"
									class="p-1 rounded hover:bg-gray-700 text-green-400"
									on:click={() => vmcPlay(preset.name)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
										<path d="M3 3.732a1.5 1.5 0 0 1 2.305-1.265l6.706 4.267a1.5 1.5 0 0 1 0 2.531l-6.706 4.268A1.5 1.5 0 0 1 3 12.267V3.732Z" />
									</svg>
								</button>
							</Tooltip>
							<!-- Loop button -->
							<Tooltip content={$i18n.t('Loop')}>
								<button
									type="button"
									class="p-1 rounded hover:bg-gray-700 text-blue-400"
									on:click={() => vmcPlay(preset.name, true)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
										<path fill-rule="evenodd" d="M8 1a.75.75 0 0 1 .75.75V3h3.5A2.75 2.75 0 0 1 15 5.75v4.5A2.75 2.75 0 0 1 12.25 13h-3.5v1.25a.75.75 0 0 1-1.5 0V13h-3.5A2.75 2.75 0 0 1 1 10.25v-4.5A2.75 2.75 0 0 1 3.75 3h3.5V1.75A.75.75 0 0 1 8 1ZM3.75 4.5c-.69 0-1.25.56-1.25 1.25v4.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25v-4.5c0-.69-.56-1.25-1.25-1.25h-8.5Z" clip-rule="evenodd" />
									</svg>
								</button>
							</Tooltip>
							<!-- Delete button -->
							<Tooltip content={$i18n.t('Delete')}>
								<button
									type="button"
									class="p-1 rounded hover:bg-gray-700 text-red-400"
									on:click={() => vmcDeletePreset(preset.name)}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
										<path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5A.75.75 0 0 1 9.95 6Z" clip-rule="evenodd" />
									</svg>
								</button>
							</Tooltip>
						</div>
					{/each}

					<!-- Stop playback button -->
					{#if vmcPlaying}
						<button
							type="button"
							class="text-xs px-2 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 flex items-center gap-1 w-full justify-center"
							on:click={vmcStop}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3">
								<rect x="4" y="4" width="8" height="8" rx="1" />
							</svg>
							{$i18n.t('Stop Action')}
						</button>
					{/if}
				</div>

				<!-- Emotion filter -->
				<div class="flex flex-col gap-1.5 mt-1">
					<div class="text-xs font-medium">{$i18n.t('Emotion Filter')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Auto-trigger animations based on LLM response emotion')}</div>
					<button
						type="button"
						class="text-xs px-2 py-1.5 rounded text-white w-full {vmcFilterInstalled ? 'bg-green-700 cursor-default' : 'bg-purple-600 hover:bg-purple-700'}"
						on:click={vmcInstallFilter}
						disabled={vmcFilterInstalled === true}
					>
						{vmcFilterInstalled ? $i18n.t('Filter Installed ✓') : $i18n.t('Install Emotion Filter')}
					</button>
				</div>
			</div>
		</div>
	{/if}
{/if}
