/**
 * Lip Sync Engine with Phoneme-based Viseme Detection
 * 
 * Analyzes audio in real-time and maps to VRM visemes (A, I, U, E, O)
 * Uses frequency analysis to approximate vowel sounds.
 */

export type Viseme = 'A' | 'I' | 'U' | 'E' | 'O' | 'neutral';

export interface LipSyncState {
	viseme: Viseme;
	mouthOpen: number;  // 0-1, overall mouth openness
	volume: number;     // 0-1, current audio volume
}

export interface LipSyncOptions {
	/** Smoothing factor for viseme transitions (0-1, higher = smoother) */
	smoothing?: number;
	/** Minimum volume threshold to trigger lip movement */
	volumeThreshold?: number;
	/** Sensitivity multiplier for volume detection */
	sensitivity?: number;
}

/**
 * Vowel formant frequency ranges (Hz)
 * These are approximations for detecting vowel sounds
 */
const FORMANT_RANGES = {
	// F1 (first formant) - relates to mouth openness
	// F2 (second formant) - relates to tongue position
	A: { f1Min: 700, f1Max: 1000, f2Min: 1100, f2Max: 1500 },  // Open, back vowel
	E: { f1Min: 400, f1Max: 600, f2Min: 2000, f2Max: 2600 },   // Mid-front vowel  
	I: { f1Min: 250, f1Max: 400, f2Min: 2200, f2Max: 3000 },   // Close, front vowel
	O: { f1Min: 400, f1Max: 600, f2Min: 700, f2Max: 1100 },    // Mid-back, rounded
	U: { f1Min: 250, f1Max: 400, f2Min: 600, f2Max: 1000 },    // Close, back, rounded
};

export class LipSyncEngine {
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private frequencyData: Uint8Array<ArrayBuffer> | null = null;
	private timeData: Uint8Array<ArrayBuffer> | null = null;
	private sourceNode: MediaElementAudioSourceNode | AudioBufferSourceNode | null = null;
	
	private currentViseme: Viseme = 'neutral';
	private currentMouthOpen = 0;
	private currentVolume = 0;
	
	private smoothing: number;
	private volumeThreshold: number;
	private sensitivity: number;
	
	private animFrameId: number = 0;
	private onUpdate: ((state: LipSyncState) => void) | null = null;
	private isRunning = false;

	constructor(options: LipSyncOptions = {}) {
		this.smoothing = options.smoothing ?? 0.7;
		this.volumeThreshold = options.volumeThreshold ?? 0.05;
		this.sensitivity = options.sensitivity ?? 1.5;
	}

	/**
	 * Initialize audio context and analyser
	 */
	private async initAudioContext(): Promise<void> {
		if (!this.audioContext) {
			this.audioContext = new AudioContext();
		}
		
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}

