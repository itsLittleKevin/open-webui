/**
 * Animation Interceptor for VRM avatar reactions.
 *
 * This module intercepts streaming LLM text for emotional/reactive keywords
 * and triggers corresponding VRM animations during TTS playback.
 *
 * Supported presets (from vmc_presets.py):
 * - smile: Joy expression
 * - sad: Sorrow expression
 * - angry: Angry expression
 * - surprised: Surprised expression
 * - nod: Head nod (agreement)
 * - shake_head: Head shake (disagreement)
 * - thinking: Thinking pose with head tilt
 */

export type AnimationTrigger = {
	/** Name of the VMC preset to play */
	preset: string;
	/** Priority (higher = more important, will override lower priority animations) */
	priority: number;
	/** Keywords that trigger this animation (lowercase) */
	keywords: string[];
};

/**
 * Default keyword-to-animation mappings.
 * Includes both Chinese and English emotional keywords.
 * 
 * NOTE: Keywords are intentionally selective to avoid over-triggering.
 * Common conversational words are excluded (e.g., '好', '是', '不是', '可以')
 */
export const DEFAULT_ANIMATION_TRIGGERS: AnimationTrigger[] = [
	{
		preset: 'smile',
		priority: 5,
		keywords: [
			// Chinese - explicit happiness expressions (avoid common words)
			'高兴', '开心', '真不错', '太棒了', '哈哈', '好开心',
			'太好了', '真棒', '厉害', '了不起', '感谢', '谢谢你',
			'真高兴', '可爱', '好喜欢', '幸福', '快乐', '妙趣横生',
			'有意思', '有趣的', '欣慰', '满意',
			// English - happiness (distinct emotional words)
			'happy', 'wonderful', 'amazing', 'excellent', 'fantastic', 
			'awesome', 'haha', 'hehe', 'lol', 'excited', 'delighted',
			'joyful', 'cheerful', 'thank you', 'grateful', 'adorable',
		],
	},
	{
		preset: 'sad',
		priority: 5,
		keywords: [
			// Chinese - sadness (distinct emotional words)
			'难过', '伤心', '悲伤', '遗憾', '可惜', '不幸', '抱歉',
			'心痛', '失望', '沮丧', '呜呜',
			// English - sadness
			'sad', 'unfortunately', 'regret', 'disappointed',
			'heartbroken', 'alas', 'tragic', 'grief', 'depressed',
		],
	},
	{
		preset: 'angry',
		priority: 6,
		keywords: [
			// Chinese - anger (distinct expressions)
			'生气', '愤怒', '气死了', '讨厌', '烦人', '恼火', '可恶',
			'可恨', '气愤', '愤慨',
			// English - anger
			'angry', 'furious', 'annoyed', 'irritated', 'frustrated',
			'outraged', 'hate', 'despise', 'disgusted', 'rage',
		],
	},
	{
		preset: 'surprised',
		priority: 7,
		keywords: [
			// Chinese - surprise (distinct exclamations)
			'惊讶', '没想到', '意外', '天哪', '哇塞', '震惊',
			'想不到', '不可思议', '居然', '竟然', '吓我一跳',
			'真的吗', '不会吧',
			// English - surprise
			'surprised', 'wow', 'omg', 'oh my god', 'shocking', 'unexpected',
			'incredible', 'unbelievable', 'whoa', 'no way', 'astonishing',
		],
	},
	{
		preset: 'nod',
		priority: 4,
		keywords: [
			// Chinese - strong agreement (avoid common conversational words)
			'正确', '完全对', '没错', '对对对', '确实', '同意',
			'认同', '赞同', '一定是', '肯定是', '绝对',
			// English - strong agreement
			'exactly', 'indeed', 'agree', 'absolutely', 'definitely',
			'precisely', 'of course', 'you got it', 'certainly',
		],
	},
	{
		preset: 'shake_head',
		priority: 4,
		keywords: [
			// Chinese - disagreement (distinct negations, not common words)
			'不对', '不太行', '错了', '不正确', '不同意', '反对',
			'糟糕', '失败', '错误',
			// English - disagreement
			'wrong', 'incorrect', 'disagree', 'nope', 'refuse', 'reject',
			'mistake', 'fail', 'invalid', 'impossible',
		],
	},
	{
		preset: 'thinking',
		priority: 3,
		keywords: [
			// Chinese - thinking expressions (distinct phrases)
			'让我想想', '让我思考', '想一下', '这个嘛', '想想看', '让我看看',
			'仔细分析', '琢磨', '推理一下',
			// English - thinking
			'let me think', 'considering', 'pondering', 'let me see',
			'interesting question', 'contemplating', 'hmm',
		],
	},
];

/** Result of intercepting text for animation triggers */
export type InterceptResult = {
	/** The preset to play, or null if no match */
	preset: string | null;
	/** The keyword that triggered the match */
	matchedKeyword: string | null;
	/** Priority of the match */
	priority: number;
};

