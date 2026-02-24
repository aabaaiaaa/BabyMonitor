/**
 * storage.js — Persistent storage utilities
 *
 * Provides a thin wrapper around localStorage for simple key/value
 * settings and device profiles, plus an IndexedDB interface for
 * larger binary data (audio files) used in TASK-013 / TASK-049.
 *
 * All localStorage keys are namespaced under "bm:" to avoid collisions
 * with other apps on the same origin.
 */

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_PREFIX = 'bm:';

/**
 * Read a value from localStorage, parsed as JSON.
 * Returns `defaultValue` if the key is absent or unparseable.
 * @param {string} key
 * @param {*} defaultValue
 * @returns {*}
 */
export function lsGet(key, defaultValue = null) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

/**
 * Write a JSON-serialisable value to localStorage.
 * Silently swallows QuotaExceededError.
 * @param {string} key
 * @param {*} value
 */
export function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('[storage] localStorage write failed:', e);
  }
}

/**
 * Remove a key from localStorage.
 * @param {string} key
 */
export function lsRemove(key) {
  localStorage.removeItem(LS_PREFIX + key);
}

// ---------------------------------------------------------------------------
// Global / device-level settings (TASK-032)
// ---------------------------------------------------------------------------

/** Keys for global settings stored in localStorage. */
export const SETTING_KEYS = {
  THEME:              'theme',           // 'light' | 'dark'
  THEME_PROMPT_SEEN:  'themeprompt',     // boolean
  ONBOARDING_DONE:    'onboarding',      // boolean
  SAFE_SLEEP_ACK:     'safesleep',       // boolean
  NOTIF_PROMPTED:     'notifprompted',   // boolean
  NOTIF_GRANTED:      'notifgranted',    // boolean
  PREFERRED_METHOD:   'connmethod',      // 'peerjs' | 'offline'
  DEVICE_ID:          'deviceid',        // string (baby device's unique ID)
  PEER_ID:            'peerid',          // string (stable PeerJS peer ID, TASK-060)
  DEVICE_ROLE:        'role',            // 'baby' | 'parent' | null
  DEFAULT_MODE:       'defaultmode',     // soothing mode name
  DEFAULT_TRACK:      'defaulttrack',    // track filename
  FADE_PRESETS:       'fadepresets',     // array of durations
  VIDEO_QUALITY:      'videoquality',    // 'low' | 'medium' | 'high'
  SPEAK_MODE:         'speakmode',       // 'ptt' | 'toggle'
  CAMERA_FACING:      'camerafacing',    // 'user' | 'environment'
  AUDIO_ONLY:         'audioonly',       // boolean — audio-only mode preference
  ORIENTATION:        'orientation',     // 'auto' | 'portrait' | ...
  PEERJS_SERVER:      'peerjsserver',    // custom PeerJS server config (object|null)
  TURN_CONFIG:        'turnconfig',      // TURN server config (object|null)
  PAIRED_DEVICES:     'paireddevices',   // array of saved device profiles
  BACKUP_ID_POOL:     'backuppool',      // string[] — baby device's pre-agreed backup peer ID pool (TASK-061)
  BACKUP_POOL_INDEX:  'backuppoolidx',   // number  — current index into the backup pool (TASK-061)
};

/**
 * Return all global settings merged with defaults.
 * @returns {object}
 */
export function getSettings() {
  return {
    theme:            lsGet(SETTING_KEYS.THEME, 'light'),
    themePromptSeen:  lsGet(SETTING_KEYS.THEME_PROMPT_SEEN, false),
    onboardingDone:   lsGet(SETTING_KEYS.ONBOARDING_DONE, false),
    safeSleepAck:     lsGet(SETTING_KEYS.SAFE_SLEEP_ACK, false),
    notifPrompted:    lsGet(SETTING_KEYS.NOTIF_PROMPTED, false),
    notifGranted:     lsGet(SETTING_KEYS.NOTIF_GRANTED, false),
    preferredMethod:  lsGet(SETTING_KEYS.PREFERRED_METHOD, 'peerjs'),
    deviceId:         lsGet(SETTING_KEYS.DEVICE_ID, null),
    deviceRole:       lsGet(SETTING_KEYS.DEVICE_ROLE, null),
    defaultMode:      lsGet(SETTING_KEYS.DEFAULT_MODE, 'off'),
    defaultTrack:     lsGet(SETTING_KEYS.DEFAULT_TRACK, null),
    fadePresets:      lsGet(SETTING_KEYS.FADE_PRESETS, [15, 30, 45, 60]),
    videoQuality:     lsGet(SETTING_KEYS.VIDEO_QUALITY, 'medium'),
    speakMode:        lsGet(SETTING_KEYS.SPEAK_MODE, 'ptt'),
    cameraFacing:     lsGet(SETTING_KEYS.CAMERA_FACING, 'environment'),
    audioOnly:        lsGet(SETTING_KEYS.AUDIO_ONLY, false),
    orientation:      lsGet(SETTING_KEYS.ORIENTATION, 'auto'),
    peerjsServer:     lsGet(SETTING_KEYS.PEERJS_SERVER, null),
    turnConfig:       lsGet(SETTING_KEYS.TURN_CONFIG, null),
    pairedDevices:    lsGet(SETTING_KEYS.PAIRED_DEVICES, []),
  };
}

