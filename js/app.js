import { CameraEngine } from './camera-engine.js';
import { FILTERS, buildCssFilter, getFilterById } from './filters.js';
import {
  saveMediaItem,
  getAllMediaItems,
  deleteMediaItems,
  clearAllMediaItems
} from './storage.js';
import {
  buildMediaFilename,
  blobToFile,
  saveFilesToIOSPhotos,
  downloadBlobAsFile,
  isIOSDevice
} from './ios-photos.js';

// DOM参照
const el = {
  video: document.getElementById('camera-video'),
  freezeCanvas: document.getElementById('freeze-canvas'),
  canvas: document.getElementById('capture-canvas'),
  stage: document.getElementById('viewfinder-stage'),
  frame: document.getElementById('viewfinder-frame'),
  portraitOverlay: document.getElementById('portrait-overlay'),
  gridOverlay: document.getElementById('grid-overlay'),
  levelOverlay: document.getElementById('level-overlay'),
  levelBar: document.getElementById('level-bar'),
  aeAfBadge: document.getElementById('ae-af-badge'),
  statusPill: document.getElementById('status-pill'),
  focusReticle: document.getElementById('focus-reticle'),
  focusSunIcon: document.getElementById('focus-sun-icon'),
  timerCountdown: document.getElementById('timer-countdown'),
  shutterFlash: document.getElementById('shutter-flash'),
  flipBlur: document.getElementById('flip-blur'),

  permissionOverlay: document.getElementById('camera-permission-overlay'),
  permissionTitle: document.getElementById('permission-title'),
  permissionDesc: document.getElementById('permission-desc'),
  permissionNote: document.getElementById('permission-note'),
  btnStartCamera: document.getElementById('btn-start-camera'),

  btnAutoSave: document.getElementById('btn-auto-save'),
  autoSaveLabel: document.getElementById('auto-save-label'),
  btnDrawerToggle: document.getElementById('btn-drawer-toggle'),
  btnTopExposure: document.getElementById('btn-top-exposure'),
  btnTopFilter: document.getElementById('btn-top-filter'),
  recordingTimer: document.getElementById('recording-timer'),
  recordingTimeText: document.getElementById('recording-time-text'),

  zoomWheel: document.getElementById('zoom-wheel'),
  zoomWheelValue: document.getElementById('zoom-wheel-value'),
  zoomRangeSlider: document.getElementById('zoom-range-slider'),
  lensSelector: document.getElementById('lens-selector'),

  quickSaveToast: document.getElementById('quick-save-toast'),
  quickSaveThumb: document.getElementById('quick-save-thumb'),
  quickSaveMsg: document.getElementById('quick-save-msg'),
  btnQuickSaveNow: document.getElementById('btn-quick-save-now'),

  drawer: document.getElementById('control-drawer'),
  subpanelExposure: document.getElementById('subpanel-exposure'),
  subpanelFilters: document.getElementById('subpanel-filters'),
  subpanelLenses: document.getElementById('subpanel-lenses'),
  exposureSlider: document.getElementById('exposure-slider'),
  exposureValueLabel: document.getElementById('exposure-value-label'),
  btnExposureReset: document.getElementById('btn-exposure-reset'),
  filterStrip: document.getElementById('filter-strip'),
  lensChipList: document.getElementById('lens-chip-list'),
  lensCountLabel: document.getElementById('lens-count-label'),

  toolAspect: document.getElementById('tool-aspect'),
  toolAspectVal: document.getElementById('tool-aspect-val'),
  toolTimer: document.getElementById('tool-timer'),
  toolTimerVal: document.getElementById('tool-timer-val'),
  toolExposure: document.getElementById('tool-exposure'),
  toolExposureVal: document.getElementById('tool-exposure-val'),
  toolFilter: document.getElementById('tool-filter'),
  toolFilterVal: document.getElementById('tool-filter-val'),
  toolGrid: document.getElementById('tool-grid'),
  toolLevel: document.getElementById('tool-level'),
  toolMirror: document.getElementById('tool-mirror'),
  toolLenses: document.getElementById('tool-lenses'),

  modeSelector: document.getElementById('mode-selector'),
  btnGallery: document.getElementById('btn-gallery'),
  galleryThumbImg: document.getElementById('gallery-thumb-img'),
  galleryThumbPlaceholder: document.getElementById('gallery-thumb-placeholder'),
  unsavedBadge: document.getElementById('unsaved-badge'),
  btnShutter: document.getElementById('btn-shutter'),
  btnFlipCamera: document.getElementById('btn-flip-camera'),

  galleryModal: document.getElementById('gallery-modal'),
  btnGalleryClose: document.getElementById('btn-gallery-close'),
  galleryTitle: document.getElementById('gallery-title'),
  gallerySubtitle: document.getElementById('gallery-subtitle'),
  btnGallerySaveAll: document.getElementById('btn-gallery-save-all'),
  btnGalleryClearAll: document.getElementById('btn-gallery-clear-all'),
  galleryEmpty: document.getElementById('gallery-empty'),
  galleryViewer: document.getElementById('gallery-viewer'),
  viewerImage: document.getElementById('viewer-image'),
  viewerVideo: document.getElementById('viewer-video'),
  viewerMeta: document.getElementById('viewer-meta'),
  btnViewerSave: document.getElementById('btn-viewer-save'),
  btnViewerDownload: document.getElementById('btn-viewer-download'),
  btnViewerDelete: document.getElementById('btn-viewer-delete'),
  galleryStrip: document.getElementById('gallery-strip'),
  iosHintBar: document.getElementById('ios-hint-bar'),
  btnDismissHint: document.getElementById('btn-dismiss-hint')
};

const engine = new CameraEngine(el.video, el.canvas);

