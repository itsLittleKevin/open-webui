/**
 * Face Tracking Engine using MediaPipe Face Landmarker
 * 
 * Tracks facial landmarks from webcam for:
 * - Head pose (rotation)
 * - Eye gaze direction
 * - Blink detection
 * - Facial expressions (smile, surprise, etc.)
 * 
 * Used for recording avatar movements that can be played back later.
 */

import { FaceLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';

export interface FaceTrackingState {
	/** Head rotation in radians (pitch, yaw, roll) */
	headRotation: { pitch: number; yaw: number; roll: number };
	
	/** Eye states (0-1, 0 = open, 1 = closed) */
	leftEyeBlink: number;
	rightEyeBlink: number;
	
	/** Eye gaze direction (normalized -1 to 1) */
	eyeGaze: { x: number; y: number };
	
	/** Mouth openness (0-1) */
	mouthOpen: number;
	
	/** Smile amount (0-1) */
	smile: number;
	
	/** Whether face is detected */
	faceDetected: boolean;
	
	/** Raw blend shapes from MediaPipe (if available) */
	blendShapes?: Record<string, number>;
}

export interface FaceTrackingOptions {
	/** Minimum confidence for face detection */
	minDetectionConfidence?: number;
	/** Minimum confidence for tracking */
	minTrackingConfidence?: number;
	/** Whether to output blend shapes */
	outputBlendShapes?: boolean;
	/** Whether to output face transformation matrix */
	outputFacialTransformationMatrix?: boolean;
}

type RunningMode = 'IMAGE' | 'VIDEO';

export class FaceTrackingEngine {
	private faceLandmarker: FaceLandmarker | null = null;
	private isInitialized = false;
	private isRunning = false;
	private videoElement: HTMLVideoElement | null = null;
	private animFrameId: number = 0;
	private lastVideoTime = -1;
	
	private onUpdate: ((state: FaceTrackingState) => void) | null = null;

	private options: FaceTrackingOptions;

	constructor(options: FaceTrackingOptions = {}) {
		this.options = {
			minDetectionConfidence: options.minDetectionConfidence ?? 0.5,
			minTrackingConfidence: options.minTrackingConfidence ?? 0.5,
			outputBlendShapes: options.outputBlendShapes ?? true,
			outputFacialTransformationMatrix: options.outputFacialTransformationMatrix ?? true
		};
	}

	/**
	 * Initialize MediaPipe Face Landmarker
	 */
	async initialize(): Promise<void> {
		if (this.isInitialized) return;

		try {
			const vision = await FilesetResolver.forVisionTasks(
				'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
			);

			this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
				baseOptions: {
					modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
					delegate: 'GPU'
				},
				runningMode: 'VIDEO' as RunningMode,
				numFaces: 1,
				minFaceDetectionConfidence: this.options.minDetectionConfidence,
				minFacePresenceConfidence: this.options.minTrackingConfidence,
				minTrackingConfidence: this.options.minTrackingConfidence,
				outputFaceBlendshapes: this.options.outputBlendShapes,
				outputFacialTransformationMatrixes: this.options.outputFacialTransformationMatrix
			});

			this.isInitialized = true;
		} catch (error) {
			console.error('Failed to initialize Face Landmarker:', error);
			throw error;
		}
	}

	/**
	 * Start tracking from a video element (webcam)
	 */
	async startTracking(
		videoElement: HTMLVideoElement,
		onUpdate: (state: FaceTrackingState) => void
	): Promise<void> {
		if (!this.isInitialized) {
			await this.initialize();
		}

		this.videoElement = videoElement;
		this.onUpdate = onUpdate;
		this.isRunning = true;
		this.lastVideoTime = -1;

		this.trackFrame();
	}

	/**
	 * Stop tracking
	 */
	stopTracking(): void {
		this.isRunning = false;
		if (this.animFrameId) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = 0;
		}
	}

	/**
	 * Process a single frame
	 */
	private trackFrame = (): void => {
		if (!this.isRunning || !this.faceLandmarker || !this.videoElement) {
			return;
		}

		// Only process new frames
		if (this.videoElement.currentTime !== this.lastVideoTime) {
			this.lastVideoTime = this.videoElement.currentTime;
			
			const results = this.faceLandmarker.detectForVideo(
				this.videoElement,
				performance.now()
			);

			const state = this.processResults(results);
			
			if (this.onUpdate) {
				this.onUpdate(state);
			}
		}

		this.animFrameId = requestAnimationFrame(this.trackFrame);
	};

	/**
	 * Process MediaPipe results into our state format
	 */
	private processResults(results: any): FaceTrackingState {
		const defaultState: FaceTrackingState = {
			headRotation: { pitch: 0, yaw: 0, roll: 0 },
			leftEyeBlink: 0,
			rightEyeBlink: 0,
			eyeGaze: { x: 0, y: 0 },
			mouthOpen: 0,
			smile: 0,
			faceDetected: false
		};

		if (!results.faceLandmarks || results.faceLandmarks.length === 0) {
			return defaultState;
		}

		const landmarks = results.faceLandmarks[0];
		const blendShapes = results.faceBlendshapes?.[0]?.categories;
		const transformMatrix = results.facialTransformationMatrixes?.[0]?.data;

		// Extract head rotation from transformation matrix if available
		let headRotation = { pitch: 0, yaw: 0, roll: 0 };
		if (transformMatrix) {
			headRotation = this.extractRotationFromMatrix(transformMatrix);
		} else if (landmarks) {
			headRotation = this.estimateHeadPoseFromLandmarks(landmarks);
		}

		// Extract blend shape values
		const blendShapeMap: Record<string, number> = {};
		if (blendShapes) {
			for (const shape of blendShapes) {
				blendShapeMap[shape.categoryName] = shape.score;
			}
		}

		// Eye blinks
		const leftEyeBlink = blendShapeMap['eyeBlinkLeft'] ?? 
			blendShapeMap['eyeBlink_L'] ?? 
			this.estimateBlinkFromLandmarks(landmarks, 'left');
		
		const rightEyeBlink = blendShapeMap['eyeBlinkRight'] ?? 
			blendShapeMap['eyeBlink_R'] ?? 
			this.estimateBlinkFromLandmarks(landmarks, 'right');

		// Eye gaze
		const eyeLookInLeft = blendShapeMap['eyeLookInLeft'] ?? 0;
		const eyeLookOutLeft = blendShapeMap['eyeLookOutLeft'] ?? 0;
		const eyeLookUpLeft = blendShapeMap['eyeLookUpLeft'] ?? 0;
		const eyeLookDownLeft = blendShapeMap['eyeLookDownLeft'] ?? 0;
		
		const gazeX = eyeLookInLeft - eyeLookOutLeft;
		const gazeY = eyeLookUpLeft - eyeLookDownLeft;

		// Mouth
		const jawOpen = blendShapeMap['jawOpen'] ?? 0;
		const mouthOpen = blendShapeMap['mouthOpen'] ?? jawOpen;

		// Smile
		const mouthSmileLeft = blendShapeMap['mouthSmileLeft'] ?? 0;
		const mouthSmileRight = blendShapeMap['mouthSmileRight'] ?? 0;
		const smile = (mouthSmileLeft + mouthSmileRight) / 2;

		return {
			headRotation,
			leftEyeBlink,
			rightEyeBlink,
			eyeGaze: { x: gazeX, y: gazeY },
			mouthOpen,
			smile,
			faceDetected: true,
			blendShapes: blendShapeMap
		};
	}

	/**
	 * Extract Euler rotation from a 4x4 transformation matrix
	 */
	private extractRotationFromMatrix(matrix: number[]): { pitch: number; yaw: number; roll: number } {
		// Matrix is column-major, 4x4
		// Extract rotation part (top-left 3x3)
		const r00 = matrix[0], r01 = matrix[1], r02 = matrix[2];
		const r10 = matrix[4], r11 = matrix[5], r12 = matrix[6];
		const r20 = matrix[8], r21 = matrix[9], r22 = matrix[10];

		// Convert to Euler angles (XYZ order)
		let pitch: number, yaw: number, roll: number;

		if (Math.abs(r20) < 0.9999) {
			yaw = Math.asin(-r20);
			pitch = Math.atan2(r21, r22);
			roll = Math.atan2(r10, r00);
		} else {
			// Gimbal lock
			yaw = r20 > 0 ? -Math.PI / 2 : Math.PI / 2;
			pitch = Math.atan2(-r12, r11);
			roll = 0;
		}

		return { pitch, yaw, roll };
	}

	/**
	 * Estimate head pose from facial landmarks
	 */
	private estimateHeadPoseFromLandmarks(landmarks: any[]): { pitch: number; yaw: number; roll: number } {
		// Use key landmarks to estimate head pose
		// Nose tip (index 1), left eye (index 33), right eye (index 263)
		// Chin (index 152), forehead (index 10)
		
		if (landmarks.length < 264) {
			return { pitch: 0, yaw: 0, roll: 0 };
		}

		const noseTip = landmarks[1];
		const leftEye = landmarks[33];
		const rightEye = landmarks[263];
		const chin = landmarks[152];
		const forehead = landmarks[10];

		// Yaw: horizontal nose offset from eye center
		const eyeCenterX = (leftEye.x + rightEye.x) / 2;
		const yaw = (noseTip.x - eyeCenterX) * Math.PI;

		// Pitch: vertical nose to eye/chin ratio
		const eyeCenterY = (leftEye.y + rightEye.y) / 2;
		const faceHeight = chin.y - forehead.y;
		const noseRatio = (noseTip.y - eyeCenterY) / (faceHeight || 1);
		const pitch = (noseRatio - 0.3) * Math.PI * 0.5;

		// Roll: eye tilt
		const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

		return { pitch, yaw, roll };
	}

	/**
	 * Estimate blink from landmark positions
	 */
	private estimateBlinkFromLandmarks(landmarks: any[], eye: 'left' | 'right'): number {
		// Eye landmark indices
		// Left eye: upper 159, 145 / lower 153, 154
		// Right eye: upper 386, 374 / lower 380, 381
		
		const indices = eye === 'left'
			? { upper: [159, 145], lower: [153, 154] }
			: { upper: [386, 374], lower: [380, 381] };

		if (landmarks.length < 387) return 0;

		const upperCenter = {
			y: (landmarks[indices.upper[0]].y + landmarks[indices.upper[1]].y) / 2
		};
		const lowerCenter = {
			y: (landmarks[indices.lower[0]].y + landmarks[indices.lower[1]].y) / 2
		};

		const eyeHeight = lowerCenter.y - upperCenter.y;
		
		// Map eye height to blink value (smaller height = more closed)
		// Typical open eye height is ~0.03, closed is ~0.005
		const openThreshold = 0.025;
		const closedThreshold = 0.008;
		
		if (eyeHeight > openThreshold) return 0;
		if (eyeHeight < closedThreshold) return 1;
		
		return 1 - (eyeHeight - closedThreshold) / (openThreshold - closedThreshold);
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		this.stopTracking();
		
		if (this.faceLandmarker) {
			this.faceLandmarker.close();
			this.faceLandmarker = null;
		}
		
		this.isInitialized = false;
	}

	/**
	 * Check if initialized
	 */
	get initialized(): boolean {
		return this.isInitialized;
	}

	/**
	 * Check if running
	 */
	get running(): boolean {
		return this.isRunning;
	}
}

