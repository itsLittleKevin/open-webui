/**
 * LLM-based Intent Classifier for VRM Avatar Animations.
 *
 * Analyzes text segments to detect:
 * - Gesture intent: nod (agreement), shake_head (disagreement), thinking
 * - Expression intent: smile (happy), sad, angry, surprised
 *
 * Each segment triggers at most 1 gesture + 1 expression.
 * 
 * Hybrid approach:
 * - Fast path: Keyword matching for immediate reactions during streaming
 * - Slow path: LLM classification for nuanced detection at segment end
 */

import { generateOpenAIChatCompletion } from '$lib/apis/openai';

/** Default model for intent classification - fast, small, excellent EN/ZH support */
export const DEFAULT_INTENT_MODEL = 'qwen2.5:1.5b';

export type GestureType = 'nod' | 'shake_head' | 'thinking' | null;
export type ExpressionType = 'smile' | 'sad' | 'angry' | 'surprised' | null;

export type IntentClassification = {
	gesture: GestureType;
	expression: ExpressionType;
};

/**
 * Fast keyword patterns for immediate expression triggers.
 * These fire during streaming without waiting for LLM.
 */
const FAST_EXPRESSION_PATTERNS: Array<{ pattern: RegExp; expression: ExpressionType }> = [
	// Smile - laughter, emoticons, happy words
	{ pattern: /哈哈|呵呵|嘻嘻|😊|😄|😁|🤗|开心|太好了|haha|hehe|lol|:D|:\)/i, expression: 'smile' },
	// Surprised - exclamations, shock words
	{ pattern: /哇|啊！|天哪|😮|😲|🤯|没想到|居然|竟然|wow|omg|whoa/i, expression: 'surprised' },
	// Sad - crying, sadness (escape parens in emoticons)
	{ pattern: /呜呜|唉|😢|😭|伤心|难过|可惜|遗憾|aww|:\(|T_T/i, expression: 'sad' },
	// Angry - frustration, anger
	{ pattern: /😠|😡|🤬|气死|讨厌|烦死|可恶|damn|ugh/i, expression: 'angry' },
];

const FAST_GESTURE_PATTERNS: Array<{ pattern: RegExp; gesture: GestureType }> = [
	// Nod - agreement
	{ pattern: /没错|对[的呀啊]|是[的呀啊]|当然|确实|同意|yes|yeah|right|exactly|indeed/i, gesture: 'nod' },
	// Shake head - disagreement
	{ pattern: /不对|不是|不行|不能|别[这那]样|no|nope|wrong/i, gesture: 'shake_head' },
	// Thinking - pondering
	{ pattern: /让我想想|嗯+|hmm+|思考|考虑|也许|可能|或许|maybe|perhaps|let me think/i, gesture: 'thinking' },
];

/**
 * Fast keyword-based classification (instant, no LLM).
 * Returns partial classification - only fills in what keywords matched.
 */
export function classifyByKeywords(text: string): IntentClassification {
	let expression: ExpressionType = null;
	let gesture: GestureType = null;

	// Check expression patterns
	for (const { pattern, expression: expr } of FAST_EXPRESSION_PATTERNS) {
		if (pattern.test(text)) {
			expression = expr;
			break; // First match wins
		}
	}

	// Check gesture patterns
	for (const { pattern, gesture: gest } of FAST_GESTURE_PATTERNS) {
		if (pattern.test(text)) {
			gesture = gest;
			break;
		}
	}

	return { gesture, expression };
}

/**
 * Classification prompt template for the LLM.
 * Simplified for small models like qwen2.5:1.5b.
 */
const CLASSIFICATION_PROMPT = `Analyze emotional intent. Output JSON only.

gesture: "nod" (同意/认同/支持), "shake_head" (反对/拒绝/否定), "thinking" (思考/犹豫), or null
expression: "smile" (开心/高兴/快乐), "sad" (难过/悲伤), "angry" (生气/愤怒), "surprised" (惊讶/意外), or null

Rules: Only pick if CLEARLY present. Be conservative - prefer null over wrong choice.

{"gesture": null, "expression": null}

Text:
`;

/**
 * Parse the LLM response to extract classification.
 * Handles various response formats gracefully.
 */
function parseClassificationResponse(response: string): IntentClassification {
	const defaultResult: IntentClassification = { gesture: null, expression: null };

	try {
		// Try to extract JSON from response
		const jsonMatch = response.match(/\{[^}]+\}/);
		if (!jsonMatch) {
			console.warn('[IntentClassifier] No JSON found in response:', response.slice(0, 100));
			return defaultResult;
		}

		const parsed = JSON.parse(jsonMatch[0]);
		console.debug('[IntentClassifier] Parsed classification:', parsed);

		// Validate gesture
		const gesture = parsed.gesture;
		const validGestures = ['nod', 'shake_head', 'thinking'];
		const resultGesture: GestureType = validGestures.includes(gesture) ? gesture : null;

		// Validate expression
		const expression = parsed.expression;
		const validExpressions = ['smile', 'sad', 'angry', 'surprised'];
		const resultExpression: ExpressionType = validExpressions.includes(expression)
			? expression
			: null;

		return { gesture: resultGesture, expression: resultExpression };
	} catch {
		console.warn('[IntentClassifier] Failed to parse response:', response);
		return defaultResult;
	}
}

