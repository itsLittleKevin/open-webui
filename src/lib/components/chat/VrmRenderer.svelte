<script lang="ts">
	import { onMount, onDestroy, createEventDispatcher } from 'svelte';
	import * as THREE from 'three';
	import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
	import { VRMLoaderPlugin, VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';
	import { MToonMaterial } from '@pixiv/three-vrm';
	import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

	const dispatch = createEventDispatcher();

	// Props
	export let width = 280;
	export let height = 280;
	export let backgroundColor = 0x000000;
	export let backgroundAlpha = 0.2;
	
	// Lighting props
	export let mainLightColor = 0xffffff;
	export let mainLightIntensity = 1.0;
	export let ambientLightColor = 0xffffff;
	export let ambientLightIntensity = 0.4;
	export let fillLightColor = 0xffffff;
	export let fillLightIntensity = 0.3;
	export let rimLightColor = 0xaaccff;
	export let rimLightIntensity = 0.5;
	export let gammaCorrection = 1.0;
	export let toneMappingExposure = 1.0;
	
	// Post-processing style adjustments (CSS filters)
	export let contrast = 1.0;
	export let saturation = 1.0;
	
	// MToon shader enhancements
	export let matcapIntensity = 0.5;
	export let rimFresnelPower = 3.0;
	export let rimLift = 0.3;
	
	// Rest pose - arms down instead of T-pose
	export let restPose = true;
	
	// Focal length (mm) - simulates camera lens, 70-240mm range
	// Higher values = more telephoto/compressed look (like VSeeFace 135mm)
	export let focalLength = 135;
	
	// Exposed VRM instance for external control
	export let vrm: VRM | null = null;
	export let loading = false;
	export let error = '';

	let canvasEl: HTMLCanvasElement;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let clock: THREE.Clock | null = null;
	let animFrameId: number = 0;

	// Lighting references
	let ambientLight: THREE.AmbientLight | null = null;
	let mainLight: THREE.DirectionalLight | null = null;
	let fillLight: THREE.DirectionalLight | null = null;
	let rimLight: THREE.DirectionalLight | null = null;
	let pmremGenerator: THREE.PMREMGenerator | null = null;
	let matcapTexture: THREE.Texture | null = null;

	// Camera control state
	let cameraDistance = 1.2;
	let cameraTargetY = 1.2;
	let cameraOffsetX = 0;
	let cameraOffsetY = 0;
	
	// Model rotation state
	let modelRotationX = 0;
	let modelRotationY = Math.PI; // Start facing camera
	
	// Light position (spherical coordinates)
	let lightTheta = Math.PI / 4;  // Horizontal angle
	let lightPhi = Math.PI / 4;    // Vertical angle
	let lightDistance = 2;

	// Mouse interaction state
	let isDragging = false;
	let dragButton = 0;
	let lastMouseX = 0;
	let lastMouseY = 0;

	// Lip sync state
	let currentMouthOpen = 0;
	let targetMouthOpen = 0;
	let currentViseme = '';

	// Expression layering for additive blending
	// Base layer = idle animation, Overlay layer = expression animations (smile, etc.)
	// Lip sync layer = mouth shapes from TTS audio
	let expressionBaseLayer: Record<string, number> = {};
	let expressionOverlayLayer: Record<string, number> = {};
	let expressionLipSyncLayer: Record<string, number> = {};
	let useAdditiveBlending = true;

	// VRM blend shape names (VRM1.0 uses these expression names)
	const VISEME_MAP: Record<string, string> = {
		'A': 'aa',
		'I': 'ih', 
		'U': 'ou',
		'E': 'ee',
		'O': 'oh',
		'neutral': 'neutral'
	};
	
	// Viseme blending settings
	const VISEME_BLEND_SPEED = 0.3;  // 0-1, how fast to blend towards target viseme
	let visemeTargetWeights: Record<string, number> = {};
	let visemeCurrentWeights: Record<string, number> = {};

	// Expression name mapping: various input names → VRM expression names
	// VRM 1.0 preset names: happy, angry, sad, relaxed, surprised
	// VRM 0.x preset names: Joy, Angry, Sorrow, Fun
	// VSeeFace/ARKit may use: smile, anger, sadness, etc.
	const EXPRESSION_MAP: Record<string, string[]> = {
		// Happy/Joy/Smile → try these in order
		'happy': ['happy', 'joy', 'Joy', 'smile', 'Smile'],
		'joy': ['happy', 'joy', 'Joy', 'smile'],
		'smile': ['happy', 'joy', 'Joy', 'smile', 'Smile'],
		
		// Angry
		'angry': ['angry', 'Angry', 'anger', 'Anger'],
		'anger': ['angry', 'Angry', 'anger'],
		
		// Sad/Sorrow
		'sad': ['sad', 'sorrow', 'Sorrow', 'sadness', 'Sadness'],
		'sorrow': ['sad', 'sorrow', 'Sorrow'],
		'sadness': ['sad', 'sorrow', 'Sorrow', 'sadness'],
		
		// Surprised/Fun
		'surprised': ['surprised', 'Surprised', 'surprise', 'fun', 'Fun'],
		'surprise': ['surprised', 'Surprised', 'surprise', 'fun', 'Fun'],
		'fun': ['surprised', 'fun', 'Fun'],
		
		// Relaxed
		'relaxed': ['relaxed', 'Relaxed', 'neutral', 'Neutral'],
		
		// Blink variations
		'blinkleft': ['blinkLeft', 'Blink_L', 'blink_l', 'eyeBlinkLeft'],
		'blinkright': ['blinkRight', 'Blink_R', 'blink_r', 'eyeBlinkRight'],
		'blink_l': ['blinkLeft', 'Blink_L', 'blink_l'],
		'blink_r': ['blinkRight', 'Blink_R', 'blink_r'],
		'eyeblinkleft': ['blinkLeft', 'Blink_L', 'eyeBlinkLeft'],
		'eyeblinkright': ['blinkRight', 'Blink_R', 'eyeBlinkRight'],
		'blink': ['blink', 'Blink'],
		
		// Mouth shapes (for lip sync / expressions)
		'aa': ['aa', 'A', 'a'],
		'ih': ['ih', 'I', 'i'],
		'ou': ['ou', 'U', 'u'],
		'ee': ['ee', 'E', 'e'],
		'oh': ['oh', 'O', 'o'],
		
		// Look directions
		'lookleft': ['lookLeft', 'LookLeft', 'lookLeft'],
		'lookright': ['lookRight', 'LookRight', 'lookRight'],
		'lookup': ['lookUp', 'LookUp', 'lookUp'],
		'lookdown': ['lookDown', 'LookDown', 'lookDown'],
	};

	// Zoom levels for stepped zoom (extended for large models)
	const ZOOM_LEVELS = [0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
	let currentZoomIndex = 6; // Start at 1.0x

	// Convert focal length (mm) to vertical FOV (degrees)
	// Based on 35mm full-frame sensor (36x24mm), using vertical dimension
	const SENSOR_HEIGHT = 24; // mm
	function focalLengthToFOV(fl: number): number {
		return 2 * Math.atan(SENSOR_HEIGHT / (2 * fl)) * (180 / Math.PI);
	}

	// Reactive: update camera FOV when focalLength changes
	$: if (camera && focalLength) {
		camera.fov = focalLengthToFOV(focalLength);
		camera.updateProjectionMatrix();
	}
	
	// Reactive: update lighting when props change
	$: if (mainLight) mainLight.intensity = mainLightIntensity;
	$: if (ambientLight) ambientLight.intensity = ambientLightIntensity;
	$: if (rimLight) rimLight.intensity = rimLightIntensity;
	$: if (scene) scene.environmentIntensity = 0.6; // Fixed environment intensity
	$: if (renderer && toneMappingExposure !== undefined) renderer.toneMappingExposure = toneMappingExposure;

	function initScene() {
		if (!canvasEl) return;

		// Scene
		scene = new THREE.Scene();

		// Camera - positioned to frame upper body/face
		// FOV calculated from focal length (mm)
		const fov = focalLengthToFOV(focalLength);
		camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 100);
		updateCameraPosition();

		// Renderer
		renderer = new THREE.WebGLRenderer({
			canvas: canvasEl,
			alpha: true,
			antialias: true,
			powerPreference: 'high-performance'
		});
		renderer.setSize(width, height);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.setClearColor(backgroundColor, backgroundAlpha);
		
		// Tone mapping for better HDR-like rendering (VSeeFace uses similar)
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		
		// Environment map for reflections (key for MToon materials)
		pmremGenerator = new THREE.PMREMGenerator(renderer);
		pmremGenerator.compileEquirectangularShader();
		
		// Create a studio-like environment for reflections
		const roomEnv = new RoomEnvironment();
		const envTexture = pmremGenerator.fromScene(roomEnv).texture;
		scene.environment = envTexture;
		scene.environmentIntensity = 0.6; // Fixed environment intensity
		roomEnv.dispose();

		// Lighting
		ambientLight = new THREE.AmbientLight(ambientLightColor, ambientLightIntensity);
		scene.add(ambientLight);

		mainLight = new THREE.DirectionalLight(mainLightColor, mainLightIntensity);
		updateLightPosition();
		scene.add(mainLight);

		// Softer fill light from below
		fillLight = new THREE.DirectionalLight(fillLightColor, fillLightIntensity);
		fillLight.position.set(-0.5, -0.5, 0.5);
		scene.add(fillLight);
		
		// Rim light for edge highlights (VSeeFace-like effect)
		rimLight = new THREE.DirectionalLight(rimLightColor, rimLightIntensity);
		rimLight.position.set(-1, 0.5, -1); // From behind-left
		scene.add(rimLight);

		clock = new THREE.Clock();

		// Add event listeners for mouse interactions
		// Use capture phase to intercept events before parent handlers
		canvasEl.addEventListener('wheel', handleWheel, { passive: false, capture: true });
		canvasEl.addEventListener('mousedown', handleMouseDown, { capture: true });
		canvasEl.addEventListener('contextmenu', handleContextMenu, { capture: true });
		window.addEventListener('mousemove', handleMouseMove, { capture: true });
		window.addEventListener('mouseup', handleMouseUp, { capture: true });
	}

	function updateCameraPosition() {
		if (!camera) return;
		
		camera.position.set(
			cameraOffsetX,
			cameraTargetY + cameraOffsetY,
			cameraDistance
		);
		camera.lookAt(cameraOffsetX, cameraTargetY + cameraOffsetY, 0);
	}

	function updateLightPosition() {
		if (!mainLight) return;
		
		// Convert spherical to Cartesian coordinates
		const x = lightDistance * Math.sin(lightPhi) * Math.cos(lightTheta);
		const y = lightDistance * Math.cos(lightPhi);
		const z = lightDistance * Math.sin(lightPhi) * Math.sin(lightTheta);
		
		mainLight.position.set(x, y, z);
	}

	function updateModelRotation() {
		if (!vrm) return;
		vrm.scene.rotation.set(modelRotationX, modelRotationY, 0);
	}

	/**
	 * Generate a procedural MatCap texture for anime-style highlights
	 * This creates a spherical gradient that simulates shiny highlights
	 */
	function generateMatCapTexture(): THREE.Texture {
		const size = 256;
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d')!;
		
		// Create radial gradient for highlight effect
		const centerX = size / 2;
		const centerY = size / 3; // Offset upward for top-down lighting
		
		// Base color (subtle)
		ctx.fillStyle = '#888888';
		ctx.fillRect(0, 0, size, size);
		
		// Main highlight (white, top-left)
		const highlight = ctx.createRadialGradient(
			centerX - size * 0.2, centerY - size * 0.1, 0,
			centerX - size * 0.2, centerY - size * 0.1, size * 0.5
		);
		highlight.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
		highlight.addColorStop(0.3, 'rgba(255, 255, 255, 0.4)');
		highlight.addColorStop(0.6, 'rgba(200, 200, 220, 0.1)');
		highlight.addColorStop(1, 'rgba(128, 128, 140, 0)');
		ctx.fillStyle = highlight;
		ctx.fillRect(0, 0, size, size);
		
		// Secondary highlight (smaller, sharper)
		const highlight2 = ctx.createRadialGradient(
			centerX - size * 0.25, centerY - size * 0.2, 0,
			centerX - size * 0.25, centerY - size * 0.2, size * 0.15
		);
		highlight2.addColorStop(0, 'rgba(255, 255, 255, 1)');
		highlight2.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
		highlight2.addColorStop(1, 'rgba(255, 255, 255, 0)');
		ctx.fillStyle = highlight2;
		ctx.fillRect(0, 0, size, size);
		
		// Rim light effect (edge glow)
		const rim = ctx.createRadialGradient(
			centerX, centerY + size * 0.3, size * 0.3,
			centerX, centerY + size * 0.3, size * 0.55
		);
		rim.addColorStop(0, 'rgba(100, 120, 160, 0)');
		rim.addColorStop(0.7, 'rgba(150, 170, 220, 0.3)');
		rim.addColorStop(1, 'rgba(180, 200, 255, 0.5)');
		ctx.fillStyle = rim;
		ctx.fillRect(0, 0, size, size);
		
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		return texture;
	}

	/**
	 * Enhance MToon materials with MatCap and parametric rim lighting
	 */
	function enhanceMToonMaterials() {
		if (!vrm) return;
		
		// Generate matcap texture if needed
		if (!matcapTexture) {
			matcapTexture = generateMatCapTexture();
		}
		
		vrm.scene.traverse((obj) => {
			if ((obj as THREE.Mesh).isMesh) {
				const mesh = obj as THREE.Mesh;
				const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
				
				for (const mat of materials) {
					// Check if it's an MToon material
					if (mat && (mat as any).isMToonMaterial) {
						const mtoon = mat as MToonMaterial;
						
						// Apply MatCap texture for highlights
						if (matcapIntensity > 0) {
							mtoon.matcapTexture = matcapTexture;
							// MatCap factor controls the intensity (color multiplier)
							mtoon.matcapFactor?.setScalar(matcapIntensity);
						}
						
						// Enhance parametric rim lighting
						if (mtoon.parametricRimColorFactor) {
							// Use the rim light color from props
							const rimColor = new THREE.Color(rimLightColor);
							mtoon.parametricRimColorFactor.copy(rimColor);
						}
						if (mtoon.parametricRimFresnelPowerFactor !== undefined) {
							mtoon.parametricRimFresnelPowerFactor = rimFresnelPower;
						}
						if (mtoon.parametricRimLiftFactor !== undefined) {
							mtoon.parametricRimLiftFactor = rimLift;
						}
						
						// Mark material for update (cast to Material to access needsUpdate)
						(mtoon as THREE.Material).needsUpdate = true;
					}
				}
			}
		});
	}

	// Reactive updates for MToon parameters
	$: if (vrm && matcapIntensity !== undefined) enhanceMToonMaterials();
	$: if (vrm && rimFresnelPower !== undefined) enhanceMToonMaterials();
	$: if (vrm && rimLift !== undefined) enhanceMToonMaterials();

	/**
	 * Apply rest pose - rotate arms down from T-pose to natural position
	 * VSeeFace calls this "cancel T-pose"
	 */
	function applyRestPose() {
		if (!vrm?.humanoid) return;
		
		// Get arm bones
		const leftUpperArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
		const rightUpperArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
		const leftLowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
		const rightLowerArm = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
		const leftHand = vrm.humanoid.getNormalizedBoneNode('leftHand');
		const rightHand = vrm.humanoid.getNormalizedBoneNode('rightHand');
		
		if (restPose) {
			// Rotate upper arms down (~70 degrees)
			// Left arm rotates positively around Z, right arm negatively
			if (leftUpperArm) {
				leftUpperArm.rotation.set(0, 0, 1.2); // ~70 degrees down
			}
			if (rightUpperArm) {
				rightUpperArm.rotation.set(0, 0, -1.2);
			}
			
			// Slight elbow bend for natural look
			if (leftLowerArm) {
				leftLowerArm.rotation.set(0, 0, 0.15);
			}
			if (rightLowerArm) {
				rightLowerArm.rotation.set(0, 0, -0.15);
			}
			
			// Natural hand rotation
			if (leftHand) {
				leftHand.rotation.set(0, 0, 0.1);
			}
			if (rightHand) {
				rightHand.rotation.set(0, 0, -0.1);
			}
		} else {
			// Reset to T-pose
			if (leftUpperArm) leftUpperArm.rotation.set(0, 0, 0);
			if (rightUpperArm) rightUpperArm.rotation.set(0, 0, 0);
			if (leftLowerArm) leftLowerArm.rotation.set(0, 0, 0);
			if (rightLowerArm) rightLowerArm.rotation.set(0, 0, 0);
			if (leftHand) leftHand.rotation.set(0, 0, 0);
			if (rightHand) rightHand.rotation.set(0, 0, 0);
		}
	}
	
	// Reactive update for rest pose
	$: if (vrm) applyRestPose();
	$: if (vrm && restPose !== undefined) applyRestPose();

	// ── Mouse Event Handlers ───────────────────────────────────────────

	function handleContextMenu(e: MouseEvent) {
		// Prevent context menu when using Alt/Ctrl + right click
		if (e.altKey || e.ctrlKey) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	}

	function handleWheel(e: WheelEvent) {
		// Alt + Scroll: Stepped zoom
		if (e.altKey) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			
			if (e.deltaY < 0) {
				// Scroll up - zoom in
				currentZoomIndex = Math.min(currentZoomIndex + 1, ZOOM_LEVELS.length - 1);
			} else {
				// Scroll down - zoom out
				currentZoomIndex = Math.max(currentZoomIndex - 1, 0);
			}
			
			cameraDistance = 1.2 / ZOOM_LEVELS[currentZoomIndex];
			updateCameraPosition();
			
			dispatch('zoomChange', { zoom: ZOOM_LEVELS[currentZoomIndex] });
		}
	}

	function handleMouseDown(e: MouseEvent) {
		// Only handle when Alt or Ctrl is pressed
		if (!e.altKey && !e.ctrlKey) return;
		
		// Stop propagation to prevent parent window drag
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		
		isDragging = true;
		dragButton = e.button;
		lastMouseX = e.clientX;
		lastMouseY = e.clientY;
	}

	function handleMouseMove(e: MouseEvent) {
		if (!isDragging) return;
		
		// Stop propagation while dragging with modifier
		e.preventDefault();
		e.stopPropagation();
		
		const deltaX = e.clientX - lastMouseX;
		const deltaY = e.clientY - lastMouseY;
		lastMouseX = e.clientX;
		lastMouseY = e.clientY;

		if (e.altKey) {
			if (dragButton === 0) {
				// Alt + Left click drag: Rotate model
				modelRotationY += deltaX * 0.01;
				modelRotationX += deltaY * 0.01;
				// Clamp vertical rotation
				modelRotationX = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, modelRotationX));
				updateModelRotation();
				
				dispatch('modelRotate', { x: modelRotationX, y: modelRotationY });
			} else if (dragButton === 2) {
				// Alt + Right click drag (up/down): Precise zoom
				cameraDistance -= deltaY * 0.005;
				cameraDistance = Math.max(0.2, Math.min(15, cameraDistance));
				updateCameraPosition();
				
				// Update zoom index to closest
				const currentZoom = 1.2 / cameraDistance;
				currentZoomIndex = ZOOM_LEVELS.findIndex(z => z >= currentZoom) || 0;
				
				dispatch('zoomChange', { zoom: currentZoom });
			}
		} else if (e.ctrlKey) {
			if (dragButton === 0) {
				// Ctrl + Left click drag: Move lighting
				lightTheta += deltaX * 0.01;
				lightPhi -= deltaY * 0.01;
				// Clamp phi to avoid going through poles
				lightPhi = Math.max(0.1, Math.min(Math.PI - 0.1, lightPhi));
				updateLightPosition();
				
				dispatch('lightMove', { theta: lightTheta, phi: lightPhi });
			} else if (dragButton === 2) {
				// Ctrl + Right click drag: Pan camera
				cameraOffsetX -= deltaX * 0.003;
				cameraOffsetY += deltaY * 0.003;
				// Extended limits for tall/large models (2.9m+)
				cameraOffsetX = Math.max(-4, Math.min(4, cameraOffsetX));
				cameraOffsetY = Math.max(-4, Math.min(4, cameraOffsetY));
				updateCameraPosition();
				
				dispatch('cameraPan', { x: cameraOffsetX, y: cameraOffsetY });
			}
		}
	}

	function handleMouseUp() {
		isDragging = false;
	}

	// ── Exported Control Functions ─────────────────────────────────────

	export function setZoom(zoom: number) {
		cameraDistance = 1.2 / zoom;
		updateCameraPosition();
	}

	export function resetView() {
		cameraDistance = 1.2;
		cameraTargetY = 1.2;
		cameraOffsetX = 0;
		cameraOffsetY = 0;
		modelRotationX = 0;
		modelRotationY = Math.PI;
		lightTheta = Math.PI / 4;
		lightPhi = Math.PI / 4;
		currentZoomIndex = 6; // 1.0x in extended zoom levels
		
		updateCameraPosition();
		updateLightPosition();
		updateModelRotation();
	}

	export function setMainLightColor(color: number) {
		if (mainLight) {
			mainLight.color.setHex(color);
		}
	}

	export function setMainLightIntensity(intensity: number) {
		if (mainLight) {
			mainLight.intensity = intensity;
		}
	}

	export function setAmbientLightColor(color: number) {
		if (ambientLight) {
			ambientLight.color.setHex(color);
		}
	}

	export function setAmbientLightIntensity(intensity: number) {
		if (ambientLight) {
			ambientLight.intensity = intensity;
		}
	}

	export function setFocalLength(fl: number) {
		// Clamp to 70-240mm range
		focalLength = Math.max(70, Math.min(240, fl));
		if (camera) {
			camera.fov = focalLengthToFOV(focalLength);
			camera.updateProjectionMatrix();
		}
	}

	export function getFocalLength(): number {
		return focalLength;
	}

	/**
	 * Auto-fit the camera to frame the loaded VRM model
	 * Useful for tall/large models that don't fit in default view
	 */
	export function autoFitModel(): void {
		if (!vrm || !camera) return;

		// Calculate bounding box of the VRM
		const box = new THREE.Box3().setFromObject(vrm.scene);
		const size = new THREE.Vector3();
		const center = new THREE.Vector3();
		box.getSize(size);
		box.getCenter(center);

		// Get the largest dimension
		const maxDim = Math.max(size.x, size.y, size.z);
		const fov = camera.fov * (Math.PI / 180);
		
		// Calculate distance needed to fit the model
		// Add some padding (1.2x) for comfortable framing
		let fitDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.2;
		
		// Clamp to reasonable range
		fitDistance = Math.max(0.5, Math.min(12, fitDistance));
		
		// Update camera position
		cameraDistance = fitDistance;
		cameraTargetY = center.y;
		cameraOffsetX = 0;
		cameraOffsetY = 0;
		
		updateCameraPosition();
		
		dispatch('autoFit', { 
			modelHeight: size.y, 
			modelCenter: center.y, 
			distance: fitDistance 
		});
	}

	/**
	 * Get current model dimensions (useful for UI display)
	 */
	export function getModelDimensions(): { width: number; height: number; depth: number } | null {
		if (!vrm) return null;
		
		const box = new THREE.Box3().setFromObject(vrm.scene);
		const size = new THREE.Vector3();
		box.getSize(size);
		
		return { width: size.x, height: size.y, depth: size.z };
	}

	/**
	 * Camera state type for presets
	 */
	export interface CameraState {
		cameraDistance: number;
		cameraTargetY: number;
		cameraOffsetX: number;
		cameraOffsetY: number;
		modelRotationX: number;
		modelRotationY: number;
		focalLength: number;
		lightTheta: number;
		lightPhi: number;
	}

	/**
	 * Get the current camera/view state for saving as a preset
	 */
	export function getCameraState(): CameraState {
		return {
			cameraDistance,
			cameraTargetY,
			cameraOffsetX,
			cameraOffsetY,
			modelRotationX,
			modelRotationY,
			focalLength,
			lightTheta,
			lightPhi
		};
	}

	/**
	 * Set the camera/view state from a preset
	 */
	export function setCameraState(state: Partial<CameraState>): void {
		if (state.cameraDistance !== undefined) cameraDistance = state.cameraDistance;
		if (state.cameraTargetY !== undefined) cameraTargetY = state.cameraTargetY;
		if (state.cameraOffsetX !== undefined) cameraOffsetX = state.cameraOffsetX;
		if (state.cameraOffsetY !== undefined) cameraOffsetY = state.cameraOffsetY;
		if (state.modelRotationX !== undefined) modelRotationX = state.modelRotationX;
		if (state.modelRotationY !== undefined) modelRotationY = state.modelRotationY;
		if (state.focalLength !== undefined) {
			focalLength = state.focalLength;
			if (camera) {
				camera.fov = focalLengthToFOV(focalLength);
				camera.updateProjectionMatrix();
			}
		}
		if (state.lightTheta !== undefined) lightTheta = state.lightTheta;
		if (state.lightPhi !== undefined) lightPhi = state.lightPhi;

		updateCameraPosition();
		updateLightPosition();
		updateModelRotation();
	}

	export async function loadVRM(file: File | ArrayBuffer | string): Promise<void> {
		if (!scene) {
			throw new Error('Scene not initialized');
		}

		loading = true;
		error = '';

		// Remove existing VRM
		if (vrm) {
			scene.remove(vrm.scene);
			vrm = null;
		}

		try {
			const loader = new GLTFLoader();
			loader.register((parser) => new VRMLoaderPlugin(parser));

			let url: string;
			let blobUrl: string | null = null;

			if (file instanceof File) {
				blobUrl = URL.createObjectURL(file);
				url = blobUrl;
			} else if (file instanceof ArrayBuffer) {
				const blob = new Blob([file], { type: 'model/gltf-binary' });
				blobUrl = URL.createObjectURL(blob);
				url = blobUrl;
			} else {
				url = file;
			}

			const gltf = await new Promise<any>((resolve, reject) => {
				loader.load(
					url,
					(gltf) => resolve(gltf),
					(progress) => {
						const percent = progress.total > 0 
							? Math.round((progress.loaded / progress.total) * 100) 
							: 0;
						dispatch('progress', { percent });
					},
					(err) => reject(err)
				);
			});

			if (blobUrl) {
				URL.revokeObjectURL(blobUrl);
			}

			const loadedVrm = gltf.userData.vrm as VRM;
			if (!loadedVrm) {
				throw new Error('No VRM data found in file');
			}

			// Rotate VRM to face camera (VRM models face +Z by default)
			loadedVrm.scene.rotation.y = Math.PI;

			scene.add(loadedVrm.scene);
			vrm = loadedVrm;

			// Initialize to neutral expression
			setExpression('neutral', 1.0);
			
			// Apply MToon shader enhancements (MatCap, rim lighting)
			enhanceMToonMaterials();
			
			// Debug: log available expressions
			console.log('[VRM] Available expressions:', getAvailableExpressions());

			dispatch('loaded', { vrm });
			loading = false;

		} catch (e: any) {
			error = e?.message || 'Failed to load VRM';
			loading = false;
			throw e;
		}
	}

	/**
	 * Set expression on the base layer (for idle animations)
	 * When additive blending is enabled, this layer is combined with overlay.
	 */
	export function setExpressionBase(name: string, weight: number = 1.0) {
		const normalizedName = normalizeExpressionName(name);
		if (normalizedName) {
			expressionBaseLayer[normalizedName] = weight;
			if (useAdditiveBlending) {
				applyBlendedExpressions();
			} else {
				applyExpressionDirect(normalizedName, weight);
			}
		}
	}

	/**
	 * Set expression on the overlay layer (for triggered expressions like smile)
	 * These are ADDED on top of base layer values.
	 */
	export function setExpressionOverlay(name: string, weight: number = 1.0) {
		const normalizedName = normalizeExpressionName(name);
		if (normalizedName) {
			expressionOverlayLayer[normalizedName] = weight;
			if (useAdditiveBlending) {
				applyBlendedExpressions();
			} else {
				applyExpressionDirect(normalizedName, weight);
			}
		}
	}

	/**
	 * Clear the overlay layer (after expression animation ends)
	 */
	export function clearExpressionOverlay() {
		expressionOverlayLayer = {};
		if (useAdditiveBlending) {
			applyBlendedExpressions();
		}
	}

	/**
	 * Apply blended expressions to VRM (base + overlay + lipSync)
	 */
	function applyBlendedExpressions() {
		if (!vrm?.expressionManager) return;

		// Collect all unique expression names from all layers
		const allNames = new Set([
			...Object.keys(expressionBaseLayer),
			...Object.keys(expressionOverlayLayer),
			...Object.keys(expressionLipSyncLayer)
		]);

		for (const exprName of allNames) {
			const baseValue = expressionBaseLayer[exprName] ?? 0;
			const overlayValue = expressionOverlayLayer[exprName] ?? 0;
			const lipSyncValue = expressionLipSyncLayer[exprName] ?? 0;
			// Additive blend: clamp to 0-1
			const blendedValue = Math.min(1, Math.max(0, baseValue + overlayValue + lipSyncValue));
			
			applyExpressionDirect(exprName, blendedValue);
		}
	}

	/**
	 * Normalize expression name to VRM-compatible name
	 */
	function normalizeExpressionName(name: string): string | null {
		if (!vrm?.expressionManager) return null;

		const nameLower = name.toLowerCase();
		
		// Build list of expression names to try
		const expressionNames: string[] = [];
		
		// Check our comprehensive mapping first
		if (EXPRESSION_MAP[nameLower]) {
			expressionNames.push(...EXPRESSION_MAP[nameLower]);
		}
		
		// Also try the original name variations
		expressionNames.push(nameLower, name);
		
		// Try VRM preset enum
		const presetName = VRMExpressionPresetName[name as keyof typeof VRMExpressionPresetName];
		if (presetName) expressionNames.push(presetName);
		
		// Find first matching expression
		for (const exprName of expressionNames) {
			try {
				const expression = vrm.expressionManager.getExpression(exprName);
				if (expression) {
					return exprName;
				}
			} catch {
				// Try next name
			}
		}
		return null;
	}

	/**
	 * Apply expression value directly to VRM
	 */
	function applyExpressionDirect(exprName: string, weight: number) {
		if (!vrm?.expressionManager) return;
		try {
			vrm.expressionManager.setValue(exprName, weight);
		} catch {
			// Ignore errors
		}
	}

	/**
	 * Set expression (default: uses base layer for backward compatibility)
	 */
	export function setExpression(name: string, weight: number = 1.0) {
		// Default to base layer for backward compatibility
		setExpressionBase(name, weight);
	}

	/**
	 * Get list of available expression names on the loaded VRM
	 */
	export function getAvailableExpressions(): string[] {
		if (!vrm?.expressionManager) return [];
		
		const expressions: string[] = [];
		const manager = vrm.expressionManager as any;
		
		// Standard VRM 1.0 preset expressions to check
		const presetNames = [
			'happy', 'angry', 'sad', 'relaxed', 'surprised',
			'blink', 'blinkLeft', 'blinkRight',
			'lookUp', 'lookDown', 'lookLeft', 'lookRight',
			'aa', 'ih', 'uu', 'ee', 'oh', 'neutral'
		];
		
		// VRM 0.x style names
		const vrm0Names = [
			'Joy', 'Angry', 'Sorrow', 'Fun',
			'Blink', 'Blink_L', 'Blink_R',
			'LookUp', 'LookDown', 'LookLeft', 'LookRight',
			'A', 'I', 'U', 'E', 'O', 'Neutral'
		];
		
		for (const name of [...presetNames, ...vrm0Names]) {
			try {
				const expr = vrm.expressionManager.getExpression(name);
				if (expr) expressions.push(name);
			} catch { /* ignore */ }
		}
		
		// Also try to get custom expressions if available
		// Handle both Map (has .keys() method) and plain object
		try {
			if (manager._expressionMap) {
				const keys = typeof manager._expressionMap.keys === 'function'
					? Array.from(manager._expressionMap.keys())
					: Object.keys(manager._expressionMap);
				for (const key of keys) {
					if (!expressions.includes(key)) {
						expressions.push(key);
					}
				}
			}
		} catch { /* ignore */ }
		
		return expressions;
	}

	export function setViseme(viseme: string, weight: number = 1.0) {
		if (!vrm?.expressionManager) return;

		// Map viseme to VRM expression name
		const mappedViseme = VISEME_MAP[viseme] || viseme.toLowerCase();
		currentViseme = mappedViseme;
		
		// Set target weights: target viseme gets the weight, others get 0
		for (const [key, vrmName] of Object.entries(VISEME_MAP)) {
			const normalizedName = normalizeExpressionName(vrmName);
			if (normalizedName) {
				if (vrmName === mappedViseme && mappedViseme !== 'neutral') {
					visemeTargetWeights[normalizedName] = weight;
				} else {
					visemeTargetWeights[normalizedName] = 0;
				}
				// Initialize current weights if needed
				if (visemeCurrentWeights[normalizedName] === undefined) {
					visemeCurrentWeights[normalizedName] = 0;
				}
			}
		}
		
		// Fallback to 'aa' if no specific viseme matched
		if (mappedViseme && mappedViseme !== 'neutral') {
			const normalizedName = normalizeExpressionName(mappedViseme);
			if (!normalizedName) {
				const aaName = normalizeExpressionName('aa');
				if (aaName) {
					visemeTargetWeights[aaName] = weight;
					if (visemeCurrentWeights[aaName] === undefined) {
						visemeCurrentWeights[aaName] = 0;
					}
				}
			}
		}
		
		// Smoothly interpolate current weights towards targets
		for (const name of Object.keys(visemeTargetWeights)) {
			const target = visemeTargetWeights[name] ?? 0;
			const current = visemeCurrentWeights[name] ?? 0;
			visemeCurrentWeights[name] = current + (target - current) * VISEME_BLEND_SPEED;
			
			// Apply to lip sync layer
			expressionLipSyncLayer[name] = visemeCurrentWeights[name];
		}

		// Apply blended result
		if (useAdditiveBlending) {
			applyBlendedExpressions();
		}
	}

	/**
	 * Clear lip sync layer (called when TTS stops)
	 */
	export function clearLipSync() {
		expressionLipSyncLayer = {};
		visemeTargetWeights = {};
		visemeCurrentWeights = {};
		if (useAdditiveBlending) {
			applyBlendedExpressions();
		}
	}

	/**
	 * Set eye rotation for iris/pupil tracking
	 * pitch: up/down, yaw: left/right
	 */
	export function setEyeRotation(
		eye: 'left' | 'right',
		rotation: { pitch: number; yaw: number; roll: number }
	) {
		if (!vrm?.humanoid) return;
		
		const boneName = eye === 'left' ? 'leftEye' : 'rightEye';
		const eyeBone = vrm.humanoid.getNormalizedBoneNode(boneName);
		
		if (eyeBone) {
			// Apply rotation - VRM eye bones use local rotation
			// pitch = X rotation (look up/down)
			// yaw = Y rotation (look left/right)  
			// roll = Z rotation (usually not used for eyes)
			eyeBone.rotation.set(rotation.pitch, rotation.yaw, rotation.roll);
		}
	}

	export function setMouthOpen(value: number) {
		targetMouthOpen = Math.max(0, Math.min(1, value));
	}

	export function setBoneRotation(boneName: string, rotation: THREE.Euler) {
		if (!vrm?.humanoid) return;
		
		const bone = vrm.humanoid.getNormalizedBoneNode(boneName as any);
		if (bone) {
			bone.rotation.copy(rotation);
		}
	}

	export function getBonePosition(boneName: string): THREE.Vector3 | null {
		if (!vrm?.humanoid) return null;
		
		const bone = vrm.humanoid.getNormalizedBoneNode(boneName as any);
		if (bone) {
			const worldPos = new THREE.Vector3();
			bone.getWorldPosition(worldPos);
			return worldPos;
		}
		return null;
	}

	export function setCameraPosition(x: number, y: number, z: number) {
		if (camera) {
			camera.position.set(x, y, z);
		}
	}

	export function setCameraLookAt(x: number, y: number, z: number) {
		if (camera) {
			camera.lookAt(x, y, z);
		}
	}

	function animate() {
		if (!renderer || !scene || !camera || !clock) {
			animFrameId = requestAnimationFrame(animate);
			return;
		}

		const deltaTime = clock.getDelta();

		// Update VRM
		if (vrm) {
			vrm.update(deltaTime);
		}

		// Smooth mouth animation (legacy - now handled by lip sync layer)
		// Only apply if NOT using additive blending to avoid conflicts
		const smoothFactor = 1 - Math.pow(0.001, deltaTime);
		currentMouthOpen += (targetMouthOpen - currentMouthOpen) * smoothFactor;

		// When using additive blending, mouth is handled by expressionLipSyncLayer
		// Only directly apply if additive blending is disabled
		if (!useAdditiveBlending && vrm?.expressionManager && currentMouthOpen > 0.01) {
			try {
				vrm.expressionManager.setValue('aa', currentMouthOpen);
			} catch {
				// Ignore
			}
		}

		renderer.render(scene, camera);
		animFrameId = requestAnimationFrame(animate);
	}

	function handleResize() {
		if (!renderer || !camera) return;

		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		renderer.setSize(width, height);
	}

	$: if (renderer && (width || height)) {
		handleResize();
	}

	$: if (renderer && (backgroundColor !== undefined || backgroundAlpha !== undefined)) {
		renderer.setClearColor(backgroundColor, backgroundAlpha);
	}

	onMount(() => {
		initScene();
		animFrameId = requestAnimationFrame(animate);
	});

	onDestroy(() => {
		// Remove event listeners (must match capture option)
		if (canvasEl) {
			canvasEl.removeEventListener('wheel', handleWheel, { capture: true });
			canvasEl.removeEventListener('mousedown', handleMouseDown, { capture: true });
			canvasEl.removeEventListener('contextmenu', handleContextMenu, { capture: true });
		}
		window.removeEventListener('mousemove', handleMouseMove, { capture: true });
		window.removeEventListener('mouseup', handleMouseUp, { capture: true });

		if (animFrameId) {
			cancelAnimationFrame(animFrameId);
		}
		if (pmremGenerator) {
			pmremGenerator.dispose();
		}
		if (scene?.environment) {
			scene.environment.dispose();
		}
		if (renderer) {
			renderer.dispose();
		}
		if (vrm) {
			vrm.scene.traverse((obj) => {
				if ((obj as any).geometry) {
					(obj as any).geometry.dispose();
				}
				if ((obj as any).material) {
					const materials = Array.isArray((obj as any).material) 
						? (obj as any).material 
						: [(obj as any).material];
					for (const mat of materials) {
						mat.dispose();
					}
				}
			});
		}
	});
</script>

<canvas
	bind:this={canvasEl}
	class="vrm-canvas"
	style="width: {width}px; height: {height}px; filter: contrast({contrast}) saturate({saturation});"
/>

<style>
	.vrm-canvas {
		display: block;
		border-radius: inherit;
	}
</style>