// アプリ状態
const state = {
  ready: false,
  mode: 'photo', // 'video' | 'photo' | 'portrait' | 'square'
  aspectRatio: 'full', // 'full' | '4:3' | '16:9' | '1:1'
  timerSec: 0, // 0 | 3 | 10
  filterId: 'original',
  exposureEv: 0,
  useSoftwareExposure: true,
  gridOn: true,
  levelOn: false,
  mirrorFront: true,
  autoSaveSheet: true, // true: 撮影直後にiOS写真保存シートを開く / false: 連続撮影してあとで一括保存
  drawerOpen: false,
  activeSubpanel: null, // 'exposure' | 'filters' | 'lenses' | null
  busyCapturing: false,
  countdownTimerId: null,
  recordingStartAt: 0,
  recordingIntervalId: null,
  mediaList: [],
  selectedMediaId: null,
  lastCapturedItem: null,
  objectUrls: new Map()
};

let statusPillTimer = null;
let quickToastTimer = null;
let focusHideTimer = null;
let zoomWheelHideTimer = null;

// ===== フリーズフレーム（レンズ切替時の暗転防止トランジション） =====
let freezeFadeTimer = null;

function showFreezeFrame() {
  const video = el.video;
  if (!video.videoWidth || !video.videoHeight) return;
  clearTimeout(freezeFadeTimer);
  const fc = el.freezeCanvas;
  const maxDim = 480;
  const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
  fc.width = Math.max(1, Math.round(video.videoWidth * scale));
  fc.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = fc.getContext('2d', { alpha: false });
  ctx.save();
  if (engine.facingMode === 'user' && state.mirrorFront) {
    ctx.translate(fc.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, fc.width, fc.height);
  ctx.restore();
  fc.classList.remove('fade-out', 'hidden');
}

function hideFreezeFrame() {
  const fc = el.freezeCanvas;
  if (fc.classList.contains('hidden')) return;
  fc.classList.add('fade-out');
  clearTimeout(freezeFadeTimer);
  freezeFadeTimer = setTimeout(() => {
    fc.classList.add('hidden');
    fc.classList.remove('fade-out');
  }, 190);
}

engine.onBeforeLensSwitch = showFreezeFrame;
engine.onAfterLensSwitch = hideFreezeFrame;

// ===== 初期化 =====
async function bootstrap() {
  registerServiceWorker();
  renderFilterChips();
  applyInitialToolStates();
  bindEvents();
  await refreshGalleryFromStorage();

  // HTTPSチェック（iOS SafariではHTTPSまたはlocalhostが必須）
  const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) {
    el.permissionNote.textContent = '※ カメラ起動にはHTTPS接続が必要です。';
  } else if (isIOSDevice()) {
    el.permissionNote.textContent = '共有ボタン →「ホーム画面に追加」で純正アプリのように全画面で使えます。';
  }

  // 自動起動を試みる（既に許可済みならそのまま起動）
  try {
    await startCameraFlow();
  } catch {
    // 初回やユーザー操作が必要な環境ではスタートカードを表示したまま待つ
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
}

async function startCameraFlow() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el.permissionTitle.textContent = 'カメラを利用できません';
    el.permissionDesc.textContent = 'Safariなどの対応ブラウザ、かつHTTPS接続で開いてください。';
    el.btnStartCamera.classList.add('hidden');
    return;
  }

  try {
    el.btnStartCamera.disabled = true;
    el.btnStartCamera.textContent = 'カメラを起動中...';
    const summary = await engine.init();
    state.ready = true;
    el.permissionOverlay.classList.add('hidden');
    renderLensSelector(summary);
    renderDetectedLensChips(summary);
    updatePreviewTransformAndFilter();
    showStatusPill(summary.hasUltraWide ? '無音モード・超広角対応' : '無音モードで起動');
  } catch (err) {
    el.btnStartCamera.disabled = false;
    el.btnStartCamera.textContent = 'もう一度カメラを起動';
    el.permissionTitle.textContent = 'カメラの許可が必要です';
    el.permissionDesc.textContent =
      'iPhoneの「設定」→「Safari」→「カメラ」が許可されていることを確認し、下のボタンを押してください。';
    el.permissionNote.textContent = err?.message ? `詳細: ${err.message}` : '';
    throw err;
  }
}

function applyInitialToolStates() {
  el.gridOverlay.classList.toggle('hidden', !state.gridOn);
  el.toolGrid.classList.toggle('active', state.gridOn);
  el.toolMirror.classList.toggle('active', state.mirrorFront);
  el.toolAspectVal.textContent = state.aspectRatio;
  updateAutoSaveButtonUI();
  updateAspectFrame();

  if (localStorage.getItem('hideIosPhotoHint') === '1') {
    el.iosHintBar.classList.add('hidden');
  }
}

// ===== プレビュー表示更新（デジタルズーム / 鏡像 / フィルター / 露出） =====
function updatePreviewTransformAndFilter() {
  const mirror = engine.facingMode === 'user' && state.mirrorFront ? -1 : 1;
  const scale = Math.max(1.0, engine.digitalZoomFactor);
  el.video.style.transform = `scale(${mirror * scale}, ${scale})`;
  el.video.style.filter = buildCssFilter(state.filterId, state.exposureEv, state.useSoftwareExposure);
  el.portraitOverlay.classList.toggle('hidden', state.mode !== 'portrait');
}

function updateAspectFrame() {
  const effectiveAspect = state.mode === 'square' ? '1:1' : state.mode === 'video' ? 'full' : state.aspectRatio;
  el.frame.classList.remove('aspect-full', 'aspect-4-3', 'aspect-16-9', 'aspect-1-1');
  if (effectiveAspect === '1:1') {
    el.frame.classList.add('aspect-1-1');
  } else if (effectiveAspect === '16:9') {
    el.frame.classList.add('aspect-16-9');
  } else if (effectiveAspect === '4:3') {
    el.frame.classList.add('aspect-4-3');
  } else {
    el.frame.classList.add('aspect-full');
  }
  el.toolAspectVal.textContent = effectiveAspect === 'full' ? 'フル' : effectiveAspect;
}