/**
 * Classify the intent of a text segment using LLM.
 *
 * @param text - Text segment to classify
 * @param token - Auth token for API
 * @param modelId - Model to use for classification (defaults to qwen2.5:1.5b)
 * @returns Classification result with gesture and expression
 */
export async function classifyIntent(
	text: string,
	token: string,
	modelId: string = DEFAULT_INTENT_MODEL
): Promise<IntentClassification> {
	const defaultResult: IntentClassification = { gesture: null, expression: null };

	if (!text || text.trim().length < 5) {
		return defaultResult;
	}

	console.debug('[IntentClassifier] Classifying with model:', modelId);
	console.debug('[IntentClassifier] Text (first 100 chars):', text.trim().slice(0, 100));

	try {
		const response = await generateOpenAIChatCompletion(token, {
			model: modelId,
			messages: [
				{
					role: 'user',
					content: CLASSIFICATION_PROMPT + text.trim()
				}
			],
			stream: false,
			max_tokens: 50,
			temperature: 0.1 // Low temperature for consistent classification
		});

		if (!response?.choices?.[0]?.message?.content) {
			console.warn('[IntentClassifier] Empty response from LLM');
			return defaultResult;
		}

		const rawResponse = response.choices[0].message.content;
		console.debug('[IntentClassifier] Raw LLM response:', rawResponse);

		return parseClassificationResponse(rawResponse);
	} catch (error) {
		console.error('[IntentClassifier] Classification failed:', error);
		return defaultResult;
	}
}

/**
 * Split text into meaningful segments (paragraphs or sentence groups).
 * We use paragraph breaks and large punctuation patterns as boundaries.
 */
export function splitIntoSegments(text: string): string[] {
	// Split on paragraph breaks (double newlines) or major punctuation
	const segments = text
		.split(/\n\n+|(?<=[。！？.!?])\s*(?=[^\s])/g)
		.map((s) => s.trim())
		.filter((s) => s.length > 10); // Ignore very short segments

	// If no splits, return the whole text as one segment
	if (segments.length === 0 && text.trim().length > 10) {
		return [text.trim()];
	}

	return segments;
}

/**
 * Segment-based animation controller.
 * Handles classification and rate-limiting per segment.
 */
export class SegmentAnimationController {
	private isProcessing = false;
	private processedSegmentHashes = new Set<string>();
	private lastGestureTime = 0;
	private lastExpressionTime = 0;
	private gestureCooldownMs: number;
	private expressionCooldownMs: number;

	constructor(gestureCooldownMs = 5000, expressionCooldownMs = 4000) {
		this.gestureCooldownMs = gestureCooldownMs;
		this.expressionCooldownMs = expressionCooldownMs;
	}

	/**
	 * Hash a segment for deduplication.
	 */
	private hashSegment(segment: string): string {
		// Simple hash: first 50 chars
		return segment.slice(0, 50);
	}

	/**
	 * Check if we can trigger a gesture based on cooldown.
	 */
	canTriggerGesture(): boolean {
		return Date.now() - this.lastGestureTime >= this.gestureCooldownMs;
	}

	/**
	 * Check if we can trigger an expression based on cooldown.
	 */
	canTriggerExpression(): boolean {
		return Date.now() - this.lastExpressionTime >= this.expressionCooldownMs;
	}

	/**
	 * Mark a gesture as triggered.
	 */
	markGestureTriggered(): void {
		this.lastGestureTime = Date.now();
	}

	/**
	 * Mark an expression as triggered.
	 */
	markExpressionTriggered(): void {
		this.lastExpressionTime = Date.now();
	}

	/**
	 * Process a text segment and return animations to trigger.
	 *
	 * @param segment - Text segment to analyze
	 * @param token - Auth token
	 * @param modelId - Classification model
	 * @returns Animations to trigger (respecting cooldowns)
	 */
	async processSegment(
		segment: string,
		token: string,
		modelId: string
	): Promise<{ gesture: GestureType; expression: ExpressionType }> {
		const result: { gesture: GestureType; expression: ExpressionType } = {
			gesture: null,
			expression: null
		};

		// Skip if segment already processed
		const hash = this.hashSegment(segment);
		if (this.processedSegmentHashes.has(hash)) {
			return result;
		}
		this.processedSegmentHashes.add(hash);

		// Avoid concurrent processing
		if (this.isProcessing) {
			return result;
		}

		this.isProcessing = true;

		try {
			const classification = await classifyIntent(segment, token, modelId);

			// Only return gesture if cooldown allows
			if (classification.gesture && this.canTriggerGesture()) {
				result.gesture = classification.gesture;
			}

			// Only return expression if cooldown allows
			if (classification.expression && this.canTriggerExpression()) {
				result.expression = classification.expression;
			}
		} catch (error) {
			console.error('[SegmentAnimationController] Error processing segment:', error);
		} finally {
			this.isProcessing = false;
		}

		return result;
	}