		if (!this.analyser) {
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 2048;
			this.analyser.smoothingTimeConstant = 0.8;
			
			const bufferLength = this.analyser.frequencyBinCount;
			this.frequencyData = new Uint8Array(bufferLength);
			this.timeData = new Uint8Array(bufferLength);
		}
	}

	/**
	 * Connect to an HTMLAudioElement for lip sync
	 */
	async connectAudioElement(audioElement: HTMLAudioElement): Promise<void> {
		await this.initAudioContext();
		
		if (!this.audioContext || !this.analyser) {
			throw new Error('Audio context not initialized');
		}

		// Disconnect existing source
		this.disconnectSource();

		// Create source from audio element
		this.sourceNode = this.audioContext.createMediaElementSource(audioElement);
		this.sourceNode.connect(this.analyser);
		this.analyser.connect(this.audioContext.destination);
	}

	/**
	 * Connect to an AudioBuffer for lip sync (for audio that's already loaded)
	 */
	async connectAudioBuffer(audioBuffer: AudioBuffer): Promise<AudioBufferSourceNode> {
		await this.initAudioContext();
		
		if (!this.audioContext || !this.analyser) {
			throw new Error('Audio context not initialized');
		}

		// Disconnect existing source
		this.disconnectSource();

		// Create a new buffer source
		const source = this.audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(this.analyser);
		this.analyser.connect(this.audioContext.destination);
		
		this.sourceNode = source;
		return source;
	}

	/**
	 * Decode audio data and return an AudioBuffer
	 */
	async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
		await this.initAudioContext();
		
		if (!this.audioContext) {
			throw new Error('Audio context not initialized');
		}

		return this.audioContext.decodeAudioData(arrayBuffer);
	}

	/**
	 * Connect to a MediaStream (e.g., from getUserMedia)
	 */
	async connectMediaStream(stream: MediaStream): Promise<void> {
		await this.initAudioContext();
		
		if (!this.audioContext || !this.analyser) {
			throw new Error('Audio context not initialized');
		}

		// Disconnect existing source
		this.disconnectSource();

		const source = this.audioContext.createMediaStreamSource(stream);
		source.connect(this.analyser);
		// Don't connect to destination for mic input to avoid feedback
		
		this.sourceNode = source as any;
	}

	private disconnectSource(): void {
		if (this.sourceNode) {
			try {
				this.sourceNode.disconnect();
			} catch {
				// Ignore disconnect errors
			}
			this.sourceNode = null;
		}
	}

	/**
	 * Start the lip sync analysis loop
	 */
	start(onUpdate: (state: LipSyncState) => void): void {
		this.onUpdate = onUpdate;
		this.isRunning = true;
		this.analyze();
	}

	/**
	 * Stop the lip sync analysis
	 */
	stop(): void {
		this.isRunning = false;
		if (this.animFrameId) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = 0;
		}
		
		// Reset to neutral
		this.currentViseme = 'neutral';
		this.currentMouthOpen = 0;
		this.currentVolume = 0;
		
		if (this.onUpdate) {
			this.onUpdate({
				viseme: 'neutral',
				mouthOpen: 0,
				volume: 0
			});
		}
	}

	/**
	 * Main analysis loop
	 */
	private analyze = (): void => {
		if (!this.isRunning) return;

		if (this.analyser && this.frequencyData && this.timeData) {
			this.analyser.getByteFrequencyData(this.frequencyData);
			this.analyser.getByteTimeDomainData(this.timeData);

			// Calculate volume from time domain data
			const volume = this.calculateVolume();
			
			// Smooth volume transition
			this.currentVolume = this.currentVolume + (volume - this.currentVolume) * (1 - this.smoothing);

			if (this.currentVolume > this.volumeThreshold) {
				// Detect viseme from frequency data
				const detectedViseme = this.detectViseme();
				
				// Smooth viseme transition (only change if confident)
				if (detectedViseme !== this.currentViseme) {
					this.currentViseme = detectedViseme;
				}

				// Mouth openness based on volume
				const targetMouthOpen = Math.min(1, this.currentVolume * this.sensitivity);
				this.currentMouthOpen = this.currentMouthOpen + (targetMouthOpen - this.currentMouthOpen) * (1 - this.smoothing);
			} else {
				// Silence - close mouth
				this.currentViseme = 'neutral';
				this.currentMouthOpen = this.currentMouthOpen * this.smoothing;
			}

			if (this.onUpdate) {
				this.onUpdate({
					viseme: this.currentViseme,
					mouthOpen: this.currentMouthOpen,
					volume: this.currentVolume
				});
			}
		}

		this.animFrameId = requestAnimationFrame(this.analyze);
	};

	/**
	 * Calculate volume from time domain data
	 */
	private calculateVolume(): number {
		if (!this.timeData) return 0;

		let sumSquares = 0;
		for (let i = 0; i < this.timeData.length; i++) {
			const normalized = (this.timeData[i] - 128) / 128;
			sumSquares += normalized * normalized;
		}
		
		const rms = Math.sqrt(sumSquares / this.timeData.length);
		return Math.min(1, rms * 2);
	}

	/**
	 * Detect viseme from frequency analysis
	 * Uses formant approximation to guess vowel sounds
	 */
	private detectViseme(): Viseme {
		if (!this.frequencyData || !this.audioContext) return 'A';

		const sampleRate = this.audioContext.sampleRate;
		const binCount = this.frequencyData.length;
		const binWidth = sampleRate / (binCount * 2);

		// Find peaks in the frequency spectrum
		const peaks = this.findFormantPeaks(binWidth);
		
		if (peaks.length < 1) return 'A';

		// Use peak frequencies to estimate vowel
		const f1 = peaks[0]?.frequency || 500;
		const f2 = peaks[1]?.frequency || f1 * 2;

		// Score each vowel based on formant proximity
		let bestViseme: Viseme = 'A';
		let bestScore = Infinity;

		for (const [vowel, range] of Object.entries(FORMANT_RANGES)) {
			const f1Center = (range.f1Min + range.f1Max) / 2;
			const f2Center = (range.f2Min + range.f2Max) / 2;
			
			const f1Dist = Math.abs(f1 - f1Center) / (range.f1Max - range.f1Min);
			const f2Dist = Math.abs(f2 - f2Center) / (range.f2Max - range.f2Min);
			
			const score = f1Dist + f2Dist * 0.5; // Weight F1 more heavily

			if (score < bestScore) {
				bestScore = score;
				bestViseme = vowel as Viseme;
			}
		}

		return bestViseme;
	}

	/**
	 * Find peaks in frequency spectrum (approximating formants)
	 */
	private findFormantPeaks(binWidth: number): Array<{ frequency: number; amplitude: number }> {
		if (!this.frequencyData) return [];

		const peaks: Array<{ frequency: number; amplitude: number }> = [];
		const minFreq = 200;  // Ignore very low frequencies
		const maxFreq = 4000; // Voice formants are typically below 4kHz
		
		const minBin = Math.floor(minFreq / binWidth);
		const maxBin = Math.min(Math.ceil(maxFreq / binWidth), this.frequencyData.length - 1);

		// Find local maxima
		for (let i = minBin + 1; i < maxBin - 1; i++) {
			const prev = this.frequencyData[i - 1];
			const curr = this.frequencyData[i];
			const next = this.frequencyData[i + 1];

			if (curr > prev && curr > next && curr > 100) {
				peaks.push({
					frequency: i * binWidth,
					amplitude: curr
				});
			}
		}

		// Sort by amplitude and take top 2-3
		peaks.sort((a, b) => b.amplitude - a.amplitude);
		return peaks.slice(0, 3);
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		this.stop();
		this.disconnectSource();
		
		if (this.analyser) {
			this.analyser.disconnect();
			this.analyser = null;
		}

		if (this.audioContext) {
			this.audioContext.close();
			this.audioContext = null;
		}

		this.frequencyData = null;
		this.timeData = null;
	}

	/**
	 * Get current state
	 */
	getState(): LipSyncState {
		return {
			viseme: this.currentViseme,
			mouthOpen: this.currentMouthOpen,
			volume: this.currentVolume
		};
	}
}

/**
 * Create a global lip sync engine instance
 */
let globalLipSyncEngine: LipSyncEngine | null = null;

export function getLipSyncEngine(): LipSyncEngine {
	if (!globalLipSyncEngine) {
		globalLipSyncEngine = new LipSyncEngine();
	}
	return globalLipSyncEngine;
}

export function disposeLipSyncEngine(): void {
	if (globalLipSyncEngine) {
		globalLipSyncEngine.dispose();
		globalLipSyncEngine = null;
	}
}