/**
 * Intercept text for emotional keywords and return the best matching animation.
 *
 * @param text - The text to scan (typically a sentence from LLM streaming)
 * @param triggers - Animation trigger mappings (defaults to DEFAULT_ANIMATION_TRIGGERS)
 * @returns The best matching animation or null result
 */
export function interceptForAnimation(
	text: string,
	triggers: AnimationTrigger[] = DEFAULT_ANIMATION_TRIGGERS
): InterceptResult {
	const lowerText = text.toLowerCase();
	let bestMatch: InterceptResult = { preset: null, matchedKeyword: null, priority: -1 };

	for (const trigger of triggers) {
		for (const keyword of trigger.keywords) {
			// Check if keyword exists in text
			// Use word boundaries for short words to avoid false positives
			const keywordLower = keyword.toLowerCase();

			let found = false;

			if (keywordLower.length <= 2) {
				// For short keywords, require word boundaries or be CJK
				const isCJK = /[\u4e00-\u9fff]/.test(keyword);
				if (isCJK) {
					// CJK characters don't need word boundaries
					found = lowerText.includes(keywordLower);
				} else {
					// For short English words, use word boundary regex
					const regex = new RegExp(`\\b${escapeRegex(keywordLower)}\\b`, 'i');
					found = regex.test(text);
				}
			} else {
				// Longer keywords can use simple includes
				found = lowerText.includes(keywordLower);
			}

			if (found && trigger.priority > bestMatch.priority) {
				bestMatch = {
					preset: trigger.preset,
					matchedKeyword: keyword,
					priority: trigger.priority,
				};
			}
		}
	}

	return bestMatch;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * State tracker to avoid triggering animations too rapidly.
 * Uses GLOBAL cooldown - any animation trigger blocks all new triggers.
 */
export class AnimationInterceptorState {
	private lastTriggerTime = 0;
	private globalCooldownMs: number;
	private isAnimationPlaying = false;
	private animationEndTime = 0;

	constructor(globalCooldownMs = 4000) {
		this.globalCooldownMs = globalCooldownMs;
	}

	/**
	 * Check if we should trigger an animation based on global cooldown.
	 * Returns true if animation should be triggered, false if blocked.
	 */
	shouldTrigger(preset: string): boolean {
		const now = Date.now();

		// Block if we're in global cooldown period
		if (now - this.lastTriggerTime < this.globalCooldownMs) {
			return false;
		}

		// Block if animation is still expected to be playing
		if (this.isAnimationPlaying && now < this.animationEndTime) {
			return false;
		}

		this.lastTriggerTime = now;
		return true;
	}

	/**
	 * Mark that an animation has started playing.
	 * @param durationMs Expected duration of the animation
	 */
	markAnimationStarted(durationMs: number = 2000): void {
		this.isAnimationPlaying = true;
		this.animationEndTime = Date.now() + durationMs;
	}

	/**
	 * Mark that an animation has finished playing.
	 */
	markAnimationEnded(): void {
		this.isAnimationPlaying = false;
	}

	/**
	 * Reset state (e.g., when starting a new response)
	 */
	reset(): void {
		this.lastTriggerTime = 0;
		this.isAnimationPlaying = false;
		this.animationEndTime = 0;
	}
}

/**
 * Create a sentence interceptor function that can be called on each TTS sentence.
 *
 * @param onTrigger - Callback when an animation should be triggered. Returns animation duration in ms.
 * @param globalCooldownMs - Minimum time between any animation triggers (default: 4 seconds)
 */
export function createSentenceInterceptor(
	onTrigger: (preset: string, keyword: string) => number | Promise<number> | void,
	globalCooldownMs = 4000
): {
	intercept: (sentence: string) => void;
	reset: () => void;
	markAnimationEnded: () => void;
} {
	const state = new AnimationInterceptorState(globalCooldownMs);

	return {
		intercept(sentence: string) {
			const result = interceptForAnimation(sentence);
			if (result.preset && result.matchedKeyword && state.shouldTrigger(result.preset)) {
				// Mark animation as starting with default duration
				state.markAnimationStarted(2500);
				
				// Call the trigger callback
				const durationOrPromise = onTrigger(result.preset, result.matchedKeyword);
				
				// If callback returns duration, update the animation end timer
				if (typeof durationOrPromise === 'number') {
					state.markAnimationStarted(durationOrPromise);
				} else if (durationOrPromise instanceof Promise) {
					durationOrPromise.then((duration) => {
						if (typeof duration === 'number') {
							state.markAnimationStarted(duration);
						}
					});
				}
			}
		},
		reset() {
			state.reset();
		},
		markAnimationEnded() {
			state.markAnimationEnded();
		},
	};
}