// ===== レンズ倍率セレクター（0.5 / 1x / 2 / 3） =====
function renderLensSelector(summary) {
  el.lensSelector.innerHTML = '';
  const presets = summary.presets || [];
  const minZ = presets.length > 0 ? presets[0].zoom : 1.0;
  el.zoomRangeSlider.min = String(minZ);

  presets.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lens-btn';
    btn.dataset.zoom = String(p.zoom);
    btn.dataset.label = p.label;
    btn.dataset.activeLabel = p.activeLabel;
    btn.textContent = p.label;

    btn.addEventListener('click', async () => {
      if (!state.ready) return;
      await applyZoom(p.zoom, true);
    });

    // 倍率ボタン長押しで精密ズームホイールを表示
    let pressTimer = null;
    btn.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        showZoomWheel();
      }, 360);
    });
    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    btn.addEventListener('pointerup', clearPress);
    btn.addEventListener('pointercancel', clearPress);
    btn.addEventListener('pointerleave', clearPress);

    el.lensSelector.appendChild(btn);
  });

  syncLensButtonsActiveState();
}

function syncLensButtonsActiveState() {
  const btns = Array.from(el.lensSelector.querySelectorAll('.lens-btn'));
  if (btns.length === 0) return;

  // 最も近い倍率ボタンをアクティブにし、現在の厳密倍率（例 1.4×）を表示
  let closest = btns[0];
  let minDiff = Infinity;
  for (const b of btns) {
    const z = Number(b.dataset.zoom);
    const diff = Math.abs(z - engine.currentZoom);
    if (diff < minDiff) {
      minDiff = diff;
      closest = b;
    }
  }

  btns.forEach((b) => {
    const isAct = b === closest;
    b.classList.toggle('active', isAct);
    if (isAct) {
      const rounded = Math.round(engine.currentZoom * 10) / 10;
      const text = Number.isInteger(rounded) ? `${rounded}×` : `${rounded.toFixed(1)}×`;
      b.textContent = text;
    } else {
      b.textContent = b.dataset.label;
    }
  });

  el.zoomRangeSlider.value = String(engine.currentZoom.toFixed(1));
  el.zoomWheelValue.textContent = `${engine.currentZoom.toFixed(1)}×`;
}

async function applyZoom(zoomVal, allowLensSwitch = true) {
  try {
    const prevDevice = engine.activeDeviceId;
    const res = await engine.setZoom(zoomVal, { allowLensSwitch });
    updatePreviewTransformAndFilter();
    syncLensButtonsActiveState();
    if (prevDevice !== engine.activeDeviceId) {
      showStatusPill(engine.getActiveLensLabel());
      renderDetectedLensChips(engine.getLensSummary());
    }
    return res;
  } catch {
    // レンズ切替失敗時はデジタルズームのみで継続
  }
}

function showZoomWheel(autoHide = true) {
  el.zoomWheel.classList.remove('hidden');
  el.frame.classList.add('zoom-bar-open');
  clearTimeout(zoomWheelHideTimer);
  if (autoHide) {
    zoomWheelHideTimer = setTimeout(hideZoomWheel, 3500);
  }
}

function hideZoomWheel() {
  clearTimeout(zoomWheelHideTimer);
  el.zoomWheel.classList.add('hidden');
  el.frame.classList.remove('zoom-bar-open');
}

function renderDetectedLensChips(summary) {
  el.lensChipList.innerHTML = '';
  const list = summary.devices || [];
  el.lensCountLabel.textContent = `${list.length}個検出`;
  list.forEach((dev) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lens-device-chip' + (dev.deviceId === engine.activeDeviceId ? ' active' : '');
    chip.textContent = engine.getFriendlyLensName(dev);
    chip.addEventListener('click', async () => {
      el.flipBlur.classList.add('active');
      try {
        const res = await engine.selectDeviceById(dev.deviceId);
        const newSummary = engine.getLensSummary();
        renderLensSelector(newSummary);
        renderDetectedLensChips(newSummary);
        updatePreviewTransformAndFilter();
        if (res?.label) showStatusPill(res.label);
      } finally {
        setTimeout(() => el.flipBlur.classList.remove('active'), 180);
      }
    });
    el.lensChipList.appendChild(chip);
  });
}

// ===== フィルター =====
function renderFilterChips() {
  el.filterStrip.innerHTML = '';
  FILTERS.forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip' + (f.id === state.filterId ? ' active' : '');
    btn.dataset.filterId = f.id;

    const swatch = document.createElement('div');
    swatch.className = 'filter-preview-swatch';
    if (f.css) swatch.style.filter = f.css;

    const label = document.createElement('span');
    label.textContent = f.name;

    btn.appendChild(swatch);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      state.filterId = f.id;
      el.toolFilterVal.textContent = f.name;
      el.btnTopFilter.classList.toggle('active', f.id !== 'original');
      el.toolFilter.classList.toggle('active', f.id !== 'original');
      Array.from(el.filterStrip.children).forEach((c) => {
        c.classList.toggle('active', c.dataset.filterId === f.id);
      });
      updatePreviewTransformAndFilter();
      showStatusPill(`フィルター: ${f.name}`);
    });

    el.filterStrip.appendChild(btn);
  });
}

// ===== シャッター撮影（完全無音 + iOS純正写真アプリ保存） =====
async function handleShutterPress() {
  if (!state.ready) {
    await startCameraFlow().catch(() => {});
    return;
  }

  // ビデオモード
  if (state.mode === 'video') {
    if (engine.isRecording) {
      await finishVideoRecording();
    } else {
      await beginVideoRecording();
    }
    return;
  }

  // タイマー撮影
  if (state.timerSec > 0) {
    if (state.countdownTimerId) return;
    await runTimerCountdown(state.timerSec);
  }

  await takeSilentPhotoNow();
}

