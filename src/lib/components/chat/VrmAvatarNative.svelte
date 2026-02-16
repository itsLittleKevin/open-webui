<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher, getContext } from 'svelte';
	import VrmRenderer from './VrmRenderer.svelte';
	import { getLipSyncEngine, type LipSyncState, type Viseme } from '$lib/utils/lipSync';
	import { 
		getFaceTrackingEngine, 
		MovementRecorder, 
		type FaceTrackingState,
		type RecordedAnimation 
	} from '$lib/utils/faceTracking';
	import * as THREE from 'three';
	import type { VRM } from '@pixiv/three-vrm';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	const dispatch = createEventDispatcher();
	const i18n = getContext<Writable<i18nType>>('i18n');

	// Props
	export let width = 280;
	export let height = 280;
	export let backgroundColor = '#000000';
	export let backgroundAlpha = 0.2;
	
	// Focal length (mm) - 70-240mm range, higher = more telephoto
	export let focalLength = 135;
	
	// VRM file
	export let vrmFile: File | null = null;
	
	// Idle animation (optional JSON)
	export let idleAnimation: RecordedAnimation | null = null;
	
	// Settings
	export let enableLipSync = true;
	export let enableFaceTracking = false;
	export let showControls = true;
	
	// Shader/Lighting props
	export let mainLightIntensity = 1.0;
	export let ambientLightIntensity = 0.4;
	export let rimLightIntensity = 0.5;
	export let gammaCorrection = 1.0;
	export let toneMappingExposure = 1.0;
	export let contrast = 1.0;
	export let saturation = 1.0;
	
	// MToon shader enhancements
	export let matcapIntensity = 0.5;
	export let rimFresnelPower = 3.0;
	export let rimLift = 0.3;
	
	// Rest pose - arms down instead of T-pose
	export let restPose = true;

	// State
	let vrmRef: VrmRenderer;
	let vrm: VRM | null = null;
	let loading = false;
	let error = '';
	let loadProgress = 0;

	// Lip sync
	const lipSyncEngine = getLipSyncEngine();
	let lipSyncActive = false;
	let currentViseme: Viseme = 'neutral';
	let currentVolume = 0;

	// Face tracking
	const faceTrackingEngine = getFaceTrackingEngine();
	let faceTrackingActive = false;
	let webcamStream: MediaStream | null = null;
	let webcamVideoEl: HTMLVideoElement | null = null;

	// Movement recording
	let recorder: MovementRecorder | null = null;
	let isRecording = false;
	let recordedFrameCount = 0;

	// Idle animation playback
	let idleFrameIndex = 0;
	let idleAnimationTimer: number = 0;
	
	// One-shot animation playback control
	let isPlayingAnimation = false;
	let animationCancelRequested = false;
	let currentAnimationResolve: (() => void) | null = null;
	let idleWasPlayingBeforeAnimation = false;  // Track if we should resume idle after animation

	// Background color conversion
	$: bgColorNum = parseInt(backgroundColor.replace('#', ''), 16);

	// ── VRM Loading ────────────────────────────────────────────────────

	$: if (vrmFile && vrmRef) {
		loadVRM(vrmFile);
	}

	async function loadVRM(file: File) {
		try {
			await vrmRef.loadVRM(file);
		} catch (e: any) {
			console.error('Failed to load VRM:', e);
		}
	}

	function handleVrmLoaded(event: CustomEvent<{ vrm: VRM }>) {
		vrm = event.detail.vrm;
		dispatch('loaded', { vrm });
		
		// Start idle animation if available
		if (idleAnimation) {
			startIdleAnimation();
		}
	}

	function handleProgress(event: CustomEvent<{ percent: number }>) {
		loadProgress = event.detail.percent;
	}

	// ── Reactive Idle Animation ────────────────────────────────────────
	// Restart idle animation when the idleAnimation prop changes
	let prevIdleAnimationName: string | null = null;

	$: if (vrm && vrmRef && idleAnimation) {
		if (idleAnimation.name !== prevIdleAnimationName) {
			stopIdleAnimation();
			startIdleAnimation();
			prevIdleAnimationName = idleAnimation.name;
		}
	} else if (vrm && !idleAnimation && prevIdleAnimationName) {
		stopIdleAnimation();
		prevIdleAnimationName = null;
	}

	// ── Lip Sync ───────────────────────────────────────────────────────

	/**
	 * Start lip sync for an audio element
	 */
	export async function startLipSync(audioElement: HTMLAudioElement) {
		if (!enableLipSync || !vrm) return;

		try {
			await lipSyncEngine.connectAudioElement(audioElement);
			lipSyncEngine.start(handleLipSyncUpdate);
			lipSyncActive = true;
		} catch (e) {
			console.error('[lip-sync] Failed to start lip sync:', e);
		}
	}

	/**
	 * Start lip sync for audio buffer data
	 */
	export async function startLipSyncFromBuffer(audioBuffer: ArrayBuffer): Promise<AudioBufferSourceNode | null> {
		if (!enableLipSync || !vrm) return null;

		try {
			const decoded = await lipSyncEngine.decodeAudioData(audioBuffer);
			const source = await lipSyncEngine.connectAudioBuffer(decoded);
			lipSyncEngine.start(handleLipSyncUpdate);
			lipSyncActive = true;
			return source;
		} catch (e) {
			console.error('Failed to start lip sync from buffer:', e);
			return null;
		}
	}

	/**
	 * Stop lip sync
	 */
	export function stopLipSync() {
		lipSyncEngine.stop();
		lipSyncActive = false;
		currentViseme = 'neutral';
		currentVolume = 0;
		
		// Clear lip sync layer so base layer shows through
		if (vrmRef && vrm) {
			vrmRef.clearLipSync();
		}
	}

	function handleLipSyncUpdate(state: LipSyncState) {
		currentViseme = state.viseme;
		currentVolume = state.volume;

		if (vrmRef && vrm) {
			vrmRef.setViseme(state.viseme, state.mouthOpen);
		}
	}

	// ── Face Tracking ──────────────────────────────────────────────────

	/**
	 * Start face tracking from webcam
	 */
	export async function startFaceTracking(): Promise<void> {
		if (faceTrackingActive) return;

		try {
			// Get webcam stream
			webcamStream = await navigator.mediaDevices.getUserMedia({
				video: { width: 640, height: 480, facingMode: 'user' },
				audio: false
			});

			// Create hidden video element
			webcamVideoEl = document.createElement('video');
			webcamVideoEl.srcObject = webcamStream;
			webcamVideoEl.autoplay = true;
			webcamVideoEl.playsInline = true;
			webcamVideoEl.muted = true;

			// Wait for video to be ready
			await new Promise<void>((resolve) => {
				webcamVideoEl!.onloadedmetadata = () => {
					webcamVideoEl!.play();
					resolve();
				};
			});

			// Start tracking
			await faceTrackingEngine.startTracking(webcamVideoEl, handleFaceTrackingUpdate);
			faceTrackingActive = true;
			
			dispatch('faceTrackingStarted');
		} catch (e) {
			console.error('Failed to start face tracking:', e);
			throw e;
		}
	}

	/**
	 * Stop face tracking
	 */
	export function stopFaceTracking(): void {
		faceTrackingEngine.stopTracking();
		faceTrackingActive = false;

		if (webcamStream) {
			webcamStream.getTracks().forEach(t => t.stop());
			webcamStream = null;
		}

		if (webcamVideoEl) {
			webcamVideoEl.srcObject = null;
			webcamVideoEl = null;
		}

		dispatch('faceTrackingStopped');
	}

	function handleFaceTrackingUpdate(state: FaceTrackingState) {
		if (!vrm || !vrmRef) return;

		// Apply head rotation
		const headBone = vrm.humanoid?.getNormalizedBoneNode('head');
		if (headBone) {
			headBone.rotation.set(
				state.headRotation.pitch * 0.5,  // Dampen rotation
				state.headRotation.yaw * 0.5,
				state.headRotation.roll * 0.5
			);
		}

		// Apply eye blinks
		vrmRef.setExpression('blinkLeft', state.leftEyeBlink);
		vrmRef.setExpression('blinkRight', state.rightEyeBlink);

		// Apply smile
		if (state.smile > 0.1) {
			vrmRef.setExpression('happy', state.smile);
		}

		// If recording, add frame
		if (isRecording && recorder) {
			recorder.addFrame(state);
			recordedFrameCount = recorder.frameCount;
		}

		dispatch('faceTrackingUpdate', state);
	}

	// ── Movement Recording ─────────────────────────────────────────────

	/**
	 * Start recording movement
	 */
	export async function startRecording(): Promise<void> {
		if (isRecording) return;

		// Ensure face tracking is active
		if (!faceTrackingActive) {
			await startFaceTracking();
		}

		recorder = new MovementRecorder(30);
		recorder.startRecording();
		isRecording = true;
		recordedFrameCount = 0;

		dispatch('recordingStarted');
	}

	/**
	 * Stop recording and return animation data
	 */
	export function stopRecording(name: string): RecordedAnimation | null {
		if (!isRecording || !recorder) return null;

		const animation = recorder.stopRecording(name);
		isRecording = false;
		recorder = null;

		dispatch('recordingStopped', { animation });
		return animation;
	}

	// ── Idle Animation ─────────────────────────────────────────────────

	function startIdleAnimation() {
		if (!idleAnimation || idleAnimation.frames.length === 0) return;

		idleFrameIndex = 0;
		const frameInterval = 1000 / idleAnimation.fps;

		const playFrame = () => {
			if (!idleAnimation || !vrm || !vrmRef) {
				stopIdleAnimation();
				return;
			}

			const frame = idleAnimation.frames[idleFrameIndex];
			
			// Apply head rotation
			const headBone = vrm.humanoid?.getNormalizedBoneNode('head');
			if (headBone && frame.headRotation) {
				headBone.rotation.set(
					frame.headRotation.pitch,
					frame.headRotation.yaw,
					frame.headRotation.roll
				);
			}
			
			// Apply eye rotations for iris/pupil tracking
			if ((frame as any).leftEyeRotation) {
				vrmRef.setEyeRotation('left', (frame as any).leftEyeRotation);
			}
			if ((frame as any).rightEyeRotation) {
				vrmRef.setEyeRotation('right', (frame as any).rightEyeRotation);
			}

			// Apply all blendshapes (facial expressions) - use BASE layer for idle
			// Handle both blendshapes (AnimationPreset) and blendShapes (RecordedFrame)
			const shapes = (frame as any).blendshapes ?? (frame as any).blendShapes;
			if (shapes) {
				for (const [name, value] of Object.entries(shapes)) {
					vrmRef.setExpressionBase(name, value as number);
				}
			} else {
				// Fallback to explicit blink values
				if (frame.leftEyeBlink !== undefined) {
					vrmRef.setExpressionBase('blinkLeft', frame.leftEyeBlink);
				}
				if (frame.rightEyeBlink !== undefined) {
					vrmRef.setExpressionBase('blinkRight', frame.rightEyeBlink);
				}
			}

			// Next frame (loop)
			idleFrameIndex = (idleFrameIndex + 1) % idleAnimation.frames.length;
			
			idleAnimationTimer = window.setTimeout(playFrame, frameInterval);
		};

		playFrame();
	}

	function stopIdleAnimation() {
		if (idleAnimationTimer) {
			clearTimeout(idleAnimationTimer);
			idleAnimationTimer = 0;
		}
	}

	/**
	 * Play a recorded animation once
	 */
	export function playAnimation(animation: RecordedAnimation): Promise<void> {
		return new Promise((resolve) => {
			if (!animation || animation.frames.length === 0) {
				resolve();
				return;
			}

			// Cancel any currently playing animation
			if (isPlayingAnimation && currentAnimationResolve) {
				animationCancelRequested = true;
				currentAnimationResolve();
			}

			// Pause idle animation to avoid bone conflicts (nod/shake_head use head bone)
			idleWasPlayingBeforeAnimation = idleAnimationTimer !== 0;
			if (idleWasPlayingBeforeAnimation) {
				stopIdleAnimation();
			}

			isPlayingAnimation = true;
			animationCancelRequested = false;
			currentAnimationResolve = resolve;
			
			let frameIndex = 0;
			const frameInterval = 1000 / animation.fps;

			const playFrame = () => {
				// Check for cancellation or completion
				if (animationCancelRequested || !vrm || !vrmRef || frameIndex >= animation.frames.length) {
					isPlayingAnimation = false;
					currentAnimationResolve = null;
					// Clear overlay layer so base layer shows through cleanly
					if (vrmRef) {
						vrmRef.clearExpressionOverlay();
					}
					// Resume idle animation if it was playing before
					if (idleWasPlayingBeforeAnimation && idleAnimation) {
						startIdleAnimation();
						idleWasPlayingBeforeAnimation = false;
					}
					resolve();
					return;
				}

				const frame = animation.frames[frameIndex];
				
				// Apply head rotation
				const headBone = vrm.humanoid?.getNormalizedBoneNode('head');
				if (headBone && frame.headRotation) {
					headBone.rotation.set(
						frame.headRotation.pitch,
						frame.headRotation.yaw,
						frame.headRotation.roll
					);
				}
				
				// Apply eye rotations for iris/pupil tracking
				if ((frame as any).leftEyeRotation) {
					vrmRef.setEyeRotation('left', (frame as any).leftEyeRotation);
				}
				if ((frame as any).rightEyeRotation) {
					vrmRef.setEyeRotation('right', (frame as any).rightEyeRotation);
				}

				// Apply all blendshapes (facial expressions) - use OVERLAY layer for triggered animations
				// Handle both blendshapes (AnimationPreset) and blendShapes (RecordedFrame)
				const shapes = (frame as any).blendshapes ?? (frame as any).blendShapes;
				if (shapes) {
					for (const [name, value] of Object.entries(shapes)) {
						vrmRef.setExpressionOverlay(name, value as number);
					}
				} else {
					// Fallback to explicit blink values
					if (frame.leftEyeBlink !== undefined) {
						vrmRef.setExpressionOverlay('blinkLeft', frame.leftEyeBlink);
					}
					if (frame.rightEyeBlink !== undefined) {
						vrmRef.setExpressionOverlay('blinkRight', frame.rightEyeBlink);
					}
				}

				frameIndex++;
				setTimeout(playFrame, frameInterval);
			};

			playFrame();
		});
	}

	/**
	 * Stop the currently playing animation
	 */
	export function stopAnimation() {
		if (isPlayingAnimation) {
			animationCancelRequested = true;
			if (currentAnimationResolve) {
				currentAnimationResolve();
				currentAnimationResolve = null;
			}
			isPlayingAnimation = false;
			
			// Clear overlay layer so base layer shows through
			if (vrmRef) {
				vrmRef.clearExpressionOverlay();
			}
			
			// Resume idle animation if it was playing before
			if (idleWasPlayingBeforeAnimation && idleAnimation) {
				startIdleAnimation();
				idleWasPlayingBeforeAnimation = false;
			}
		}
	}

	/**
	 * Check if an animation is currently playing
	 */
	export function getIsPlayingAnimation(): boolean {
		return isPlayingAnimation;
	}

	// ── Expression Shortcuts ───────────────────────────────────────────

	export function setExpression(name: string, weight: number = 1.0) {
		if (vrmRef) {
			vrmRef.setExpression(name, weight);
		}
	}

	export function setExpressionBase(name: string, weight: number = 1.0) {
		if (vrmRef) {
			vrmRef.setExpressionBase(name, weight);
		}
	}

	export function setExpressionOverlay(name: string, weight: number = 1.0) {
		if (vrmRef) {
			vrmRef.setExpressionOverlay(name, weight);
		}
	}

	export function clearExpressionOverlay() {
		if (vrmRef) {
			vrmRef.clearExpressionOverlay();
		}
	}

	export function clearLipSync() {
		if (vrmRef) {
			vrmRef.clearLipSync();
		}
	}

	export function setNeutral() {
		if (vrmRef) {
			// Reset common expressions
			const expressions = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
			for (const expr of expressions) {
				vrmRef.setExpression(expr, 0);
			}
			vrmRef.setExpression('neutral', 1);
		}
	}

	export function setHappy(intensity: number = 1.0) {
		setNeutral();
		if (vrmRef) {
			vrmRef.setExpression('happy', intensity);
		}
	}

	export function setSad(intensity: number = 1.0) {
		setNeutral();
		if (vrmRef) {
			vrmRef.setExpression('sad', intensity);
		}
	}

	export function setAngry(intensity: number = 1.0) {
		setNeutral();
		if (vrmRef) {
			vrmRef.setExpression('angry', intensity);
		}
	}

	export function setSurprised(intensity: number = 1.0) {
		setNeutral();
		if (vrmRef) {
			vrmRef.setExpression('surprised', intensity);
		}
	}

	// ── Camera/View Controls ───────────────────────────────────────────

	export function resetView() {
		if (vrmRef) {
			vrmRef.resetView();
		}
	}

	export function setZoom(zoom: number) {
		if (vrmRef) {
			vrmRef.setZoom(zoom);
		}
	}

	export function setMainLightColor(color: number) {
		if (vrmRef) {
			vrmRef.setMainLightColor(color);
		}
	}

	export function setMainLightIntensity(intensity: number) {
		if (vrmRef) {
			vrmRef.setMainLightIntensity(intensity);
		}
	}

	export function setFocalLength(fl: number) {
		if (vrmRef) {
			vrmRef.setFocalLength(fl);
		}
	}
	export function autoFitModel() {
		if (vrmRef) {
			vrmRef.autoFitModel();
		}
	}

	export function getModelDimensions() {
		return vrmRef?.getModelDimensions() ?? null;
	}

	export function getCameraState() {
		return vrmRef?.getCameraState() ?? null;
	}

	export function setCameraState(state: Parameters<typeof vrmRef.setCameraState>[0]) {
		if (vrmRef) {
			vrmRef.setCameraState(state);
		}
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	onDestroy(() => {
		stopLipSync();
		stopFaceTracking();
		stopIdleAnimation();
	});
</script>

<div class="vrm-avatar-native" style="width: {width}px; height: {height}px;">
	<VrmRenderer
		bind:this={vrmRef}
		{width}
		{height}
		backgroundColor={bgColorNum}
		backgroundAlpha={backgroundAlpha}
		{focalLength}
		{mainLightIntensity}
		{ambientLightIntensity}
		{rimLightIntensity}
		{gammaCorrection}
		{toneMappingExposure}
		{contrast}
		{saturation}
		{matcapIntensity}
		{rimFresnelPower}
		{rimLift}
		{restPose}
		bind:vrm
		bind:loading
		bind:error
		on:loaded={handleVrmLoaded}
		on:progress={handleProgress}
		on:zoomChange
		on:modelRotate
		on:lightMove
		on:cameraPan
	/>

	{#if loading}
		<div class="loading-overlay">
			<div class="loading-spinner"></div>
			<div class="loading-text">{loadProgress}%</div>
		</div>
	{/if}

	{#if error}
		<div class="error-overlay">
			<div class="error-text">{error}</div>
		</div>
	{/if}

	{#if !vrm && !loading && !error}
		<div class="placeholder-overlay">
			<slot name="placeholder">
				<div class="placeholder-text">
					{$i18n?.t?.('Upload a VRM file') ?? 'Upload a VRM file'}
				</div>
			</slot>
		</div>
	{/if}

	{#if vrm && showControls}
		<div class="controls-hint">
			<button
				class="reset-btn"
				on:click={resetView}
				title={$i18n?.t?.('Reset View') ?? 'Reset View'}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
					<path d="M3 3v5h5" />
				</svg>
			</button>
			<button
				class="reset-btn"
				on:click={autoFitModel}
				title={$i18n?.t?.('Auto-Fit Model') ?? 'Auto-Fit Model'}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M15 3h6v6" />
					<path d="M9 21H3v-6" />
					<path d="M21 3l-7 7" />
					<path d="M3 21l7-7" />
				</svg>
			</button>
			<span class="hint-icon" title="Alt+Scroll: Zoom | Alt+Drag: Rotate | Ctrl+Drag: Light | Ctrl+Right: Pan">?</span>
		</div>
	{/if}

	{#if isRecording}
		<div class="recording-indicator">
			<span class="recording-dot"></span>
			<span class="recording-text">REC {recordedFrameCount}</span>
		</div>
	{/if}

	{#if faceTrackingActive && !isRecording}
		<div class="tracking-indicator">
			<span class="tracking-dot"></span>
			<span class="tracking-text">TRACKING</span>
		</div>
	{/if}

	{#if lipSyncActive}
		<div class="lipsync-indicator" style="opacity: {0.3 + currentVolume * 0.7}">
			<span class="lipsync-viseme">{currentViseme}</span>
		</div>
	{/if}
</div>

<style>
	.vrm-avatar-native {
		position: relative;
		border-radius: inherit;
		overflow: hidden;
	}

	.loading-overlay,
	.error-overlay,
	.placeholder-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.5);
		color: white;
		font-size: 0.75rem;
	}

	.loading-spinner {
		width: 24px;
		height: 24px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.loading-text {
		margin-top: 8px;
	}

	.error-text {
		color: #f87171;
		text-align: center;
		padding: 16px;
	}

	.placeholder-text {
		color: rgba(255, 255, 255, 0.5);
		text-align: center;
	}

	.recording-indicator {
		position: absolute;
		top: 8px;
		right: 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		background: rgba(220, 38, 38, 0.8);
		color: white;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 10px;
		font-weight: 600;
	}

	.recording-dot {
		width: 8px;
		height: 8px;
		background: white;
		border-radius: 50%;
		animation: pulse 1s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.5; }
	}

	.tracking-indicator {
		position: absolute;
		top: 8px;
		right: 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		background: rgba(34, 197, 94, 0.8);
		color: white;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 10px;
		font-weight: 600;
	}

	.tracking-dot {
		width: 8px;
		height: 8px;
		background: white;
		border-radius: 50%;
	}

	.lipsync-indicator {
		position: absolute;
		bottom: 8px;
		left: 8px;
		background: rgba(59, 130, 246, 0.8);
		color: white;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 10px;
		font-weight: 600;
		transition: opacity 0.1s;
	}

	.controls-hint {
		position: absolute;
		bottom: 4px;
		left: 4px;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.reset-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		background: rgba(0, 0, 0, 0.5);
		border: none;
		border-radius: 4px;
		color: rgba(255, 255, 255, 0.7);
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
	}

	.reset-btn:hover {
		background: rgba(0, 0, 0, 0.7);
		color: white;
	}

	.hint-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		background: rgba(0, 0, 0, 0.5);
		border-radius: 50%;
		color: rgba(255, 255, 255, 0.7);
		font-size: 10px;
		font-weight: 600;
		cursor: help;
	}
</style>