/**
 * Movement Recording for creating animation presets
 */
export interface RecordedFrame {
	timestamp: number;
	headRotation: { pitch: number; yaw: number; roll: number };
	leftEyeBlink: number;
	rightEyeBlink: number;
	eyeGaze: { x: number; y: number };
	mouthOpen: number;
	smile: number;
	blendShapes?: Record<string, number>;
}

export interface RecordedAnimation {
	name: string;
	frames: RecordedFrame[];
	duration: number;
	fps: number;
}

export class MovementRecorder {
	private frames: RecordedFrame[] = [];
	private startTime: number = 0;
	private isRecording = false;
	private recordFps = 30;
	private lastFrameTime = 0;
	private frameInterval: number;

	constructor(fps: number = 30) {
		this.recordFps = fps;
		this.frameInterval = 1000 / fps;
	}

	/**
	 * Start recording
	 */
	startRecording(): void {
		this.frames = [];
		this.startTime = performance.now();
		this.lastFrameTime = 0;
		this.isRecording = true;
	}

	/**
	 * Add a frame from face tracking state
	 */
	addFrame(state: FaceTrackingState): boolean {
		if (!this.isRecording) return false;

		const now = performance.now();
		const elapsed = now - this.startTime;

		// Rate limit to target FPS
		if (elapsed - this.lastFrameTime < this.frameInterval) {
			return false;
		}

		this.lastFrameTime = elapsed;

		this.frames.push({
			timestamp: elapsed,
			headRotation: { ...state.headRotation },
			leftEyeBlink: state.leftEyeBlink,
			rightEyeBlink: state.rightEyeBlink,
			eyeGaze: { ...state.eyeGaze },
			mouthOpen: state.mouthOpen,
			smile: state.smile,
			blendShapes: state.blendShapes ? { ...state.blendShapes } : undefined
		});

		return true;
	}

	/**
	 * Stop recording and return the animation
	 */
	stopRecording(name: string): RecordedAnimation {
		this.isRecording = false;
		
		const duration = this.frames.length > 0 
			? this.frames[this.frames.length - 1].timestamp 
			: 0;

		return {
			name,
			frames: this.frames,
			duration,
			fps: this.recordFps
		};
	}

	/**
	 * Check if currently recording
	 */
	get recording(): boolean {
		return this.isRecording;
	}

	/**
	 * Get current frame count
	 */
	get frameCount(): number {
		return this.frames.length;
	}

	/**
	 * Get recording duration in ms
	 */
	get duration(): number {
		return this.frames.length > 0 
			? this.frames[this.frames.length - 1].timestamp 
			: 0;
	}
}

// Global instance
let globalFaceTracking: FaceTrackingEngine | null = null;

export function getFaceTrackingEngine(): FaceTrackingEngine {
	if (!globalFaceTracking) {
		globalFaceTracking = new FaceTrackingEngine();
	}
	return globalFaceTracking;
}

export function disposeFaceTrackingEngine(): void {
	if (globalFaceTracking) {
		globalFaceTracking.dispose();
		globalFaceTracking = null;
	}
}