function runTimerCountdown(seconds) {
  return new Promise((resolve) => {
    let left = seconds;
    el.timerCountdown.textContent = String(left);
    el.timerCountdown.classList.remove('hidden');

    state.countdownTimerId = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(state.countdownTimerId);
        state.countdownTimerId = null;
        el.timerCountdown.classList.add('hidden');
        resolve();
      } else {
        el.timerCountdown.textContent = String(left);
      }
    }, 1000);
  });
}

async function takeSilentPhotoNow() {
  if (state.busyCapturing) return;
  state.busyCapturing = true;

  // 無音の視覚フラッシュのみ（音声出力なし）
  el.shutterFlash.classList.add('flash');
  setTimeout(() => el.shutterFlash.classList.remove('flash'), 110);

  try {
    const effectiveAspect = state.mode === 'square' ? '1:1' : state.aspectRatio;
    const frameAspect = el.frame.clientWidth && el.frame.clientHeight
      ? el.frame.clientWidth / el.frame.clientHeight
      : null;
    const { blob, meta } = await engine.captureSilentPhoto({
      aspectRatio: effectiveAspect,
      frameAspect,
      filterId: state.filterId,
      mirrorFront: state.mirrorFront,
      portraitMode: state.mode === 'portrait',
      useSoftwareExposure: state.useSoftwareExposure
    });

    const now = new Date();
    const filename = buildMediaFilename('photo', blob.type, now);
    const id = `photo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const item = {
      id,
      type: 'photo',
      mimeType: blob.type || 'image/jpeg',
      filename,
      blob,
      meta,
      createdAt: now.getTime(),
      savedToPhotos: false
    };

    // iOS Safariの User Activation が切れないよう、一時保存と並行して最速で共有シートを起動
    const dbSavePromise = saveMediaItem(item).then(() => refreshGalleryFromStorage());
    state.lastCapturedItem = item;

    if (state.autoSaveSheet) {
      const file = blobToFile(blob, filename);
      const shareRes = await saveFilesToIOSPhotos([file]);
      await dbSavePromise;

      if (shareRes.status === 'shared') {
        // 本体保存完了 → 容量節約のためアプリ内から完全に自動削除
        await purgeMediaItems([id]);
        showStatusPill('本体に保存・アプリから削除しました');
      } else if (shareRes.status === 'blocked' || shareRes.status === 'unsupported') {
        showQuickSaveToast(item, 'タップして「写真」アプリに保存');
      } else if (shareRes.status === 'cancelled') {
        showQuickSaveToast(item, '一時保存中（あとで保存できます）');
      }
    } else {
      await dbSavePromise;
      showQuickSaveToast(item, '無音撮影しました（一括保存できます）');
    }
  } catch (err) {
    showStatusPill(err?.message || '撮影に失敗しました');
  } finally {
    state.busyCapturing = false;
  }
}

async function beginVideoRecording() {
  const started = await engine.startVideoRecording();
  if (!started) {
    showStatusPill('このブラウザは録画に対応していません');
    return;
  }

  el.btnShutter.classList.add('recording');
  el.btnDrawerToggle.classList.add('hidden');
  el.recordingTimer.classList.remove('hidden');
  state.recordingStartAt = Date.now();
  el.recordingTimeText.textContent = '00:00';

  state.recordingIntervalId = setInterval(() => {
    const sec = Math.floor((Date.now() - state.recordingStartAt) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    el.recordingTimeText.textContent = `${m}:${s}`;
  }, 500);
}

async function finishVideoRecording() {
  clearInterval(state.recordingIntervalId);
  state.recordingIntervalId = null;
  el.btnShutter.classList.remove('recording');
  el.recordingTimer.classList.add('hidden');
  el.btnDrawerToggle.classList.remove('hidden');

  const res = await engine.stopVideoRecording();
  if (!res || !res.blob) return;

  const now = new Date();
  const filename = buildMediaFilename('video', res.mimeType, now);
  const id = `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const item = {
    id,
    type: 'video',
    mimeType: res.mimeType,
    filename,
    blob: res.blob,
    meta: res.meta,
    createdAt: now.getTime(),
    savedToPhotos: false
  };

  await saveMediaItem(item);
  await refreshGalleryFromStorage();
  state.lastCapturedItem = item;

  if (state.autoSaveSheet) {
    const file = blobToFile(res.blob, filename);
    const shareRes = await saveFilesToIOSPhotos([file]);
    if (shareRes.status === 'shared') {
      // 本体保存完了 → 容量節約のためアプリ内から完全に自動削除
      await purgeMediaItems([id]);
      showStatusPill('ビデオを本体保存・アプリから削除しました');
      return;
    }
  }
  showQuickSaveToast(item, '動画を撮影しました');
}

// ===== ギャラリー & 完全削除（スマホ容量解放） =====
function getObjectUrl(item) {
  if (!state.objectUrls.has(item.id)) {
    state.objectUrls.set(item.id, URL.createObjectURL(item.blob));
  }
  return state.objectUrls.get(item.id);
}

function revokeObjectUrlsForIds(ids) {
  const idSet = new Set(ids);
  for (const id of ids) {
    const url = state.objectUrls.get(id);
    if (url) {
      if (el.viewerImage.src === url) el.viewerImage.removeAttribute('src');
      if (el.viewerVideo.src === url) {
        el.viewerVideo.pause();
        el.viewerVideo.removeAttribute('src');
        el.viewerVideo.load();
      }
      if (el.galleryThumbImg.src === url) el.galleryThumbImg.removeAttribute('src');
      if (el.quickSaveThumb.src === url) el.quickSaveThumb.removeAttribute('src');
      URL.revokeObjectURL(url);
      state.objectUrls.delete(id);
    }
  }
  if (state.lastCapturedItem && idSet.has(state.lastCapturedItem.id)) {
    state.lastCapturedItem = null;
    el.quickSaveToast.classList.add('hidden');
  }
  if (state.selectedMediaId && idSet.has(state.selectedMediaId)) {
    state.selectedMediaId = null;
  }
}

async function purgeMediaItems(ids) {
  if (!ids || ids.length === 0) return;
  revokeObjectUrlsForIds(ids);
  await deleteMediaItems(ids);
  await refreshGalleryFromStorage();
}

async function purgeAllMediaItems() {
  const allIds = Array.from(state.objectUrls.keys());
  revokeObjectUrlsForIds(allIds);
  state.lastCapturedItem = null;
  state.selectedMediaId = null;
  el.viewerImage.removeAttribute('src');
  el.viewerVideo.pause();
  el.viewerVideo.removeAttribute('src');
  el.viewerVideo.load();
  el.galleryThumbImg.removeAttribute('src');
  el.quickSaveThumb.removeAttribute('src');
  el.quickSaveToast.classList.add('hidden');
  await clearAllMediaItems();
  await refreshGalleryFromStorage();
}

function formatTotalBytes(list) {
  const total = list.reduce((sum, item) => sum + (item.blob?.size || 0), 0);
  if (total === 0) return '0.0 MB';
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(0)} KB`;
  return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshGalleryFromStorage() {
  state.mediaList = await getAllMediaItems();
  const count = state.mediaList.length;
  const unsavedCount = state.mediaList.filter((m) => !m.savedToPhotos).length;

  // 左下サムネイル更新
  if (count > 0) {
    const latest = state.mediaList[0];
    if (latest.type === 'photo') {
      el.galleryThumbImg.src = getObjectUrl(latest);
      el.galleryThumbImg.classList.remove('hidden');
      el.galleryThumbPlaceholder.classList.add('hidden');
    } else {
      el.galleryThumbImg.classList.add('hidden');
      el.galleryThumbPlaceholder.classList.remove('hidden');
    }
  } else {
    el.galleryThumbImg.classList.add('hidden');
    el.galleryThumbPlaceholder.classList.remove('hidden');
  }

  // 未保存バッジ
  if (unsavedCount > 0) {
    el.unsavedBadge.textContent = String(unsavedCount);
    el.unsavedBadge.classList.remove('hidden');
  } else {
    el.unsavedBadge.classList.add('hidden');
  }

  if (!el.galleryModal.classList.contains('hidden')) {
    renderGalleryModal();
  }
}

function openGalleryModal(selectId = null) {
  el.galleryModal.classList.remove('hidden');
  if (selectId) {
    state.selectedMediaId = selectId;
  } else if (state.mediaList.length > 0 && !state.mediaList.some((m) => m.id === state.selectedMediaId)) {
    state.selectedMediaId = state.mediaList[0].id;
  }
  renderGalleryModal();
}

function closeGalleryModal() {
  el.viewerVideo.pause();
  el.galleryModal.classList.add('hidden');
}

function renderGalleryModal() {
  const list = state.mediaList;
  el.galleryTitle.textContent = `一時保存 (${list.length})`;
  el.gallerySubtitle.textContent = `使用容量: ${formatTotalBytes(list)}（本体保存で自動削除）`;

  if (list.length > 0) {
    el.btnGallerySaveAll.textContent = `${list.length}件を写真へ`;
    el.btnGallerySaveAll.classList.remove('hidden');
    el.btnGalleryClearAll.classList.remove('hidden');
  } else {
    el.btnGallerySaveAll.classList.add('hidden');
    el.btnGalleryClearAll.classList.add('hidden');
  }

  if (list.length === 0) {
    el.galleryEmpty.classList.remove('hidden');
    el.galleryViewer.classList.add('hidden');
    el.galleryStrip.innerHTML = '';
    return;
  }

  el.galleryEmpty.classList.add('hidden');
  el.galleryViewer.classList.remove('hidden');

  let current = list.find((m) => m.id === state.selectedMediaId) || list[0];
  state.selectedMediaId = current.id;

  const url = getObjectUrl(current);
  if (current.type === 'video') {
    el.viewerImage.classList.add('hidden');
    el.viewerVideo.src = url;
    el.viewerVideo.classList.remove('hidden');
  } else {
    el.viewerVideo.pause();
    el.viewerVideo.classList.add('hidden');
    el.viewerImage.src = url;
    el.viewerImage.classList.remove('hidden');
  }

  const dt = new Date(current.createdAt);
  const timeStr = dt.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const lensInfo = current.meta?.lensName || '';
  const zoomInfo = current.meta?.zoom ? `${Number(current.meta.zoom).toFixed(1)}×` : '';
  const resInfo = current.meta?.width ? `${current.meta.width}×${current.meta.height}` : '';
  const savedLabel = current.savedToPhotos ? '✓ 写真アプリ保存済み' : '未保存';
  el.viewerMeta.textContent = [timeStr, lensInfo, zoomInfo, resInfo, savedLabel].filter(Boolean).join(' ・ ');

  // ストリップ描画
  el.galleryStrip.innerHTML = '';
  list.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'strip-item' + (item.id === current.id ? ' active' : '');
    const itemUrl = getObjectUrl(item);

    if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = itemUrl;
      v.muted = true;
      v.playsInline = true;
      btn.appendChild(v);
      const tag = document.createElement('span');
      tag.className = 'strip-video-tag';
      tag.textContent = '動画';
      btn.appendChild(tag);
    } else {
      const img = document.createElement('img');
      img.src = itemUrl;
      img.alt = item.filename;
      btn.appendChild(img);
    }

    if (item.savedToPhotos) {
      const dot = document.createElement('span');
      dot.className = 'strip-saved-dot';
      btn.appendChild(dot);
    }

    btn.addEventListener('click', () => {
      state.selectedMediaId = item.id;
      renderGalleryModal();
    });
    el.galleryStrip.appendChild(btn);
  });
}

async function saveItemsToPhotosFlow(items) {
  if (!items || items.length === 0) return;
  const ids = items.map((i) => i.id);
  const files = items.map((it) => blobToFile(it.blob, it.filename));
  const res = await saveFilesToIOSPhotos(files);

  if (res.status === 'shared') {
    await purgeMediaItems(ids);
    showStatusPill(`${items.length}件を本体保存・アプリから完全削除しました`);
  } else if (res.status === 'unsupported') {
    // PCブラウザ等：通常のダウンロードへフォールバック後、アプリ内から完全削除
    items.forEach((it) => downloadBlobAsFile(it.blob, it.filename));
    await purgeMediaItems(ids);
    showStatusPill(`${items.length}件を保存・アプリから完全削除しました`);
  }
}

// ===== UIフィードバック =====
function showStatusPill(text, durationMs = 2000) {
  el.statusPill.textContent = text;
  el.statusPill.classList.remove('hidden');
  clearTimeout(statusPillTimer);
  statusPillTimer = setTimeout(() => {
    el.statusPill.classList.add('hidden');
  }, durationMs);
}

function showQuickSaveToast(item, msg) {
  if (item.type === 'photo') {
    el.quickSaveThumb.src = getObjectUrl(item);
    el.quickSaveThumb.classList.remove('hidden');
  } else {
    el.quickSaveThumb.classList.add('hidden');
  }
  el.quickSaveMsg.textContent = msg;
  el.quickSaveToast.classList.remove('hidden');
  clearTimeout(quickToastTimer);
  quickToastTimer = setTimeout(() => {
    el.quickSaveToast.classList.add('hidden');
  }, 5500);
}

function updateAutoSaveButtonUI() {
  el.btnAutoSave.classList.toggle('active', state.autoSaveSheet);
  el.autoSaveLabel.textContent = state.autoSaveSheet ? '即・写真保存' : '連続撮影';
}

function toggleDrawer(forceOpen = null) {
  state.drawerOpen = forceOpen !== null ? forceOpen : !state.drawerOpen;
  el.drawer.classList.toggle('hidden', !state.drawerOpen);
  el.btnDrawerToggle.setAttribute('aria-expanded', String(state.drawerOpen));
  if (!state.drawerOpen) {
    openSubpanel(null);
  }
}

function openSubpanel(name) {
  state.activeSubpanel = state.activeSubpanel === name ? null : name;
  el.subpanelExposure.classList.toggle('hidden', state.activeSubpanel !== 'exposure');
  el.subpanelFilters.classList.toggle('hidden', state.activeSubpanel !== 'filters');
  el.subpanelLenses.classList.toggle('hidden', state.activeSubpanel !== 'lenses');
  el.toolExposure.classList.toggle('active', state.activeSubpanel === 'exposure' || Math.abs(state.exposureEv) > 0.01);
  el.toolLenses.classList.toggle('active', state.activeSubpanel === 'lenses');
}

// ===== 水平器（ジャイロセンサー） =====
function handleDeviceOrientation(event) {
  if (!state.levelOn) return;
  const gamma = typeof event.gamma === 'number' ? event.gamma : 0;
  const clamped = Math.max(-45, Math.min(45, gamma));
  el.levelBar.style.transform = `rotate(${-clamped.toFixed(1)}deg)`;
  el.levelBar.classList.toggle('leveled', Math.abs(clamped) < 1.5);
}

async function toggleLevelTool() {
  if (!state.levelOn && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        showStatusPill('水平器にはモーションセンサー許可が必要です');
        return;
      }
    } catch {
      return;
    }
  }
  state.levelOn = !state.levelOn;
  el.levelOverlay.classList.toggle('hidden', !state.levelOn);
  el.toolLevel.classList.toggle('active', state.levelOn);
  if (state.levelOn) {
    window.addEventListener('deviceorientation', handleDeviceOrientation);
  } else {
    window.removeEventListener('deviceorientation', handleDeviceOrientation);
  }
}

// ===== イベントバインディング =====
function bindEvents() {
  el.btnStartCamera.addEventListener('click', () => {
    startCameraFlow().catch(() => {});
  });

  // 即保存 / 連続撮影モード切替
  el.btnAutoSave.addEventListener('click', () => {
    state.autoSaveSheet = !state.autoSaveSheet;
    updateAutoSaveButtonUI();
    showStatusPill(
      state.autoSaveSheet
        ? '撮影ごとにiOS「写真」保存メニューを開きます'
        : '連続無音撮影（あとでまとめて写真アプリ保存）'
    );
  });

  // トップバーのショートカット
  el.btnDrawerToggle.addEventListener('click', () => toggleDrawer());
  el.btnTopExposure.addEventListener('click', () => {
    if (!state.drawerOpen) toggleDrawer(true);
    openSubpanel('exposure');
  });
  el.btnTopFilter.addEventListener('click', () => {
    if (!state.drawerOpen) toggleDrawer(true);
    openSubpanel('filters');
  });

  // シャッターボタン
  el.btnShutter.addEventListener('click', handleShutterPress);

  // クイック保存トーストのボタン
  el.btnQuickSaveNow.addEventListener('click', async () => {
    el.quickSaveToast.classList.add('hidden');
    if (state.lastCapturedItem) {
      await saveItemsToPhotosFlow([state.lastCapturedItem]);
    }
  });

  // インカメラ / アウトカメラ切替
  el.btnFlipCamera.addEventListener('click', async () => {
    if (!state.ready || engine.isRecording) return;
    el.flipBlur.classList.add('active');
    try {
      const summary = await engine.flipCamera();
      renderLensSelector(summary);
      renderDetectedLensChips(summary);
      updatePreviewTransformAndFilter();
      el.aeAfBadge.classList.add('hidden');
      showStatusPill(engine.facingMode === 'user' ? '前面カメラ' : '背面カメラ');
    } catch {
      showStatusPill('カメラ切替に失敗しました');
    } finally {
      setTimeout(() => el.flipBlur.classList.remove('active'), 200);
    }
  });

  // モード切替（ビデオ / 写真 / ポートレート / スクエア）
  el.modeSelector.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (engine.isRecording) return;
      state.mode = btn.dataset.mode;
      el.modeSelector.querySelectorAll('.mode-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      el.btnShutter.classList.toggle('video-mode', state.mode === 'video');
      updateAspectFrame();
      updatePreviewTransformAndFilter();
      const modeNames = {
        video: 'ビデオモード（無音録画）',
        photo: '写真モード（無音）',
        portrait: 'ポートレート（背景ぼかし）',
        square: 'スクエア (1:1)'
      };
      showStatusPill(modeNames[state.mode] || '');
    });
  });

  // ドロワーツール類
  el.toolAspect.addEventListener('click', () => {
    const order = ['full', '4:3', '16:9', '1:1'];
    const idx = order.indexOf(state.aspectRatio);
    state.aspectRatio = order[(idx + 1) % order.length];
    if (state.mode === 'square') state.mode = 'photo';
    updateAspectFrame();
    showStatusPill(`アスペクト比 ${state.aspectRatio === 'full' ? 'フル' : state.aspectRatio}`);
  });

  el.toolTimer.addEventListener('click', () => {
    const order = [0, 3, 10];
    const idx = order.indexOf(state.timerSec);
    state.timerSec = order[(idx + 1) % order.length];
    el.toolTimerVal.textContent = state.timerSec === 0 ? 'オフ' : `${state.timerSec}秒`;
    el.toolTimer.classList.toggle('active', state.timerSec > 0);
    showStatusPill(state.timerSec === 0 ? 'タイマー オフ' : `タイマー ${state.timerSec}秒`);
  });

  el.toolExposure.addEventListener('click', () => openSubpanel('exposure'));
  el.toolFilter.addEventListener('click', () => openSubpanel('filters'));
  el.toolLenses.addEventListener('click', () => openSubpanel('lenses'));

  el.toolGrid.addEventListener('click', () => {
    state.gridOn = !state.gridOn;
    el.gridOverlay.classList.toggle('hidden', !state.gridOn);
    el.toolGrid.classList.toggle('active', state.gridOn);
  });

  el.toolLevel.addEventListener('click', toggleLevelTool);

  el.toolMirror.addEventListener('click', () => {
    state.mirrorFront = !state.mirrorFront;
    el.toolMirror.classList.toggle('active', state.mirrorFront);
    updatePreviewTransformAndFilter();
    showStatusPill(state.mirrorFront ? '前面カメラ鏡像 オン' : '前面カメラ鏡像 オフ');
  });

  // 露出スライダー
  el.exposureSlider.addEventListener('input', async (e) => {
    await applyExposure(Number(e.target.value));
  });
  el.btnExposureReset.addEventListener('click', async () => {
    await applyExposure(0);
  });

  // カメラ上部ズームバー（タッチ中は消さず、離した時に1回だけ物理レンズ切替）
  const holdZoomBar = () => showZoomWheel(false);
  const releaseZoomBar = () => showZoomWheel(true);
  el.zoomRangeSlider.addEventListener('pointerdown', holdZoomBar);
  el.zoomRangeSlider.addEventListener('touchstart', holdZoomBar, { passive: true });
  el.zoomRangeSlider.addEventListener('pointerup', releaseZoomBar);
  el.zoomRangeSlider.addEventListener('touchend', releaseZoomBar, { passive: true });
  el.zoomRangeSlider.addEventListener('input', (e) => {
    showZoomWheel(false);
    applyZoom(Number(e.target.value), false);
  });
  el.zoomRangeSlider.addEventListener('change', async (e) => {
    showZoomWheel(true);
    await applyZoom(Number(e.target.value), true);
  });

  // iPhoneのバックグラウンド復帰・画面ロック解除時の暗転を自動復旧
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.ready) {
      engine.ensureStreamAlive().then(() => updatePreviewTransformAndFilter()).catch(() => {});
    }
  });

  // ギャラリー操作
  el.btnGallery.addEventListener('click', () => openGalleryModal());
  el.btnGalleryClose.addEventListener('click', closeGalleryModal);
  el.btnViewerSave.addEventListener('click', async () => {
    const item = state.mediaList.find((m) => m.id === state.selectedMediaId);
    if (item) await saveItemsToPhotosFlow([item]);
  });
  el.btnViewerDownload.addEventListener('click', async () => {
    const item = state.mediaList.find((m) => m.id === state.selectedMediaId);
    if (item) {
      downloadBlobAsFile(item.blob, item.filename);
      await purgeMediaItems([item.id]);
      showStatusPill('保存してアプリから完全削除しました');
    }
  });
  el.btnViewerDelete.addEventListener('click', async () => {
    const id = state.selectedMediaId;
    if (!id) return;
    await purgeMediaItems([id]);
    showStatusPill('完全に削除しました');
  });
  el.btnGallerySaveAll.addEventListener('click', async () => {
    await saveItemsToPhotosFlow([...state.mediaList]);
  });
  el.btnGalleryClearAll.addEventListener('click', async () => {
    if (state.mediaList.length === 0) return;
    if (!confirm(`一時保存中の ${state.mediaList.length} 件をすべて完全に削除しますか？（元に戻せません）`)) {
      return;
    }
    await purgeAllMediaItems();
    showStatusPill('アプリ内データをすべて完全削除しました');
  });
  el.btnDismissHint.addEventListener('click', () => {
    el.iosHintBar.classList.add('hidden');
    localStorage.setItem('hideIosPhotoHint', '1');
  });

  // ファインダーのタッチ操作（ピンチズーム / タップフォーカス / 縦ドラッグ露出 / 長押しAE-AFロック）
  bindViewfinderGestures();
}

async function applyExposure(ev) {
  state.exposureEv = Math.max(-2.0, Math.min(2.0, ev));
  const res = await engine.setExposure(state.exposureEv);
  state.useSoftwareExposure = !res.usedHardware;

  const formatted = state.exposureEv > 0 ? `+${state.exposureEv.toFixed(1)}` : state.exposureEv.toFixed(1);
  el.exposureSlider.value = String(state.exposureEv);
  el.exposureValueLabel.textContent = formatted;
  el.toolExposureVal.textContent = formatted;
  el.btnTopExposure.classList.toggle('active', Math.abs(state.exposureEv) > 0.01);
  el.toolExposure.classList.toggle('active', Math.abs(state.exposureEv) > 0.01);

  // 太陽マークの位置も連動 (-36px 〜 +36px)
  const sunOffset = (-state.exposureEv / 2) * 36;
  el.focusSunIcon.style.transform = `translateY(${sunOffset.toFixed(1)}px)`;

  updatePreviewTransformAndFilter();
}

function bindViewfinderGestures() {
  let pinchStartDist = 0;
  let pinchStartZoom = 1.0;
  let isPinching = false;

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartEv = 0;
  let isDraggingExposure = false;
  let longPressTimer = null;
  let longPressFired = false;

  const getDist = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

  el.frame.addEventListener(
    'touchstart',
    (e) => {
      if (!state.ready) return;
      if (e.target.closest('.zoom-controls-wrap') || e.target.closest('.zoom-wheel') || e.target.closest('.permission-overlay')) return;

      if (e.touches.length === 2) {
        isPinching = true;
        clearTimeout(longPressTimer);
        pinchStartDist = getDist(e.touches[0], e.touches[1]);
        pinchStartZoom = engine.currentZoom;
        return;
      }

      if (e.touches.length === 1) {
        isPinching = false;
        isDraggingExposure = false;
        longPressFired = false;
        const t = e.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        touchStartEv = state.exposureEv;

        longPressTimer = setTimeout(() => {
          longPressFired = true;
          triggerFocusAtClientPoint(t.clientX, t.clientY, true);
        }, 600);
      }
    },
    { passive: true }
  );

  el.frame.addEventListener(
    'touchmove',
    (e) => {
      if (!state.ready) return;
      if (e.target.closest('.zoom-controls-wrap') || e.target.closest('.zoom-wheel')) return;

      if (e.touches.length === 2 && isPinching && pinchStartDist > 0) {
        e.preventDefault();
        const dist = getDist(e.touches[0], e.touches[1]);
        const ratio = dist / pinchStartDist;
        const nextZoom = Math.max(0.5, Math.min(10.0, pinchStartZoom * ratio));
        // ピンチ中はスムーズにズーム（物理レンズ切替の引っかかりを避け、終了時に最適レンズ判定）
        applyZoom(nextZoom, false);
        showZoomWheel();
        return;
      }

      if (e.touches.length === 1 && !isPinching) {
        const t = e.touches[0];
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;

        if (Math.hypot(dx, dy) > 12) {
          clearTimeout(longPressTimer);
        }

        // フォーカス枠表示中または縦ドラッグで露出補正
        if (Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx) * 1.4 && !el.focusReticle.classList.contains('hidden')) {
          isDraggingExposure = true;
          e.preventDefault();
          const deltaEv = (-dy / 110) * 2.0;
          applyExposure(touchStartEv + deltaEv);
          resetFocusReticleTimeout();
        }
      }
    },
    { passive: false }
  );

  el.frame.addEventListener('touchend', async (e) => {
    clearTimeout(longPressTimer);
    if (!state.ready) return;

    if (isPinching && e.touches.length < 2) {
      isPinching = false;
      // ピンチ終了時に現在の倍率に最適な物理レンズへ切り替え
      await applyZoom(engine.currentZoom, true);
      return;
    }

    if (!isDraggingExposure && !longPressFired && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      if (!e.target.closest('.zoom-controls-wrap') && !e.target.closest('.zoom-wheel') && !e.target.closest('.permission-overlay')) {
        if (Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY) < 12) {
          triggerFocusAtClientPoint(t.clientX, t.clientY, false);
        }
      }
    }
    isDraggingExposure = false;
  });

  // PCクリック用フォーカスフォールバック
  el.frame.addEventListener('click', (e) => {
    if (!state.ready || 'ontouchstart' in window) return;
    if (e.target.closest('.zoom-controls-wrap') || e.target.closest('.permission-overlay')) return;
    triggerFocusAtClientPoint(e.clientX, e.clientY, false);
  });
}

function triggerFocusAtClientPoint(clientX, clientY, lock) {
  const rect = el.frame.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

  el.focusReticle.style.left = `${x}px`;
  el.focusReticle.style.top = `${y}px`;
  el.focusReticle.classList.remove('hidden');

  // フォーカス枠アニメーションを再トリガー
  const box = el.focusReticle.querySelector('.focus-box');
  box.style.animation = 'none';
  void box.offsetWidth;
  box.style.animation = '';

  el.aeAfBadge.classList.toggle('hidden', !lock);
  engine.focusAt(x / rect.width, y / rect.height, lock);
  resetFocusReticleTimeout();
}

function resetFocusReticleTimeout() {
  clearTimeout(focusHideTimer);
  focusHideTimer = setTimeout(() => {
    if (!engine.aeAfLocked) {
      el.focusReticle.classList.add('hidden');
    }
  }, 3200);
}

// 起動
bootstrap();
