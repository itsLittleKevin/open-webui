<script lang="ts">
	import { onMount, onDestroy, tick, getContext } from 'svelte';
	import { showVrmAvatar, settings, vmcAnimationTrigger } from '$lib/stores';
	import { updateUserSettings } from '$lib/apis/users';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Switch from '$lib/components/common/Switch.svelte';
	import VrmAvatarNative from './VrmAvatarNative.svelte';
	import {
		getPresets,
		getPreset,
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
	import type { RecordedAnimation } from '$lib/utils/faceTracking';
	import { 
		getPrimaryVRM, setPrimaryVRM, arrayBufferToFile, 
		saveCameraPreset, loadCameraPreset, deleteCameraPreset, listCameraPresets, 
		getLastCameraPreset, saveLastCameraPreset, generatePresetId, type CameraPreset,
		saveAnimationPreset, loadAnimationPreset, deleteAnimationPreset, listAnimationPresets,
		generateAnimationId, type AnimationPreset
	} from '$lib/utils/vrmStorage';

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
	let vrmBgBlur = 0;  // Simple blur for when gradient is disabled
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
	
	// Blur gradient settings (0-20px) - mirrored from opacity gradient
	let vrmBgGradientBlurAngle = 180;
	let vrmBgGradientStartBlur = 0;
	let vrmBgGradientMidBlur = 5;
	let vrmBgGradientEndBlur = 0;
	let vrmBgGradientBlurMidpoint = 50;
	
	// Collapsible section states
	let expandGradient = true;
	let expandChromaKey = true;
	let expandLayers = true;
	let expandLighting = true;
	let expandBackdropBlur = false;  // Simple blur section (hidden by default when gradient available)
	
	// ── Mode Toggle: Camera (VSeeFace) vs Native (Browser VRM) ──────────
	let vrmRenderMode: 'camera' | 'native' = 'camera';
	let vrmNativeFile: File | null = null;
	let vrmNativeRef: VrmAvatarNative | null = null;
	let vrmFileInput: HTMLInputElement;
	let nativeRecording = false;
	let nativeRecordName = '';
	let nativeFaceTracking = false;
	let nativeStatus = '';
	let nativeFocalLength = 135; // 70-240mm range, default 135mm for telephoto look
	
	// Shader/Lighting settings
	let nativeMainLightIntensity = 1.0;
	let nativeAmbientLightIntensity = 0.4;
	let nativeRimLightIntensity = 0.5;
	let nativeGammaCorrection = 1.0;
	let nativeToneMappingExposure = 1.0;
	let nativeContrast = 1.0;
	let nativeSaturation = 1.0;
	
	// MToon shader enhancements
	let nativeMatcapIntensity = 0.5;
	let nativeRimFresnelPower = 3.0;
	let nativeRimLift = 0.3;
	
	// Rest pose - arms down instead of T-pose
	let nativeRestPose = 70; // 0 = T-pose, 100 = full arms-down

	// Lip sync integration with global TTS audioElement
	let ttsAudioElement: HTMLAudioElement | null = null;
	let lipSyncAttached = false;

	// Camera presets
	let cameraPresets: CameraPreset[] = [];
	let cameraPresetName = '';
	let loadingPresets = false;
	let autoSaveTimer: number = 0;
	
	// Animation presets
	let animationPresets: AnimationPreset[] = [];
	let loadingAnimations = false;
	let nativeIdleAnimation: AnimationPreset | null = null;

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
		vrmBgBlur = $settings?.vrmBgBlur ?? 0;
		vrmBgGradientBlurAngle = $settings?.vrmBgGradientBlurAngle ?? 180;
		vrmBgGradientStartBlur = $settings?.vrmBgGradientStartBlur ?? 0;
		vrmBgGradientMidBlur = $settings?.vrmBgGradientMidBlur ?? 5;
		vrmBgGradientEndBlur = $settings?.vrmBgGradientEndBlur ?? 0;
		vrmBgGradientBlurMidpoint = $settings?.vrmBgGradientBlurMidpoint ?? 50;
		vrmRenderMode = $settings?.vrmRenderMode ?? 'camera';
		nativeFocalLength = $settings?.nativeFocalLength ?? 135;
		nativeMainLightIntensity = $settings?.nativeMainLightIntensity ?? 1.0;
		nativeAmbientLightIntensity = $settings?.nativeAmbientLightIntensity ?? 0.4;
		nativeRimLightIntensity = $settings?.nativeRimLightIntensity ?? 0.5;
		nativeGammaCorrection = $settings?.nativeGammaCorrection ?? 1.0;
		nativeToneMappingExposure = $settings?.nativeToneMappingExposure ?? 1.0;
		nativeContrast = $settings?.nativeContrast ?? 1.0;
		nativeSaturation = $settings?.nativeSaturation ?? 1.0;
		nativeMatcapIntensity = $settings?.nativeMatcapIntensity ?? 0.5;
		nativeRimFresnelPower = $settings?.nativeRimFresnelPower ?? 3.0;
		nativeRimLift = $settings?.nativeRimLift ?? 0.3;
		nativeRestPose = $settings?.nativeRestPose ?? 70;
	}

	// ── Native VRM Functions ─────────────────────────────────────────────

	async function handleVrmFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			vrmNativeFile = input.files[0];
			nativeStatus = `Loading: ${vrmNativeFile.name}...`;
			
			// Persist to IndexedDB for next session
			try {
				await setPrimaryVRM(vrmNativeFile.name, vrmNativeFile);
				nativeStatus = `Loaded: ${vrmNativeFile.name}`;
			} catch (e) {
				console.error('Failed to persist VRM:', e);
				nativeStatus = `Loaded: ${vrmNativeFile.name} (not persisted)`;
			}
		}
	}

	async function loadStoredVRM() {
		try {
			const stored = await getPrimaryVRM();
			if (stored) {
				vrmNativeFile = arrayBufferToFile(stored.data, stored.name);
				nativeStatus = `Restored: ${stored.name}`;
			}
		} catch (e) {
			console.error('Failed to load stored VRM:', e);
		}
	}

	async function nativeStartFaceTracking() {
		if (!vrmNativeRef) return;
		try {
			await vrmNativeRef.startFaceTracking();
			nativeFaceTracking = true;
			nativeStatus = 'Face tracking active';
		} catch (e: any) {
			nativeStatus = e?.message || 'Failed to start face tracking';
		}
	}

	function nativeStopFaceTracking() {
		if (!vrmNativeRef) return;
		vrmNativeRef.stopFaceTracking();
		nativeFaceTracking = false;
		nativeStatus = 'Face tracking stopped';
	}

	async function nativeStartRecording() {
		const name = nativeRecordName.trim();
		if (!name) {
			nativeStatus = 'Enter a preset name first';
			return;
		}
		if (!vrmNativeRef) return;
		try {
			await vrmNativeRef.startRecording();
			nativeRecording = true;
			nativeStatus = 'Recording...';
		} catch (e: any) {
			nativeStatus = e?.message || 'Failed to start recording';
		}
	}

	async function nativeStopRecording() {
		const name = nativeRecordName.trim();
		if (!name || !vrmNativeRef || !vrmNativeFile) return;
		
		const animation = vrmNativeRef.stopRecording(name);
		nativeRecording = false;
		nativeRecordName = '';
		
		if (animation) {
			// Save animation to IndexedDB
			try {
				await saveAnimationPreset({
					id: generateAnimationId(),
					name,
					vrmName: vrmNativeFile.name,
					frames: animation.frames,
					duration: animation.duration,
					fps: animation.fps
				});
				nativeStatus = `Saved "${name}" (${animation.frames.length} frames, ${(animation.duration / 1000).toFixed(1)}s)`;
				await loadAnimationPresetsForVRM();
			} catch (e: any) {
				nativeStatus = `Recording complete but save failed: ${e.message}`;
			}
		}
	}
	
	// ── Animation Presets ──────────────────────────────────────────────
	
	async function loadAnimationPresetsForVRM() {
		if (!vrmNativeFile) return;
		loadingAnimations = true;
		try {
			animationPresets = await listAnimationPresets(vrmNativeFile.name);
		} catch (e) {
			console.error('Failed to load animation presets:', e);
			animationPresets = [];
		}
		loadingAnimations = false;
	}
	
	async function playNativeAnimation(preset: AnimationPreset) {
		if (!vrmNativeRef) return;
		try {
			// Convert AnimationPreset to RecordedAnimation format
			const animation: RecordedAnimation = {
				name: preset.name,
				frames: preset.frames as any, // The types match
				duration: preset.duration,
				fps: preset.fps
			};
			await vrmNativeRef.playAnimation(animation);
			nativeStatus = `Playing "${preset.name}"`;
		} catch (e: any) {
			nativeStatus = `Playback failed: ${e.message}`;
		}
	}
	
	function stopNativeAnimation() {
		if (!vrmNativeRef) return;
		try {
			vrmNativeRef.stopAnimation();
			nativeStatus = 'Animation stopped';
		} catch (e: any) {
			nativeStatus = `Stop failed: ${e.message}`;
		}
	}
	
	function setNativeIdleAnimation(preset: AnimationPreset) {
		nativeIdleAnimation = preset;
		nativeStatus = `Set "${preset.name}" as idle animation`;
		// The idle animation can be passed to VrmAvatarNative via prop
	}
	
	async function deleteNativeAnimation(preset: AnimationPreset) {
		try {
			await deleteAnimationPreset(preset.id);
			if (nativeIdleAnimation?.id === preset.id) {
				nativeIdleAnimation = null;
			}
			await loadAnimationPresetsForVRM();
			nativeStatus = `Deleted "${preset.name}"`;
		} catch (e: any) {
			nativeStatus = `Delete failed: ${e.message}`;
		}
	}
	
	/**
	 * Convert quaternion [x, y, z, w] to euler angles [pitch, yaw, roll] in radians
	 * VMC/Unity uses left-handed coords, Three.js uses right-handed
	 * We negate qx and qz to flip handedness, then extract XYZ euler angles
	 */
	function quaternionToEuler(q: number[]): { pitch: number; yaw: number; roll: number } {
		// VMC quaternion: [x, y, z, w] in Unity left-hand coords
		// Convert to Three.js right-hand by negating x and z
		const qx = -q[0];
		const qy = q[1];
		const qz = -q[2];
		const qw = q[3];
		
		// Extract Euler angles in XYZ order (Three.js default)
		// pitch = X rotation (nodding up/down)
		const sinp = 2 * (qw * qx + qy * qz);
		const cosp = 1 - 2 * (qx * qx + qy * qy);
		const pitch = Math.atan2(sinp, cosp);
		
		// yaw = Y rotation (shaking head left/right)
		const siny = 2 * (qw * qy - qz * qx);
		// Clamp to avoid NaN from asin
		const yaw = Math.abs(siny) >= 1 
			? Math.sign(siny) * Math.PI / 2 
			: Math.asin(siny);
		
		// roll = Z rotation (tilting head sideways)
		const sinr = 2 * (qw * qz + qx * qy);
		const cosr = 1 - 2 * (qy * qy + qz * qz);
		const roll = Math.atan2(sinr, cosr);
		
		return { pitch, yaw, roll };
	}
	
	/**
	 * Convert VMC frames to native animation format
	 */
	function convertVMCFramesToNative(vmcFrames: any[]): AnimationPreset['frames'] {
		return vmcFrames.map(frame => {
			const result: AnimationPreset['frames'][0] = {};
			
			// Extract head rotation from bones if available
			if (frame.bones?.Head) {
				const bone = frame.bones.Head;
				// VMC stores bones as { pos: [x,y,z], rot: [x,y,z,w] }
				if (bone.rot && Array.isArray(bone.rot) && bone.rot.length === 4) {
					result.headRotation = quaternionToEuler(bone.rot);
				}
			}
			
			// Extract left eye rotation for iris/pupil tracking
			if (frame.bones?.LeftEye) {
				const bone = frame.bones.LeftEye;
				if (bone.rot && Array.isArray(bone.rot) && bone.rot.length === 4) {
					result.leftEyeRotation = quaternionToEuler(bone.rot);
				}
			}
			
			// Extract right eye rotation for iris/pupil tracking
			if (frame.bones?.RightEye) {
				const bone = frame.bones.RightEye;
				if (bone.rot && Array.isArray(bone.rot) && bone.rot.length === 4) {
					result.rightEyeRotation = quaternionToEuler(bone.rot);
				}
			}
			
			// Extract ALL blendshapes (facial expressions, eye blinks, etc.)
			if (frame.blendshapes && Object.keys(frame.blendshapes).length > 0) {
				result.blendshapes = { ...frame.blendshapes };
				
				// Also extract blink values for convenience
				const leftBlink = frame.blendshapes.blinkLeft ?? 
					frame.blendshapes.Blink_L ?? 
					frame.blendshapes.eyeBlinkLeft ?? 0;
				const rightBlink = frame.blendshapes.blinkRight ?? 
					frame.blendshapes.Blink_R ?? 
					frame.blendshapes.eyeBlinkRight ?? 0;
				
				if (leftBlink > 0) result.leftEyeBlink = leftBlink;
				if (rightBlink > 0) result.rightEyeBlink = rightBlink;
			}
			
			return result;
		}).filter(f => f.headRotation || f.leftEyeRotation || f.rightEyeRotation || f.blendshapes || f.leftEyeBlink !== undefined);
	}
	
	/**
	 * Import a VMC preset to native animations
	 */
	async function importVMCPresetToNative(presetName: string) {
		if (!vrmNativeFile) {
			nativeStatus = 'Load a VRM model first';
			return;
		}
		
		try {
			nativeStatus = `Importing "${presetName}"...`;
			
			// Fetch full preset from backend with all frames
			const vmcPreset = await getPreset(localStorage.token, presetName);
			
			if (!vmcPreset.frames || vmcPreset.frames.length === 0) {
				nativeStatus = `No frames found in "${presetName}"`;
				return;
			}
			
			// Convert frames
			const nativeFrames = convertVMCFramesToNative(vmcPreset.frames);
			
			if (nativeFrames.length === 0) {
				nativeStatus = `No convertible data in "${presetName}" (no head/blink data)`;
				return;
			}
			
			// Calculate FPS from frame timing
			const fps = vmcPreset.frame_count && vmcPreset.duration_ms > 0 
				? Math.round(vmcPreset.frame_count / (vmcPreset.duration_ms / 1000))
				: 30;
			
			// Save as native animation
			await saveAnimationPreset({
				id: generateAnimationId(),
				name: `VMC: ${presetName}`,
				vrmName: vrmNativeFile.name,
				frames: nativeFrames,
				duration: vmcPreset.duration_ms ?? 0,
				fps
			});
			
			await loadAnimationPresetsForVRM();
			nativeStatus = `Imported "${presetName}" (${nativeFrames.length} frames)`;
		} catch (e: any) {
			console.error('Import failed:', e);
			nativeStatus = `Import failed: ${e.message || String(e)}`;
		}
	}
	
	/**
	 * Import all VMC presets to native animations
	 */
	async function importAllVMCPresetsToNative() {
		if (!vrmNativeFile) {
			nativeStatus = 'Load a VRM model first';
			return;
		}
		
		nativeStatus = 'Importing all VMC presets...';
		let imported = 0;
		let failed = 0;
		
		for (const preset of vmcPresets) {
			try {
				await importVMCPresetToNative(preset.name);
				imported++;
			} catch {
				failed++;
			}
		}
		
		await loadAnimationPresetsForVRM();
		nativeStatus = `Imported ${imported} presets${failed > 0 ? `, ${failed} failed` : ''}`;
	}

	// ── Camera Presets ─────────────────────────────────────────────────

	async function loadCameraPresets() {
		if (!vrmNativeFile) return;
		loadingPresets = true;
		try {
			cameraPresets = await listCameraPresets(vrmNativeFile.name);
		} catch (e) {
			console.error('Failed to load camera presets:', e);
			cameraPresets = [];
		}
		loadingPresets = false;
	}

	async function saveCameraPresetFromCurrent() {
		const name = cameraPresetName.trim();
		if (!name || !vrmNativeRef || !vrmNativeFile) {
			nativeStatus = 'Enter a preset name first';
			return;
		}

		const state = vrmNativeRef.getCameraState();
		if (!state) {
			nativeStatus = 'No camera state available';
			return;
		}

		try {
			await saveCameraPreset({
				id: generatePresetId(),
				name,
				vrmName: vrmNativeFile.name,
				...state
			});
			cameraPresetName = '';
			nativeStatus = `Saved camera preset "${name}"`;
			await loadCameraPresets();
		} catch (e) {
			console.error('Failed to save camera preset:', e);
			nativeStatus = 'Failed to save preset';
		}
	}

	async function applyCameraPreset(preset: CameraPreset) {
		if (!vrmNativeRef) return;
		
		vrmNativeRef.setCameraState({
			cameraDistance: preset.cameraDistance,
			cameraTargetY: preset.cameraTargetY,
			cameraOffsetX: preset.cameraOffsetX,
			cameraOffsetY: preset.cameraOffsetY,
			modelRotationX: preset.modelRotationX,
			modelRotationY: preset.modelRotationY,
			focalLength: preset.focalLength,
			lightTheta: preset.lightTheta,
			lightPhi: preset.lightPhi
		});
		
		// Update local focal length state
		nativeFocalLength = preset.focalLength;
		
		nativeStatus = `Applied preset "${preset.name}"`;
	}

	async function deleteCameraPresetById(id: string) {
		try {
			await deleteCameraPreset(id);
			nativeStatus = 'Preset deleted';
			await loadCameraPresets();
		} catch (e) {
			console.error('Failed to delete preset:', e);
			nativeStatus = 'Failed to delete preset';
		}
	}

	// Auto-save camera state when it changes (debounced)
	function scheduleAutoSave() {
		if (!vrmNativeFile || !vrmNativeRef) return;
		
		// Clear previous timer
		if (autoSaveTimer) {
			clearTimeout(autoSaveTimer);
		}
		
		// Schedule save after 1 second of no changes
		autoSaveTimer = window.setTimeout(async () => {
			const state = vrmNativeRef?.getCameraState();
			if (!state || !vrmNativeFile) return;
			
			try {
				await saveLastCameraPreset(vrmNativeFile.name, state);
			} catch (e) {
				console.error('Failed to auto-save camera state:', e);
			}
		}, 1000);
	}

	// Restore last camera state when VRM loads
	async function restoreLastCameraState() {
		if (!vrmNativeFile || !vrmNativeRef) return;
		
		try {
			const lastPreset = await getLastCameraPreset(vrmNativeFile.name);
			if (lastPreset) {
				vrmNativeRef.setCameraState({
					cameraDistance: lastPreset.cameraDistance,
					cameraTargetY: lastPreset.cameraTargetY,
					cameraOffsetX: lastPreset.cameraOffsetX,
					cameraOffsetY: lastPreset.cameraOffsetY,
					modelRotationX: lastPreset.modelRotationX,
					modelRotationY: lastPreset.modelRotationY,
					focalLength: lastPreset.focalLength,
					lightTheta: lastPreset.lightTheta,
					lightPhi: lastPreset.lightPhi
				});
				nativeFocalLength = lastPreset.focalLength;
				nativeStatus = 'Restored last camera position';
			}
		} catch (e) {
			console.error('Failed to restore camera state:', e);
		}
		
		// Load presets list
		await loadCameraPresets();
		await loadAnimationPresetsForVRM();
	}

	// Handle camera change events for auto-save
	function handleCameraChange() {
		scheduleAutoSave();
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

	// Interpolate blur value based on gradient midpoint (0-100), similar to opacity
	function getGradientBlur(): number {
		const midBias = vrmBgGradientBlurMidpoint / 100; // 0-1
		if (midBias <= 0.5) {
			// Interpolate between start and mid
			const t = midBias * 2; // 0-1
			return vrmBgGradientStartBlur + (vrmBgGradientMidBlur - vrmBgGradientStartBlur) * t;
		} else {
			// Interpolate between mid and end
			const t = (midBias - 0.5) * 2; // 0-1
			return vrmBgGradientMidBlur + (vrmBgGradientEndBlur - vrmBgGradientMidBlur) * t;
		}
	}

	$: overlayBg = vrmBgGradientEnabled
		? `linear-gradient(${vrmBgGradientAngle}deg, ${hexToRgba(vrmBgColor, vrmBgGradientStartOpacity)} 0%, ${hexToRgba(vrmBgColor, vrmBgGradientMidOpacity)} ${vrmBgGradientMidpoint}%, ${hexToRgba(vrmBgColor, vrmBgGradientEndOpacity)} 100%)`
		: hexToRgba(vrmBgColor, 100 - vrmBgTransparency);
	
	// Compute blur amount and gradient mask for the blur overlay
	$: overlayBlurAmount = (() => {
		if (vrmBgGradientEnabled) {
			return Math.max(vrmBgGradientStartBlur, vrmBgGradientMidBlur, vrmBgGradientEndBlur);
		} else {
			return vrmBgBlur;
		}
	})();

	$: overlayBlurMask = (() => {
		if (vrmBgGradientEnabled && overlayBlurAmount > 0) {
			const startA = vrmBgGradientStartBlur / overlayBlurAmount;
			const midA = vrmBgGradientMidBlur / overlayBlurAmount;
			const endA = vrmBgGradientEndBlur / overlayBlurAmount;
			return `linear-gradient(${vrmBgGradientBlurAngle}deg, rgba(0,0,0,${startA}) 0%, rgba(0,0,0,${midA}) ${vrmBgGradientBlurMidpoint}%, rgba(0,0,0,${endA}) 100%)`;
		}
		return 'none';
	})();
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
		// Skip dragging when Alt/Ctrl is pressed (for VRM interaction controls)
		if (e.altKey || e.ctrlKey) return;
		dragging = true;
		dragOffset = { x: e.clientX - pos.x, y: e.clientY - pos.y };
		e.preventDefault();
	}

	function onMouseMove(e: MouseEvent) {
		// Skip if Alt/Ctrl is pressed (VRM interaction mode)
		if (e.altKey || e.ctrlKey) return;
		
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
	$: if ($showVrmAvatar && selectedDeviceId && vrmRenderMode === 'camera') {
		startStream();
	} else if (vrmRenderMode === 'native') {
		stopStream();
	} else {
		stopStream();
	}

	// Load stored VRM when switching to native mode
	$: if (vrmRenderMode === 'native' && !vrmNativeFile) {
		loadStoredVRM();
	}

	// Map VMC preset names to native animation preset names
	// (VMC presets have names like "smile", native imports have "VMC: smile")
	function findNativeAnimationByVMCPreset(vmcPresetName: string): AnimationPreset | null {
		// First try exact match with "VMC: " prefix
		const vmcName = `VMC: ${vmcPresetName}`;
		const found = animationPresets.find(p => p.name === vmcName || p.name.toLowerCase() === vmcPresetName.toLowerCase());
		return found || null;
	}

	// Handle animation triggers from the interceptor (for native VRM mode)
	let animTriggerUnsubscribe: (() => void) | null = null;

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
		
		// Load stored VRM for native mode
		if (vrmRenderMode === 'native') {
			await loadStoredVRM();
		}

		// Subscribe to animation triggers from the interceptor
		animTriggerUnsubscribe = vmcAnimationTrigger.subscribe(async (trigger) => {
			if (!trigger || vrmRenderMode !== 'native' || !vrmNativeRef) return;

			// Don't trigger if an animation is already playing
			if (vrmNativeRef.getIsPlayingAnimation()) {
				console.debug('[vmc-animation] Skipping - animation already playing');
				return;
			}

			// Try to find a matching native animation preset
			const nativePreset = findNativeAnimationByVMCPreset(trigger.preset);
			if (nativePreset) {
				console.debug('[vmc-animation] Playing native animation:', nativePreset.name, 'duration:', nativePreset.duration);
				await playNativeAnimation(nativePreset);
			} else {
				console.debug('[vmc-animation] No native animation found for:', trigger.preset, '- available:', animationPresets.map(p => p.name));
			}
		});

		// Connect lip sync to the global TTS audio element
		// The audio element might not exist immediately if VrmAvatarOverlay mounts before Chat.svelte
		const connectAudioElement = () => {
			ttsAudioElement = document.getElementById('audioElement') as HTMLAudioElement | null;
			if (ttsAudioElement) {
				ttsAudioElement.addEventListener('play', onTTSPlay);
				ttsAudioElement.addEventListener('ended', onTTSEnded);
				ttsAudioElement.addEventListener('pause', onTTSEnded);
				lipSyncAttached = true;
				return true;
			}
			return false;
		};

		if (!connectAudioElement()) {
			// Retry a few times with delay
			let retries = 0;
			const maxRetries = 10;
			const retryInterval = setInterval(() => {
				retries++;
				if (connectAudioElement() || retries >= maxRetries) {
					clearInterval(retryInterval);
				}
			}, 500);
		}
	});

	// TTS lip sync handlers
	function onTTSPlay() {
		if (vrmRenderMode === 'native' && vrmNativeRef && ttsAudioElement) {
			vrmNativeRef.startLipSync(ttsAudioElement);
		}
	}

	function onTTSEnded() {
		if (vrmRenderMode === 'native' && vrmNativeRef) {
			vrmNativeRef.stopLipSync();
		}
	}

	onDestroy(() => {
		stopChromaLoop();
		stopStream();
		if (animTriggerUnsubscribe) {
			animTriggerUnsubscribe();
		}
		// Clean up lip sync listeners
		if (ttsAudioElement && lipSyncAttached) {
			ttsAudioElement.removeEventListener('play', onTTSPlay);
			ttsAudioElement.removeEventListener('ended', onTTSEnded);
			ttsAudioElement.removeEventListener('pause', onTTSEnded);
		}
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
		style="left: {pos.x}px; top: {pos.y}px; width: {overlayWidth}px; height: {overlayHeight}px; background: {overlayBg}; border: {showFrame ? '1px solid rgba(128,128,128,0.3)' : 'none'};"
		on:mousedown={onMouseDown}
		on:mouseenter={() => { showFrame = true; }}
		on:mouseleave={() => { if (!showDevicePicker) showFrame = false; }}
	>
		<!-- Blur overlay layer (gradient blur via mask) -->
		{#if overlayBlurAmount > 0}
		<div
			class="absolute inset-0 pointer-events-none"
			style="backdrop-filter: blur({overlayBlurAmount}px); -webkit-backdrop-filter: blur({overlayBlurAmount}px);
				{overlayBlurMask !== 'none' ? `mask-image: ${overlayBlurMask}; -webkit-mask-image: ${overlayBlurMask};` : ''}
				z-index: 0;"
		></div>
		{/if}
		<!-- Title bar (overlay, conditionally visible) -->
		{#if showFrame}
		<div
			class="absolute top-0 left-0 right-0 flex items-center justify-between px-3 py-1.5 bg-gray-900/90 cursor-move text-white text-xs"
			style="z-index: 15; transition: opacity 0.15s ease;"
		>
			<span class="font-medium opacity-80">{vrmRenderMode === 'native' ? 'VRM (Native)' : 'VRM Avatar'}</span>
			<div class="flex items-center gap-1.5 no-drag">
				<!-- Camera select (only in camera mode) -->
				{#if vrmRenderMode === 'camera'}
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
				{/if}
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

			{#if vrmRenderMode === 'native'}
				<!-- Native VRM Renderer (no VSeeFace needed) -->
				<VrmAvatarNative
					bind:this={vrmNativeRef}
					width={overlayWidth}
					height={overlayHeight}
					backgroundColor={vrmBgColor}
					backgroundAlpha={(100 - vrmBgTransparency) / 100}
					vrmFile={vrmNativeFile}
					enableLipSync={true}
					enableFaceTracking={nativeFaceTracking}
					focalLength={nativeFocalLength}
					mainLightIntensity={nativeMainLightIntensity}
					ambientLightIntensity={nativeAmbientLightIntensity}
					rimLightIntensity={nativeRimLightIntensity}
					gammaCorrection={nativeGammaCorrection}
					toneMappingExposure={nativeToneMappingExposure}
					contrast={nativeContrast}
					saturation={nativeSaturation}
					matcapIntensity={nativeMatcapIntensity}
					rimFresnelPower={nativeRimFresnelPower}
					rimLift={nativeRimLift}
					restPose={nativeRestPose}
					idleAnimation={nativeIdleAnimation ? { name: nativeIdleAnimation.name, frames: nativeIdleAnimation.frames, duration: nativeIdleAnimation.duration, fps: nativeIdleAnimation.fps } : null}
					on:loaded={restoreLastCameraState}
					on:zoomChange={handleCameraChange}
					on:modelRotate={handleCameraChange}
					on:lightMove={handleCameraChange}
					on:cameraPan={handleCameraChange}
				>
					<div slot="placeholder" class="flex flex-col items-center justify-center gap-2 p-4">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-8 h-8 text-gray-500">
							<path fill-rule="evenodd" d="M10.5 3.75a6 6 0 0 0-5.98 6.496A5.25 5.25 0 0 0 6.75 20.25H18a4.5 4.5 0 0 0 2.206-8.423 3.75 3.75 0 0 0-4.133-4.303A6.001 6.001 0 0 0 10.5 3.75Zm2.03 5.47a.75.75 0 0 0-1.06 0l-3 3a.75.75 0 1 0 1.06 1.06l1.72-1.72v4.94a.75.75 0 0 0 1.5 0v-4.94l1.72 1.72a.75.75 0 1 0 1.06-1.06l-3-3Z" clip-rule="evenodd" />
						</svg>
						<span class="text-xs text-gray-500 text-center">{$i18n.t('Upload VRM in settings')}</span>
					</div>
				</VrmAvatarNative>
			{:else if cameraError}
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
				
				<!-- ── Render Mode ─────────────────────────────────────────── -->
				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{$i18n.t('Render Mode')}</div>
				
				<div class="flex gap-1.5">
					<button
						type="button"
						class="flex-1 text-xs px-2 py-1.5 rounded transition {vrmRenderMode === 'native' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
						on:click={() => { vrmRenderMode = 'native'; saveSettings({ vrmRenderMode }); }}
					>
						{$i18n.t('Native VRM')}
					</button>
					<button
						type="button"
						class="flex-1 text-xs px-2 py-1.5 rounded transition {vrmRenderMode === 'camera' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}"
						on:click={() => { vrmRenderMode = 'camera'; saveSettings({ vrmRenderMode }); }}
					>
						{$i18n.t('Camera (VSeeFace)')}
					</button>
				</div>

				<div class="text-[10px] text-gray-500 mb-1">
					{#if vrmRenderMode === 'native'}
						{$i18n.t('Renders VRM directly in browser - no VSeeFace needed')}
					{:else}
						{$i18n.t('Captures from VSeeFace virtual camera')}
					{/if}
				</div>

				<!-- ── Native VRM Settings ─────────────────────────────────── -->
				{#if vrmRenderMode === 'native'}
				<div class="border border-gray-700 rounded-lg p-2 flex flex-col gap-2 mb-1">
					<div class="text-xs font-medium">{$i18n.t('VRM Model')}</div>
					
					<!-- File upload -->
					<input
						type="file"
						accept=".vrm"
						class="hidden"
						bind:this={vrmFileInput}
						on:change={handleVrmFileSelect}
					/>
					<button
						type="button"
						class="w-full text-xs px-2 py-2 rounded bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center gap-2"
						on:click={() => vrmFileInput?.click()}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
							<path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z" />
							<path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
						</svg>
						{vrmNativeFile ? vrmNativeFile.name : $i18n.t('Upload VRM File')}
					</button>

					<!-- Face Tracking -->
					<div class="text-xs font-medium mt-1">{$i18n.t('Face Tracking (Webcam)')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Use your webcam to control head and eye movement')}</div>
					
					<div class="flex gap-1.5">
						{#if !nativeFaceTracking}
							<button
								type="button"
								class="flex-1 text-xs px-2 py-1.5 rounded bg-green-600 hover:bg-green-700 text-white"
								on:click={nativeStartFaceTracking}
							>
								{$i18n.t('Start Tracking')}
							</button>
						{:else}
							<button
								type="button"
								class="flex-1 text-xs px-2 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white"
								on:click={nativeStopFaceTracking}
							>
								{$i18n.t('Stop Tracking')}
							</button>
						{/if}
					</div>

					<!-- Recording -->
					<div class="text-xs font-medium mt-1">{$i18n.t('Record Movement')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Record head movements to create animation presets')}</div>
					
					<div class="flex items-center gap-1.5">
						<input
							type="text"
							class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0"
							placeholder={$i18n.t('Preset name')}
							bind:value={nativeRecordName}
						/>
						{#if !nativeRecording}
							<button
								type="button"
								class="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 flex items-center gap-1"
								on:click={nativeStartRecording}
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
								on:click={nativeStopRecording}
							>
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3 h-3">
									<rect x="4" y="4" width="8" height="8" rx="1" />
								</svg>
								{$i18n.t('Stop')}
							</button>
						{/if}
					</div>

					<!-- Active Idle Status -->
					{#if nativeIdleAnimation}
						<div class="flex items-center gap-2 bg-indigo-900/50 rounded px-2 py-1.5 mt-1">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5 text-indigo-400">
								<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.5 3a.5.5 0 0 1 1 0v4a.5.5 0 0 1-.276.447l-2 1a.5.5 0 1 1-.448-.894L7.5 7.618V4Z" />
							</svg>
							<span class="text-xs text-indigo-200 flex-1 truncate">{$i18n.t('Idle')}: {nativeIdleAnimation.name}</span>
							<Tooltip content={$i18n.t('Stop Idle')}>
								<button
									type="button"
									class="p-1 rounded hover:bg-gray-700 text-red-400"
									on:click={() => { nativeIdleAnimation = null; nativeStatus = 'Idle animation stopped'; }}
								>
									<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
										<path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z" clip-rule="evenodd" />
									</svg>
								</button>
							</Tooltip>
						</div>
					{/if}

					<!-- Animation Presets List -->
					{#if animationPresets.length > 0 || loadingAnimations}
						<div class="text-xs font-medium mt-1">{$i18n.t('Saved Animations')}</div>
						{#if loadingAnimations}
							<div class="text-[10px] text-gray-500">{$i18n.t('Loading...')}</div>
						{:else}
							<div class="flex flex-col gap-1 max-h-32 overflow-y-auto">
								{#each animationPresets as preset}
									<div class="flex items-center gap-1.5 bg-gray-800/50 rounded px-2 py-1.5">
										<div class="flex-1 min-w-0">
											<div class="text-xs font-medium truncate">{preset.name}</div>
											<div class="text-[10px] text-gray-500">{preset.frames.length} frames &middot; {(preset.duration / 1000).toFixed(1)}s</div>
										</div>
										<!-- Set as Idle -->
										<Tooltip content={nativeIdleAnimation?.id === preset.id ? $i18n.t('Active Idle') : $i18n.t('Set as Idle')}>
											<button
												type="button"
												class="p-1 rounded hover:bg-gray-700 {nativeIdleAnimation?.id === preset.id ? 'text-indigo-400' : 'text-gray-400'}"
												on:click={() => setNativeIdleAnimation(preset)}
											>
												<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
													<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.5 3a.5.5 0 0 1 1 0v4a.5.5 0 0 1-.276.447l-2 1a.5.5 0 1 1-.448-.894L7.5 7.618V4Z" />
												</svg>
											</button>
										</Tooltip>
										<!-- Play -->
										<Tooltip content={$i18n.t('Play')}>
											<button
												type="button"
												class="p-1 rounded hover:bg-gray-700 text-green-400"
												on:click={() => playNativeAnimation(preset)}
											>
												<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
													<path d="M3 3.732a1.5 1.5 0 0 1 2.305-1.265l6.706 4.267a1.5 1.5 0 0 1 0 2.531l-6.706 4.268A1.5 1.5 0 0 1 3 12.267V3.732Z" />
												</svg>
											</button>
										</Tooltip>
										<!-- Stop -->
										<Tooltip content={$i18n.t('Stop')}>
											<button
												type="button"
												class="p-1 rounded hover:bg-gray-700 text-yellow-400"
												on:click={() => stopNativeAnimation()}
											>
												<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
													<rect x="3" y="3" width="10" height="10" rx="1" />
												</svg>
											</button>
										</Tooltip>
										<!-- Delete -->
										<Tooltip content={$i18n.t('Delete')}>
											<button
												type="button"
												class="p-1 rounded hover:bg-gray-700 text-red-400"
												on:click={() => deleteNativeAnimation(preset)}
											>
												<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
													<path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
												</svg>
											</button>
										</Tooltip>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
					
					<!-- Import VMC Animations -->
					{#if vmcPresets.length > 0}
						<div class="text-xs font-medium mt-2">{$i18n.t('Import from VMC')}</div>
						<div class="text-[10px] text-gray-500">{$i18n.t('Copy animation presets from VSeeFace/VMC to native')}</div>
						<button
							type="button"
							class="w-full text-xs px-2 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center gap-1.5"
							on:click={importAllVMCPresetsToNative}
						>
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
								<path d="M4 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V6.621a1.5 1.5 0 0 0-.44-1.06L9.94 2.439A1.5 1.5 0 0 0 8.878 2H4Z" />
								<path d="M8.5 6.25A.75.75 0 0 0 7 6.25v2.19L5.78 7.22a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l2.5-2.5a.75.75 0 0 0-1.06-1.06L8.5 8.44V6.25Z" />
							</svg>
							{$i18n.t('Import All VMC Presets')} ({vmcPresets.length})
						</button>
					{/if}

					<!-- Focal Length / FOV -->
					<div class="text-xs font-medium mt-1">{$i18n.t('Focal Length')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Adjusts camera perspective (higher = more telephoto)')}</div>
					<div class="flex items-center gap-2">
						<span class="text-[10px] text-gray-400">70</span>
						<input
							type="range"
							min="70"
							max="240"
							step="5"
							class="flex-1"
							bind:value={nativeFocalLength}
							on:change={() => saveSettings({ nativeFocalLength })}
						/>
						<span class="text-[10px] text-gray-400">240</span>
						<span class="text-xs text-gray-300 w-10 text-right">{nativeFocalLength}mm</span>
					</div>

					<!-- Shader / Lighting -->
					<div class="flex w-full justify-between items-center cursor-pointer hover:bg-gray-700/20 rounded px-1" on:click={() => expandLighting = !expandLighting}>
						<div class="text-xs font-medium">{$i18n.t('Lighting')}</div>
						<span class="text-xs text-gray-400">{expandLighting ? '▼' : '▶'}</span>
					</div>
					{#if expandLighting}
					<div class="text-[10px] text-gray-500">{$i18n.t('Adjust VRM shader and lighting settings')}</div>
					
					<!-- Main Light -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Main Light')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeMainLightIntensity * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="200" step="5" class="w-full mt-0.5" value={nativeMainLightIntensity * 100} on:input={(e) => { nativeMainLightIntensity = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeMainLightIntensity })} />
					</div>
					
					<!-- Ambient Light -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Ambient Light')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeAmbientLightIntensity * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="200" step="5" class="w-full mt-0.5" value={nativeAmbientLightIntensity * 100} on:input={(e) => { nativeAmbientLightIntensity = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeAmbientLightIntensity })} />
					</div>
					
					<!-- Rim Light -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Rim Light')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeRimLightIntensity * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="200" step="5" class="w-full mt-0.5" value={nativeRimLightIntensity * 100} on:input={(e) => { nativeRimLightIntensity = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeRimLightIntensity })} />
					</div>
					
					<!-- Gamma Correction -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Gamma Correction')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeGammaCorrection * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="50" max="200" step="5" class="w-full mt-0.5" value={nativeGammaCorrection * 100} on:input={(e) => { nativeGammaCorrection = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeGammaCorrection })} />
					</div>
					
					<!-- Exposure -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Exposure')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeToneMappingExposure * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="20" max="200" step="5" class="w-full mt-0.5" value={nativeToneMappingExposure * 100} on:input={(e) => { nativeToneMappingExposure = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeToneMappingExposure })} />
					</div>
					
					<!-- Contrast -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Contrast')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeContrast * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="50" max="150" step="5" class="w-full mt-0.5" value={nativeContrast * 100} on:input={(e) => { nativeContrast = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeContrast })} />
					</div>
					
					<!-- Saturation -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Saturation')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeSaturation * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="200" step="5" class="w-full mt-0.5" value={nativeSaturation * 100} on:input={(e) => { nativeSaturation = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeSaturation })} />
					</div>
					
					<!-- MToon Highlights Section -->
					<div class="text-xs font-medium mt-2">{$i18n.t('Highlights (MToon)')}</div>
					
					<!-- MatCap Intensity -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Highlight Shine')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeMatcapIntensity * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="100" step="5" class="w-full mt-0.5" value={nativeMatcapIntensity * 100} on:input={(e) => { nativeMatcapIntensity = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeMatcapIntensity })} />
					</div>
					
					<!-- Rim Fresnel Power -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Edge Sharpness')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{nativeRimFresnelPower.toFixed(1)}</span>
						</div>
						<input type="range" min="1" max="10" step="0.5" class="w-full mt-0.5" value={nativeRimFresnelPower} on:input={(e) => { nativeRimFresnelPower = parseFloat(e.currentTarget.value); }} on:change={() => saveSettings({ nativeRimFresnelPower })} />
					</div>
					
					<!-- Rim Lift -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Edge Glow')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{(nativeRimLift * 100).toFixed(0)}%</span>
						</div>
						<input type="range" min="0" max="100" step="5" class="w-full mt-0.5" value={nativeRimLift * 100} on:input={(e) => { nativeRimLift = parseInt(e.currentTarget.value) / 100; }} on:change={() => saveSettings({ nativeRimLift })} />
					</div>
					
					<!-- Rest Pose (Arms Down) -->
					<div>
						<div class="flex w-full justify-between items-center">
							<div class="text-xs">{$i18n.t('Arms Down')}</div>
							<span class="text-xs text-gray-400 w-12 text-right">{nativeRestPose}%</span>
						</div>
						<input type="range" min="0" max="100" step="5" class="w-full mt-0.5" bind:value={nativeRestPose} on:change={() => saveSettings({ nativeRestPose })} />
					</div>
					{/if}

					<!-- Camera Controls -->
					<div class="text-xs font-medium mt-1">{$i18n.t('Camera Controls')}</div>
					<div class="flex gap-1.5">
						<button
							type="button"
							class="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-700 text-white flex items-center justify-center gap-1"
							on:click={() => vrmNativeRef?.autoFitModel()}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M15 3h6v6" />
								<path d="M9 21H3v-6" />
								<path d="M21 3l-7 7" />
								<path d="M3 21l7-7" />
							</svg>
							{$i18n.t('Auto-Fit')}
						</button>
						<button
							type="button"
							class="flex-1 text-xs px-2 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white flex items-center justify-center gap-1"
							on:click={() => vrmNativeRef?.resetView()}
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
								<path d="M3 3v5h5" />
							</svg>
							{$i18n.t('Reset View')}
						</button>
					</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Use Alt+drag to rotate, Ctrl+right-drag to pan for large models')}</div>

					<!-- Camera Presets -->
					<div class="text-xs font-medium mt-2">{$i18n.t('Camera Presets')}</div>
					<div class="text-[10px] text-gray-500">{$i18n.t('Save and load camera positions. Last used is auto-saved.')}</div>
					
					<!-- Save new preset -->
					<div class="flex items-center gap-1.5 mt-1">
						<input
							type="text"
							class="flex-1 text-xs px-1.5 py-1 rounded border border-gray-600 bg-transparent min-w-0"
							placeholder={$i18n.t('Preset name')}
							bind:value={cameraPresetName}
						/>
						<button
							type="button"
							class="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
							on:click={saveCameraPresetFromCurrent}
						>
							{$i18n.t('Save')}
						</button>
					</div>

					<!-- Preset list -->
					{#if cameraPresets.length > 0}
						<div class="flex flex-col gap-1 mt-1.5 max-h-32 overflow-y-auto">
							{#each cameraPresets.filter(p => !p.id.startsWith('last:')) as preset}
								<div class="flex items-center gap-1.5 bg-gray-800/50 rounded px-2 py-1.5">
									<div class="flex-1 min-w-0">
										<div class="text-xs font-medium truncate">{preset.name}</div>
										<div class="text-[10px] text-gray-500">
											{preset.focalLength}mm &middot; Saved {new Date(preset.timestamp).toLocaleDateString()}
										</div>
									</div>
									<Tooltip content={$i18n.t('Apply')}>
										<button
											type="button"
											class="p-1 rounded hover:bg-gray-700 text-green-400"
											on:click={() => applyCameraPreset(preset)}
										>
											<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
												<path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" />
											</svg>
										</button>
									</Tooltip>
									<Tooltip content={$i18n.t('Delete')}>
										<button
											type="button"
											class="p-1 rounded hover:bg-gray-700 text-red-400"
											on:click={() => deleteCameraPresetById(preset.id)}
										>
											<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5">
												<path fill-rule="evenodd" d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5Z" clip-rule="evenodd" />
											</svg>
										</button>
									</Tooltip>
								</div>
							{/each}
						</div>
					{:else if !loadingPresets}
						<div class="text-[10px] text-gray-500 py-1">{$i18n.t('No saved presets yet')}</div>
					{/if}

					<!-- Status -->
					{#if nativeStatus}
						<div class="text-xs text-blue-400 bg-blue-900/30 rounded px-2 py-1">{nativeStatus}</div>
					{/if}
				</div>
				{/if}

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

				<!-- Background Blur (simple, when gradient disabled) -->
				{#if !vrmBgGradientEnabled}
				<div>
					<div class="flex w-full justify-between items-center">
						<div class="text-xs">{$i18n.t('Background Blur')}</div>
						<span class="text-xs text-gray-400 w-10 text-right">{vrmBgBlur}px</span>
					</div>
					<input type="range" min="0" max="20" step="1" class="w-full mt-0.5" bind:value={vrmBgBlur} on:change={() => saveSettings({ vrmBgBlur })} />
				</div>
				{/if}

				<!-- Gradient Toggle -->
				<div class="flex w-full justify-between items-center">
					<div class="text-xs">{$i18n.t('Gradient Transparency')}</div>
					<Switch bind:state={vrmBgGradientEnabled} on:change={() => saveSettings({ vrmBgGradientEnabled })} />
				</div>

				<!-- Gradient Controls -->
				{#if vrmBgGradientEnabled}
				<div class="flex w-full justify-between items-center cursor-pointer hover:bg-gray-700/20 rounded px-1" on:click={() => expandGradient = !expandGradient}>
					<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide">{$i18n.t('Gradient Controls')}</div>
					<span class="text-xs text-gray-400">{expandGradient ? '▼' : '▶'}</span>
				</div>
				{#if expandGradient}
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

					<!-- Gradient Blur Controls - mirrored from opacity -->
					<div class="mt-2 pt-2 border-t border-gray-700">
						<div class="text-xs text-gray-400 mb-1">Blur Gradient </div>
						<div>
							<div class="flex w-full justify-between items-center">
								<div class="text-xs">{$i18n.t('Blur Angle')}</div>
								<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientBlurAngle}°</span>
							</div>
							<input type="range" min="0" max="360" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientBlurAngle} on:change={() => saveSettings({ vrmBgGradientBlurAngle })} />
						</div>
						<div>
							<div class="flex w-full justify-between items-center">
								<div class="text-xs">{$i18n.t('Start Blur')}</div>
								<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientStartBlur}px</span>
							</div>
							<input type="range" min="0" max="20" step="0.5" class="w-full mt-0.5" bind:value={vrmBgGradientStartBlur} on:change={() => saveSettings({ vrmBgGradientStartBlur })} />
						</div>
						<div>
							<div class="flex w-full justify-between items-center">
								<div class="text-xs">{$i18n.t('Mid Blur')}</div>
								<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientMidBlur}px</span>
							</div>
							<input type="range" min="0" max="20" step="0.5" class="w-full mt-0.5" bind:value={vrmBgGradientMidBlur} on:change={() => saveSettings({ vrmBgGradientMidBlur })} />
						</div>
						<div>
							<div class="flex w-full justify-between items-center">
								<div class="text-xs">{$i18n.t('End Blur')}</div>
								<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientEndBlur}px</span>
							</div>
							<input type="range" min="0" max="20" step="0.5" class="w-full mt-0.5" bind:value={vrmBgGradientEndBlur} on:change={() => saveSettings({ vrmBgGradientEndBlur })} />
						</div>
						<div>
							<div class="flex w-full justify-between items-center">
								<div class="text-xs">{$i18n.t('Blur Midpoint')}</div>
								<span class="text-xs text-gray-400 w-10 text-right">{vrmBgGradientBlurMidpoint}%</span>
							</div>
							<input type="range" min="0" max="100" step="1" class="w-full mt-0.5" bind:value={vrmBgGradientBlurMidpoint} on:change={() => saveSettings({ vrmBgGradientBlurMidpoint })} />
						</div>
					</div>
				</div>
				{/if}
				{/if}

				<!-- Chroma Key section (only for camera mode) -->
				{#if vrmRenderMode === 'camera'}
				<div class="flex w-full justify-between items-center cursor-pointer hover:bg-gray-700/20 rounded px-1" on:click={() => expandChromaKey = !expandChromaKey}>
					<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide">{$i18n.t('Chroma Key')}</div>
					<span class="text-xs text-gray-400">{expandChromaKey ? '▼' : '▶'}</span>
				</div>
				{#if expandChromaKey}

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
				{/if}
				{/if}

				<!-- Layers Section -->
				<div class="flex w-full justify-between items-center cursor-pointer hover:bg-gray-700/20 rounded px-1" on:click={() => expandLayers = !expandLayers}>
					<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide">{$i18n.t('Layers')}</div>
					<span class="text-xs text-gray-400">{expandLayers ? '▼' : '▶'}</span>
				</div>
				{#if expandLayers}

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
				{/if}

				<!-- ── VMC Animations ────────────────────────────────── -->
				<div class="text-xs font-semibold text-gray-400 uppercase tracking-wide mt-2 mb-1">{$i18n.t('VMC Animations')}</div>

				{#if vrmRenderMode === 'native'}
					<!-- Native mode doesn't use VMC -->
					<div class="text-xs text-gray-500 bg-gray-800/50 rounded px-3 py-2">
						<div class="font-medium text-gray-400 mb-1">{$i18n.t('Not Available in Native Mode')}</div>
						<p>{$i18n.t('VMC animations control VSeeFace via OSC. In native mode, use the face tracking and recording controls above instead.')}</p>
					</div>
				{:else}
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
				{/if}
			</div>
		</div>
	{/if}
{/if}
