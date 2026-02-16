/**
 * VRM File Storage using IndexedDB
 * 
 * Stores VRM files locally in the browser for persistence
 * across sessions without requiring backend storage.
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'open-webui-vrm';
const DB_VERSION = 3;
const STORE_NAME = 'vrm-files';
const PRESET_STORE = 'camera-presets';
const ANIMATION_STORE = 'animation-presets';

interface StoredVRM {
	id: string;
	name: string;
	data: ArrayBuffer;
	timestamp: number;
}

/**
 * Camera preset for saving view state
 */
export interface CameraPreset {
	id: string;
	name: string;
	vrmName: string; // Associated VRM model name
	cameraDistance: number;
	cameraTargetY: number;
	cameraOffsetX: number;
	cameraOffsetY: number;
	modelRotationX: number;
	modelRotationY: number;
	focalLength: number;
	lightTheta: number;
	lightPhi: number;
	timestamp: number;
}

/**
 * Animation preset - stores head/face animation data
 */
export interface AnimationPreset {
	id: string;
	name: string;
	vrmName: string;
	frames: Array<{
		headRotation?: { pitch: number; yaw: number; roll: number };
		leftEyeRotation?: { pitch: number; yaw: number; roll: number };
		rightEyeRotation?: { pitch: number; yaw: number; roll: number };
		leftEyeBlink?: number;
		rightEyeBlink?: number;
		blendshapes?: Record<string, number>; // All facial blendshapes
	}>;
	duration: number;
	fps: number;
	timestamp: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

async function getDB(): Promise<IDBPDatabase> {
	if (!dbPromise) {
		dbPromise = openDB(DB_NAME, DB_VERSION, {
			upgrade(db, oldVersion) {
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(PRESET_STORE)) {
					const presetStore = db.createObjectStore(PRESET_STORE, { keyPath: 'id' });
					presetStore.createIndex('vrmName', 'vrmName', { unique: false });
				}
				if (!db.objectStoreNames.contains(ANIMATION_STORE)) {
					const animStore = db.createObjectStore(ANIMATION_STORE, { keyPath: 'id' });
					animStore.createIndex('vrmName', 'vrmName', { unique: false });
				}
			}
		});
	}
	return dbPromise;
}

/**
 * Save a VRM file to IndexedDB
 */
export async function saveVRM(id: string, name: string, file: File | ArrayBuffer): Promise<void> {
	const db = await getDB();
	
	let data: ArrayBuffer;
	if (file instanceof File) {
		data = await file.arrayBuffer();
	} else {
		data = file;
	}

	const record: StoredVRM = {
		id,
		name,
		data,
		timestamp: Date.now()
	};

	await db.put(STORE_NAME, record);
}

/**
 * Load a VRM file from IndexedDB
 */
export async function loadVRM(id: string): Promise<{ name: string; data: ArrayBuffer } | null> {
	const db = await getDB();
	const record = await db.get(STORE_NAME, id) as StoredVRM | undefined;
	
	if (!record) return null;
	
	return {
		name: record.name,
		data: record.data
	};
}

/**
 * Delete a VRM file from IndexedDB
 */
export async function deleteVRM(id: string): Promise<void> {
	const db = await getDB();
	await db.delete(STORE_NAME, id);
}

/**
 * List all stored VRM files
 */
export async function listVRMs(): Promise<Array<{ id: string; name: string; timestamp: number }>> {
	const db = await getDB();
	const all = await db.getAll(STORE_NAME) as StoredVRM[];
	
	return all.map(record => ({
		id: record.id,
		name: record.name,
		timestamp: record.timestamp
	}));
}

/**
 * Get the primary/active VRM file (id = 'primary')
 */
export async function getPrimaryVRM(): Promise<{ name: string; data: ArrayBuffer } | null> {
	return loadVRM('primary');
}

/**
 * Set the primary/active VRM file
 */
export async function setPrimaryVRM(name: string, file: File | ArrayBuffer): Promise<void> {
	return saveVRM('primary', name, file);
}

/**
 * Convert ArrayBuffer to File for use with VRM loader
 */
export function arrayBufferToFile(data: ArrayBuffer, name: string): File {
	const blob = new Blob([data], { type: 'model/gltf-binary' });
	return new File([blob], name, { type: 'model/gltf-binary' });
}

// ── Camera Presets ─────────────────────────────────────────────────────────

/**
 * Save a camera preset
 */
export async function saveCameraPreset(preset: Omit<CameraPreset, 'timestamp'>): Promise<void> {
	const db = await getDB();
	const record: CameraPreset = {
		...preset,
		timestamp: Date.now()
	};
	await db.put(PRESET_STORE, record);
}

/**
 * Load a camera preset by ID
 */
export async function loadCameraPreset(id: string): Promise<CameraPreset | null> {
	const db = await getDB();
	const record = await db.get(PRESET_STORE, id) as CameraPreset | undefined;
	return record ?? null;
}

/**
 * Delete a camera preset
 */
export async function deleteCameraPreset(id: string): Promise<void> {
	const db = await getDB();
	await db.delete(PRESET_STORE, id);
}

/**
 * List all camera presets, optionally filtered by VRM name
 */
export async function listCameraPresets(vrmName?: string): Promise<CameraPreset[]> {
	const db = await getDB();
	
	if (vrmName) {
		const index = db.transaction(PRESET_STORE).store.index('vrmName');
		return (await index.getAll(vrmName)) as CameraPreset[];
	}
	
	return (await db.getAll(PRESET_STORE)) as CameraPreset[];
}

/**
 * Get the "last used" camera preset for a VRM (auto-saved)
 */
export async function getLastCameraPreset(vrmName: string): Promise<CameraPreset | null> {
	return loadCameraPreset(`last:${vrmName}`);
}

/**
 * Save the "last used" camera preset for a VRM (auto-save on changes)
 */
export async function saveLastCameraPreset(
	vrmName: string,
	state: Omit<CameraPreset, 'id' | 'name' | 'vrmName' | 'timestamp'>
): Promise<void> {
	return saveCameraPreset({
		id: `last:${vrmName}`,
		name: 'Last Used',
		vrmName,
		...state
	});
}

/**
 * Generate a unique preset ID
 */
export function generatePresetId(): string {
	return `preset:${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ── Animation Presets ──────────────────────────────────────────────────────

/**
 * Save an animation preset
 */
export async function saveAnimationPreset(preset: Omit<AnimationPreset, 'timestamp'>): Promise<void> {
	const db = await getDB();
	const record: AnimationPreset = {
		...preset,
		timestamp: Date.now()
	};
	await db.put(ANIMATION_STORE, record);
}

/**
 * Load an animation preset by ID
 */
export async function loadAnimationPreset(id: string): Promise<AnimationPreset | null> {
	const db = await getDB();
	const record = await db.get(ANIMATION_STORE, id) as AnimationPreset | undefined;
	return record ?? null;
}

/**
 * Delete an animation preset
 */
export async function deleteAnimationPreset(id: string): Promise<void> {
	const db = await getDB();
	await db.delete(ANIMATION_STORE, id);
}

/**
 * List animation presets, optionally filtered by VRM name
 */
export async function listAnimationPresets(vrmName?: string): Promise<AnimationPreset[]> {
	const db = await getDB();
	
	if (vrmName) {
		const index = db.transaction(ANIMATION_STORE).store.index('vrmName');
		return (await index.getAll(vrmName)) as AnimationPreset[];
	}
	
	return (await db.getAll(ANIMATION_STORE)) as AnimationPreset[];
}

/**
 * Generate a unique animation preset ID
 */
export function generateAnimationId(): string {
	return `anim:${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