	/**
	 * Reset state for a new response.
	 */
	reset(): void {
		this.processedSegmentHashes.clear();
		this.isProcessing = false;
		// Don't reset cooldown timers - they should persist across responses
	}

	/**
	 * Full reset including cooldowns.
	 */
	fullReset(): void {
		this.reset();
		this.lastGestureTime = 0;
		this.lastExpressionTime = 0;
	}
}

/**
 * Create a streaming segment classifier that accumulates text and triggers
 * classification when a segment boundary is detected.
 */
export function createStreamingSegmentClassifier(
	token: string,
	modelId: string = DEFAULT_INTENT_MODEL,
	onGesture: (gesture: Exclude<GestureType, null>) => void,
	onExpression: (expression: Exclude<ExpressionType, null>) => void,
	options: {
		gestureCooldownMs?: number;
		expressionCooldownMs?: number;
	} = {}
): {
	feed: (chunk: string) => void;
	flush: () => Promise<void>;
	reset: () => void;
} {
	const controller = new SegmentAnimationController(
		options.gestureCooldownMs ?? 5000,
		options.expressionCooldownMs ?? 4000
	);

	let buffer = '';
	let pendingClassification: Promise<void> | null = null;
	let lastKeywordCheckPos = 0; // Track where we last checked for keywords

	// Segment boundary pattern: paragraph breaks or end of sentence with next sentence starting
	const segmentBoundaryPattern = /\n\n+|(?<=[。！？.!?])\s+(?=[A-Z\u4e00-\u9fff])/;

	/**
	 * Fast check: Look for keywords in recently added text for immediate triggers.
	 */
	function checkFastKeywords(): void {
		// Only check new text since last check
		const newText = buffer.slice(lastKeywordCheckPos);
		if (newText.length < 2) return;

		lastKeywordCheckPos = buffer.length;

		const fastResult = classifyByKeywords(newText);

		if (fastResult.expression && controller.canTriggerExpression()) {
			console.debug('[IntentClassifier] Fast keyword trigger:', fastResult.expression, 'from:', newText.slice(0, 30));
			controller.markExpressionTriggered();
			onExpression(fastResult.expression);
		}

		if (fastResult.gesture && controller.canTriggerGesture()) {
			console.debug('[IntentClassifier] Fast keyword trigger:', fastResult.gesture, 'from:', newText.slice(0, 30));
			controller.markGestureTriggered();
			onGesture(fastResult.gesture);
		}
	}

	async function processBuffer(): Promise<void> {
		const segments = buffer.split(segmentBoundaryPattern);

		// Keep the last segment in buffer (might be incomplete)
		if (segments.length > 1) {
			buffer = segments.pop() ?? '';
			lastKeywordCheckPos = 0; // Reset keyword check position for new buffer

			for (const segment of segments) {
				if (segment.trim().length < 15) continue;

				const result = await controller.processSegment(segment.trim(), token, modelId);

				if (result.gesture) {
					controller.markGestureTriggered();
					onGesture(result.gesture);
				}

				if (result.expression) {
					controller.markExpressionTriggered();
					onExpression(result.expression);
				}
			}
		}
	}

	return {
		feed(chunk: string): void {
			buffer += chunk;

			// FAST PATH: Check for keywords immediately for instant reactions
			checkFastKeywords();

			// SLOW PATH: Check if we have a segment boundary for LLM classification
			if (segmentBoundaryPattern.test(buffer)) {
				// Start classification in background
				if (!pendingClassification) {
					pendingClassification = processBuffer().finally(() => {
						pendingClassification = null;
					});
				}
			}
		},

		async flush(): Promise<void> {
			// Wait for any pending classification
			if (pendingClassification) {
				await pendingClassification;
			}

			// Process remaining buffer with LLM (for nuanced classification)
			if (buffer.trim().length >= 15) {
				const result = await controller.processSegment(buffer.trim(), token, modelId);

				if (result.gesture) {
					controller.markGestureTriggered();
					onGesture(result.gesture);
				}

				if (result.expression) {
					controller.markExpressionTriggered();
					onExpression(result.expression);
				}
			}

			buffer = '';
			lastKeywordCheckPos = 0;
		},

		reset(): void {
			buffer = '';
			lastKeywordCheckPos = 0;
			pendingClassification = null;
			controller.reset();
		}
	};
}