/**
 * Persist a single setting.
 * @param {string} key  — one of SETTING_KEYS values
 * @param {*} value
 */
export function saveSetting(key, value) {
  lsSet(key, value);
}

// ---------------------------------------------------------------------------
// Device profiles (TASK-023, TASK-032)
// Each paired baby device has a profile stored in the pairedDevices array.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DeviceProfile
 * @property {string}      id               — device's unique ID
 * @property {string}      label            — user-assigned label
 * @property {number}      noiseThreshold   — noise alert threshold (0–100)
 * @property {number}      motionThreshold  — motion alert threshold (0–100)
 * @property {number}      batteryThreshold — low battery alert threshold (%)
 * @property {string|null} backupPoolJson   — JSON for the pre-agreed backup ID pool:
 *                                            serialised as { pool: string[], index: number }
 *                                            where pool is the full array of backup peer IDs
 *                                            and index is the current/last-known pool index.
 *                                            (TASK-061)
 */

/**
 * Return all saved device profiles.
 * @returns {DeviceProfile[]}
 */
export function getDeviceProfiles() {
  return lsGet(SETTING_KEYS.PAIRED_DEVICES, []);
}

/**
 * Find a device profile by ID.
 * @param {string} deviceId
 * @returns {DeviceProfile|null}
 */
export function getDeviceProfile(deviceId) {
  const profiles = getDeviceProfiles();
  return profiles.find(p => p.id === deviceId) ?? null;
}

/**
 * Save or update a device profile (upsert by ID).
 * @param {DeviceProfile} profile
 */
export function saveDeviceProfile(profile) {
  const profiles = getDeviceProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], ...profile };
  } else {
    profiles.push({
      noiseThreshold:  60,
      motionThreshold: 50,
      batteryThreshold: 15,
      backupPoolJson:  null, // TASK-061: populated when baby sends its ID pool
      ...profile,
    });
  }
  lsSet(SETTING_KEYS.PAIRED_DEVICES, profiles);
}

/**
 * Delete a device profile by ID.
 * @param {string} deviceId
 */
export function deleteDeviceProfile(deviceId) {
  const profiles = getDeviceProfiles().filter(p => p.id !== deviceId);
  lsSet(SETTING_KEYS.PAIRED_DEVICES, profiles);
}

// ---------------------------------------------------------------------------
// Unique device ID generation (TASK-023)
// ---------------------------------------------------------------------------

/**
 * Return the baby device's persistent unique ID.
 * Creates and stores one on first call.
 * @returns {string}
 */
export function getOrCreateDeviceId() {
  let id = lsGet(SETTING_KEYS.DEVICE_ID, null);
  if (!id) {
    id = crypto.randomUUID();
    lsSet(SETTING_KEYS.DEVICE_ID, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// IndexedDB interface (TASK-013, TASK-049)
// Audio file library stored as blobs in an "audioFiles" object store.
// ---------------------------------------------------------------------------

const DB_NAME    = 'BabyMonitorDB';
const DB_VERSION = 1;
const STORE_NAME = 'audioFiles';

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * Open (or create) the IndexedDB database.
 * Returns a promise that resolves with the IDBDatabase instance.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('dateAdded', 'dateAdded', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * @typedef {object} AudioFileRecord
 * @property {string} id       — UUID
 * @property {string} name     — user-facing filename
 * @property {Blob}   blob     — the audio data
 * @property {number} size     — byte length
 * @property {number} duration — seconds (if known, else 0)
 * @property {string} type     — 'uploaded' | 'recorded' | 'received'
 * @property {number} dateAdded — Unix timestamp (ms)
 */

/**
 * Save an audio file blob to IndexedDB.
 * @param {Omit<AudioFileRecord, 'id'>} record
 * @returns {Promise<string>} the new record's ID
 */
export async function saveAudioFile(record) {
  const db = await openDB();
  const id = crypto.randomUUID();
  const full = { ...record, id };

  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(full);
    req.onsuccess = () => resolve(id);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Retrieve an audio file record by ID.
 * @param {string} id
 * @returns {Promise<AudioFileRecord|null>}
 */
export async function getAudioFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * List all audio file records (metadata only — no blob).
 * @returns {Promise<Omit<AudioFileRecord, 'blob'>[]>}
 */
export async function listAudioFiles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = (e) => {
      const records = e.target.result.map(r => {
        // eslint-disable-next-line no-unused-vars
        const { blob: _blob, ...meta } = r;
        return meta;
      });
      resolve(records);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Delete an audio file record by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteAudioFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}
