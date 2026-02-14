<script lang="ts">
	import { onMount, onDestroy, getContext } from 'svelte';
	import { showVrmAvatar } from '$lib/stores';
	import Tooltip from '$lib/components/common/Tooltip.svelte';

	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	const i18n = getContext<Writable<i18nType>>('i18n');

	let videoEl: HTMLVideoElement;
	let stream: MediaStream | null = null;
	let devices: MediaDeviceInfo[] = [];
	let selectedDeviceId: string = '';
	let showDevicePicker = false;
	let cameraError = '';

	// Dragging state
	let overlayEl: HTMLDivElement;
	let dragging = false;
	let dragOffset = { x: 0, y: 0 };
	let pos = { x: -1, y: -1 }; // -1 means uninitialized, will default to bottom-right

	// Resize
	let overlayWidth = 280;
	let overlayHeight = 280;
	let resizing = false;
	let resizeStart = { x: 0, y: 0, w: 0, h: 0 };

	async function enumerateDevices() {
		try {
			const allDevices = await navigator.mediaDevices.enumerateDevices();
			devices = allDevices.filter((d) => d.kind === 'videoinput');
			if (devices.length > 0 && !selectedDeviceId) {
				// Prefer VSeeFace virtual camera if found
				const vsf = devices.find(
					(d) =>
						d.label.toLowerCase().includes('vseefaceCamera') ||
						d.label.toLowerCase().includes('vseefacecamera') ||
						d.label.toLowerCase().includes('unitycapture') ||
						d.label.toLowerCase().includes('obs virtual') ||
						d.label.toLowerCase().includes('virtual')
				);
				selectedDeviceId = vsf ? vsf.deviceId : devices[0].deviceId;
			}
		} catch (e) {
			console.error('Failed to enumerate devices', e);
		}
	}

	async function startStream() {
		cameraError = '';
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
		}
		if (!selectedDeviceId) {
			return;
		}
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { deviceId: { exact: selectedDeviceId }, width: 640, height: 640 },
				audio: false
			});
			if (videoEl) {
				videoEl.srcObject = stream;
			}
		} catch (e: any) {
			cameraError = e?.message || 'Camera access denied';
			console.error('Camera error:', e);
		}
	}

	function stopStream() {
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
		if (resizing) {
			const dw = e.clientX - resizeStart.x;
			const dh = e.clientY - resizeStart.y;
			overlayWidth = Math.max(160, Math.min(640, resizeStart.w + dw));
			overlayHeight = Math.max(160, Math.min(640, resizeStart.h + dh));
		}
	}

	function onMouseUp() {
		dragging = false;
		resizing = false;
	}

	function onResizeStart(e: MouseEvent) {
		resizing = true;
		resizeStart = { x: e.clientX, y: e.clientY, w: overlayWidth, h: overlayHeight };
		e.preventDefault();
		e.stopPropagation();
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
	});

	onDestroy(() => {
		stopStream();
		if (typeof window !== 'undefined') {
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}
	});
</script>

{#if $showVrmAvatar}
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		bind:this={overlayEl}
		class="fixed z-50 rounded-2xl overflow-hidden shadow-2xl border border-gray-200/50 dark:border-gray-700/50 bg-black/80 backdrop-blur-sm select-none"
		style="left: {pos.x}px; top: {pos.y}px; width: {overlayWidth}px; height: {overlayHeight}px;"
		on:mousedown={onMouseDown}
	>
		<!-- Title bar -->
		<div
			class="flex items-center justify-between px-3 py-1.5 bg-gray-900/90 cursor-move text-white text-xs"
		>
			<span class="font-medium opacity-80">VRM Avatar</span>
			<div class="flex items-center gap-1.5 no-drag">
				<!-- Camera select -->
				<Tooltip content={$i18n.t('Select Camera')}>
					<button
						class="p-1 rounded hover:bg-gray-700 transition"
						on:click={() => {
							showDevicePicker = !showDevicePicker;
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

		<!-- Device picker dropdown -->
		{#if showDevicePicker}
			<div class="absolute top-8 left-0 right-0 bg-gray-900/95 border-b border-gray-700 z-10 no-drag">
				<div class="p-2 flex flex-col gap-1 max-h-40 overflow-y-auto">
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
		<div class="relative w-full" style="height: calc(100% - 30px);">
			{#if cameraError}
				<div
					class="flex items-center justify-center h-full text-xs text-red-400 px-4 text-center"
				>
					{cameraError}
				</div>
			{:else if !stream}
				<div class="flex items-center justify-center h-full text-xs text-gray-500">
					{$i18n.t('Select a camera to preview your VRM avatar')}
				</div>
			{:else}
				<!-- svelte-ignore a11y-media-has-caption -->
				<video
					bind:this={videoEl}
					autoplay
					playsinline
					muted
					class="w-full h-full object-cover"
				/>
			{/if}
		</div>

		<!-- Resize handle -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize no-drag"
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
{/if}
