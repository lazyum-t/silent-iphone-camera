import { buildCssFilter } from './filters.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * iPhone純正カメラ準拠のマルチレンズ・無音撮影カメラエンジン
 * - 切替ロック＆世代番号管理でレースコンディション（暗転）を防止
 * - 物理レンズ切替失敗／フレーム未到着時は即座に前レンズへ自動復旧＋デジタルズーム継続
 * - iOSハードウェア解放待機と実フレーム到着検証により黒画面を根絶
 */
export class CameraEngine {
  constructor(videoEl, canvasEl) {
    this.videoEl = videoEl;
    this.canvasEl = canvasEl;
    this.stream = null;
    this.track = null;

    this.facingMode = 'environment'; // 'environment' | 'user'
    this.devices = []; // 検出されたすべての videoinput
    this.backLenses = {
      ultraWide: null, // 0.5x
      wide: null,      // 1x
      telephoto: null, // 2x / 3x / 5x
      multi: null,     // Triple / Dual Wide Camera
      allBack: []
    };
    this.frontDevice = null;
    this.activeDeviceId = null;
    this.activeLensType = 'wide'; // 'ultraWide' | 'wide' | 'telephoto' | 'multi' | 'front'

    // 切替失敗・暗転したデバイスIDをセッション中ブラックリスト化
    this.failedDeviceIds = new Set();

    // 排他制御・世代管理
    this._switchSeq = 0;
    this._activeStartCount = 0;
    this._switchingPromise = null;
    this._pendingZoomTarget = null;
    this._isRecovering = false;
    this.onBeforeLensSwitch = null;
    this.onAfterLensSwitch = null;

    // ズーム管理
    this.currentZoom = 1.0;        // ユーザー表示上の倍率 (0.5 〜 10.0)
    this.baseLensZoom = 1.0;       // 現在の物理レンズの基準倍率 (0.5 / 1.0 / 3.0)
    this.digitalZoomFactor = 1.0;  // CSS・クロップ用の追加デジタル倍率
    this.hwZoomCaps = null;        // { min, max, step }

    // 露出・フォーカス
    this.exposureEv = 0;
    this.hwExposureCaps = null;
    this.aeAfLocked = false;

    // 録画
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
  }

  /**
   * 初期カメラ起動＋端末の全物理レンズを検出
   */
  async init() {
    await this.startStream({ facingMode: 'environment' });
    await this.discoverDevices();

    const settings = this.track?.getSettings?.() || {};
    if (settings.deviceId) {
      this.activeDeviceId = settings.deviceId;
      this.activeLensType = this._inferLensTypeById(settings.deviceId);
      this.baseLensZoom = this._baseZoomForLensType(this.activeLensType);
      this.currentZoom = this.baseLensZoom === 0.5 ? 0.5 : 1.0;
    }

    return this.getLensSummary();
  }

  /**
   * 端末のカメラ一覧を解析し、超広角(0.5x)・広角(1x)・望遠(2x/3x)を分類
   */
  async discoverDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = all.filter((d) => d.kind === 'videoinput');
    this.devices = videoInputs;

    const back = [];
    let front = null;
    let ultraWide = null;
    let wide = null;
    let telephoto = null;
    let multi = null;

    for (const dev of videoInputs) {
      const label = (dev.label || '').toLowerCase();
      const isFront =
        label.includes('front') ||
        label.includes('前面') ||
        label.includes('facetime') ||
        label.includes('truedepth') ||
        label.includes('user');

      if (isFront) {
        if (!front) front = dev;
        continue;
      }

      back.push(dev);

      if (label.includes('ultra wide') || label.includes('ultrawide') || label.includes('超広角') || label.includes('0.5')) {
        if (!ultraWide) ultraWide = dev;
      } else if (label.includes('telephoto') || label.includes('望遠')) {
        if (!telephoto) telephoto = dev;
      } else if (label.includes('triple') || label.includes('dual wide') || label.includes('デュアル') || label.includes('トリプル')) {
        if (!multi) multi = dev;
      } else if (
        label.includes('back camera') ||
        label.includes('wide') ||
        label.includes('背面カメラ') ||
        label.includes('広角') ||
        label.includes('camera2 0')
      ) {
        if (!wide) wide = dev;
      }
    }

    if (!wide) {
      wide = multi || back.find((d) => d !== ultraWide && d !== telephoto) || back[0] || null;
    }

    this.backLenses = {
      ultraWide,
      wide,
      telephoto,
      multi,
      allBack: back
    };
    this.frontDevice = front;
  }

  getLensSummary() {
    const hasUltraWide = Boolean(
      (this.backLenses.ultraWide && !this.failedDeviceIds.has(this.backLenses.ultraWide.deviceId)) ||
      (this.hwZoomCaps && this.hwZoomCaps.min <= 0.6)
    );
    const hasTelephoto = Boolean(
      this.backLenses.telephoto && !this.failedDeviceIds.has(this.backLenses.telephoto.deviceId)
    );

    const presets = [];
    if (this.facingMode === 'environment') {
      if (hasUltraWide) {
        presets.push({ zoom: 0.5, label: '.5', activeLabel: '0.5×', lensType: 'ultraWide', physical: true });
      }
      presets.push({ zoom: 1.0, label: '1', activeLabel: '1×', lensType: 'wide', physical: true });
      presets.push({ zoom: 2.0, label: '2', activeLabel: '2×', lensType: hasTelephoto ? 'telephoto' : 'wide', physical: hasTelephoto });
      presets.push({ zoom: 3.0, label: '3', activeLabel: '3×', lensType: hasTelephoto ? 'telephoto' : 'wide', physical: hasTelephoto });
    } else {
      presets.push({ zoom: 1.0, label: '1', activeLabel: '1×', lensType: 'front', physical: true });
      presets.push({ zoom: 1.3, label: '1.3', activeLabel: '1.3×', lensType: 'front', physical: false });
    }

    return {
      presets,
      hasUltraWide,
      hasTelephoto,
      devices: this.devices,
      activeDeviceId: this.activeDeviceId,
      activeLensType: this.activeLensType
    };
  }

  /**
   * 映像が実際に表示開始（readyState >= 2 かつ videoWidth > 0）されるまで待機
   */
  _waitForVideoFrame(timeoutMs = 3500) {
    const video = this.videoEl;
    return new Promise((resolve, reject) => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) {
        requestAnimationFrame(() => resolve());
        return;
      }

      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('playing', onReady);
        video.removeEventListener('canplay', onReady);
      };

      const finishOk = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (typeof video.requestVideoFrameCallback === 'function') {
          let frameDone = false;
          const fallback = setTimeout(() => {
            if (!frameDone) {
              frameDone = true;
              resolve();
            }
          }, 250);
          video.requestVideoFrameCallback(() => {
            if (!frameDone) {
              frameDone = true;
              clearTimeout(fallback);
              resolve();
            }
          });
        } else {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }
      };

      const onReady = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          finishOk();
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          resolve();
        } else {
          reject(new Error('カメラ映像の受信がタイムアウトしました'));
        }
      }, timeoutMs);

      video.addEventListener('loadeddata', onReady);
      video.addEventListener('playing', onReady);
      video.addEventListener('canplay', onReady);
    });
  }

  /**
   * カメラストリームを安全に開始する
   * - 切替前にフリーズオーバーレイ通知
   * - 旧トラック停止後、iOSハードウェア解放のため短時間待機
   * - 新ストリームのフレーム到達を確認し、失敗時は前レンズまたは標準カメラへ自動復旧
   */
  async startStream({ facingMode = this.facingMode, deviceId = null, includeAudio = false, isRecovery = false } = {}) {
    const seq = ++this._switchSeq;
    this._activeStartCount += 1;
    const prevDeviceId = this.activeDeviceId;
    const prevFacingMode = this.facingMode;
    const prevLensType = this.activeLensType;
    const prevBaseZoom = this.baseLensZoom;
    const hadActiveStream = Boolean(this.stream);

    if (hadActiveStream && !isRecovery && typeof this.onBeforeLensSwitch === 'function') {
      try {
        this.onBeforeLensSwitch();
      } catch {
        // ignore
      }
    }

    // iOS Safariは同時に複数背面カメラを開けないため確実に停止し、ハードウェア解放を待つ
    if (hadActiveStream) {
      this.stopStream();
      await sleep(90);
    }

    if (seq !== this._switchSeq) {
      this._activeStartCount = Math.max(0, this._activeStartCount - 1);
      if (this._activeStartCount === 0 && typeof this.onAfterLensSwitch === 'function') {
        try { this.onAfterLensSwitch(); } catch {}
      }
      return null;
    }

    const requestMedia = async (useHighRes) => {
      const videoConstraints = useHighRes
        ? { width: { ideal: 4032 }, height: { ideal: 3024 }, frameRate: { ideal: 30 } }
        : {};

      if (deviceId) {
        videoConstraints.deviceId = { exact: deviceId };
      } else {
        videoConstraints.facingMode = { ideal: facingMode };
      }

      return navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: includeAudio
      });
    };

    let stream = null;
    try {
      try {
        stream = await requestMedia(true);
      } catch {
        // 望遠・超広角レンズで高解像度/frameRate指定が通らない機種向けフォールバック
        stream = await requestMedia(false);
      }

      // 待機中に別の新しい切替が走っていたらこのストリームは破棄
      if (seq !== this._switchSeq) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }

      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') {
        throw new Error('有効なカメラ映像トラックを取得できませんでした');
      }

      this.stream = stream;
      this.track = track;
      this.facingMode = facingMode;

      const settings = track.getSettings?.() || {};
      if (settings.deviceId) {
        this.activeDeviceId = settings.deviceId;
      }

      const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
      this.hwZoomCaps = caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null;
      this.hwExposureCaps = caps.exposureCompensation
        ? { min: caps.exposureCompensation.min, max: caps.exposureCompensation.max, step: caps.exposureCompensation.step || 0.1 }
        : null;

      this.videoEl.srcObject = stream;
      this.videoEl.muted = true;
      await this.videoEl.play().catch(() => {});
      await this._waitForVideoFrame(3500);

      if (seq !== this._switchSeq) {
        return null;
      }

      // 予期せぬトラック終了（OS割り込み等）の自動復旧フック
      track.addEventListener('ended', () => {
        if (this.track === track && !this._isRecovering) {
          this.ensureStreamAlive().catch(() => {});
        }
      });

      if (Math.abs(this.exposureEv) > 0.01) {
        await this.setExposure(this.exposureEv);
      }

      return settings;
    } catch (err) {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
      this.stopStream();

      // 特定 deviceId で暗転・失敗した場合はブラックリスト化し、前の正常カメラへ自動復旧する
      if (!isRecovery && hadActiveStream) {
        if (deviceId) {
          this.failedDeviceIds.add(deviceId);
        }
        this.activeLensType = prevLensType;
        this.baseLensZoom = prevBaseZoom;
        this._isRecovering = true;
        try {
          const fallbackDevice =
            prevDeviceId && prevDeviceId !== deviceId && !this.failedDeviceIds.has(prevDeviceId)
              ? prevDeviceId
              : null;
          await this.startStream({
            facingMode: prevFacingMode,
            deviceId: fallbackDevice,
            includeAudio,
            isRecovery: true
          });
        } catch {
          // 最後の手段：deviceId 制約なしの標準背面カメラへ復旧
          await this.startStream({
            facingMode: prevFacingMode,
            deviceId: null,
            includeAudio,
            isRecovery: true
          }).catch(() => {});
        } finally {
          this._isRecovering = false;
        }
      }

      throw err;
    } finally {
      this._activeStartCount = Math.max(0, this._activeStartCount - 1);
      if (this._activeStartCount === 0 && typeof this.onAfterLensSwitch === 'function') {
        try {
          this.onAfterLensSwitch();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 画面復帰時や予期せぬ停止時にストリームが生きているか確認し、死んでいれば自動復旧
   */
  async ensureStreamAlive() {
    if (this._switchingPromise) return;
    const alive =
      this.stream &&
      this.track &&
      this.track.readyState === 'live' &&
      this.videoEl.srcObject === this.stream &&
      this.videoEl.videoWidth > 0;

    if (alive) {
      if (this.videoEl.paused) {
        await this.videoEl.play().catch(() => {});
      }
      return;
    }

    this._isRecovering = true;
    try {
      const targetId =
        this.activeDeviceId && !this.failedDeviceIds.has(this.activeDeviceId)
          ? this.activeDeviceId
          : null;
      await this.startStream({
        facingMode: this.facingMode,
        deviceId: targetId,
        isRecovery: true
      });
    } finally {
      this._isRecovering = false;
    }
  }

  stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
    }
  }

  /**
   * 物理デバイスIDを指定してレンズ切替（排他制御付き）
   */
  async selectDeviceById(deviceId) {
    const dev = this.devices.find((d) => d.deviceId === deviceId);
    if (!dev) return null;

    if (this._switchingPromise) {
      await this._switchingPromise.catch(() => {});
    }

    const label = (dev.label || '').toLowerCase();
    const isFront = label.includes('front') || label.includes('前面') || label.includes('truedepth');
    const nextFacing = isFront ? 'user' : 'environment';
    const nextType = this._inferLensTypeById(deviceId);
    const nextBase = this._baseZoomForLensType(nextType);

    // ユーザーが明示的に選んだ場合はブラックリストから一度外して再試行
    this.failedDeviceIds.delete(deviceId);

    const job = (async () => {
      this.activeLensType = nextType;
      this.baseLensZoom = nextBase;
      this.currentZoom = nextBase;
      this.digitalZoomFactor = 1.0;
      await this.startStream({ facingMode: nextFacing, deviceId });
      return {
        label: this.getFriendlyLensName(dev),
        zoom: this.currentZoom
      };
    })();

    this._switchingPromise = job;
    try {
      return await job;
    } finally {
      if (this._switchingPromise === job) {
        this._switchingPromise = null;
      }
    }
  }

  /**
   * 現在の単一カメラストリームのハードウェアzoomだけで目標倍率をカバーできるか判定
   * （Triple / Dual Wide 仮想カメラが使える場合はストリーム再起動不要で一切暗転しない）
   */
  _canHandleZoomWithCurrentHardware(targetZoom) {
    if (!this.track || !this.hwZoomCaps) return false;
    const { min, max } = this.hwZoomCaps;
    if (targetZoom < 0.95) {
      return min <= 0.6 && targetZoom >= min && targetZoom <= max;
    }
    return targetZoom >= min && targetZoom <= max && (this.baseLensZoom === 1.0 || this.activeLensType === 'multi');
  }

  /**
   * 倍率指定でレンズ切替＆ズーム（0.5x〜10.0x）
   * 物理切替が同時多重発火しないよう排他制御し、切替失敗時もデジタルズームで暗転ゼロを維持する
   */
  async setZoom(targetZoom, { allowLensSwitch = true } = {}) {
    const hasUltraOption =
      this.facingMode === 'environment' &&
      ((this.backLenses.ultraWide && !this.failedDeviceIds.has(this.backLenses.ultraWide.deviceId)) ||
        (this.hwZoomCaps && this.hwZoomCaps.min <= 0.6));
    const minZoom = hasUltraOption ? 0.5 : 1.0;
    const clamped = Math.max(minZoom, Math.min(10.0, Number(targetZoom)));

    // すでに物理切替が進行中の場合は、即座にデジタルズームだけ更新して最新の目標倍率を予約
    if (this._switchingPromise) {
      if (allowLensSwitch) {
        this._pendingZoomTarget = clamped;
      }
      this.currentZoom = clamped;
      this.digitalZoomFactor = Math.max(1.0, clamped / this.baseLensZoom);
      return {
        zoom: this.currentZoom,
        digitalZoomFactor: this.digitalZoomFactor,
        lensType: this.activeLensType
      };
    }

    // 物理レンズ切替が必要か判定
    let targetDevice = null;
    let targetLensType = this.activeLensType;
    let targetBaseZoom = this.baseLensZoom;

    if (
      this.facingMode === 'environment' &&
      allowLensSwitch &&
      !this._canHandleZoomWithCurrentHardware(clamped)
    ) {
      const uw = this.backLenses.ultraWide;
      const wide = this.backLenses.wide;
      const tele = this.backLenses.telephoto;

      if (clamped < 0.95 && uw && !this.failedDeviceIds.has(uw.deviceId) && this.activeDeviceId !== uw.deviceId) {
        targetDevice = uw;
        targetLensType = 'ultraWide';
        targetBaseZoom = 0.5;
      } else if (clamped >= 2.95 && tele && !this.failedDeviceIds.has(tele.deviceId) && this.activeDeviceId !== tele.deviceId) {
        targetDevice = tele;
        targetLensType = 'telephoto';
        targetBaseZoom = 3.0;
      } else if (
        clamped >= 0.95 &&
        (clamped < 2.95 || !tele || this.failedDeviceIds.has(tele.deviceId)) &&
        wide &&
        !this.failedDeviceIds.has(wide.deviceId) &&
        this.activeDeviceId !== wide.deviceId
      ) {
        targetDevice = wide;
        targetLensType = 'wide';
        targetBaseZoom = 1.0;
      }
    }

    if (targetDevice) {
      const job = (async () => {
        try {
          this.activeLensType = targetLensType;
          this.baseLensZoom = targetBaseZoom;
          await this.startStream({ facingMode: 'environment', deviceId: targetDevice.deviceId });
        } catch {
          // startStream内で前レンズへ自動復旧済み。デジタルズームで継続するので暗転しない
        }
      })();

      this._switchingPromise = job;
      try {
        await job;
      } finally {
        if (this._switchingPromise === job) {
          this._switchingPromise = null;
        }
      }

      // 切替中に新しい倍率指定が来ていたら最後に1回だけ反映
      if (this._pendingZoomTarget !== null) {
        const nextZ = this._pendingZoomTarget;
        this._pendingZoomTarget = null;
        return this.setZoom(nextZ, { allowLensSwitch: true });
      }
    }

    this.currentZoom = clamped;

    // 現在の物理レンズ基準に対する相対ズーム倍率
    const relativeZoom = Math.max(1.0, clamped / this.baseLensZoom);

    // ハードウェアzoomが安全に適用できる範囲なら適用、それ以外は滑らかなデジタルズーム
    let appliedHw = false;
    if (this.track && this.track.readyState === 'live' && this.hwZoomCaps) {
      const desiredHw = this.baseLensZoom === 1.0 && this.hwZoomCaps.min < 1.0 ? clamped : relativeZoom;
      if (desiredHw >= this.hwZoomCaps.min && desiredHw <= this.hwZoomCaps.max) {
        try {
          await this.track.applyConstraints({ advanced: [{ zoom: desiredHw }] });
          this.digitalZoomFactor = 1.0;
          appliedHw = true;
        } catch {
          appliedHw = false;
        }
      }
    }

    if (!appliedHw) {
      this.digitalZoomFactor = relativeZoom;
    }

    return {
      zoom: this.currentZoom,
      digitalZoomFactor: this.digitalZoomFactor,
      lensType: this.activeLensType
    };
  }

  /**
   * 前面・背面カメラの切替（排他制御付き）
   */
  async flipCamera() {
    if (this._switchingPromise) {
      await this._switchingPromise.catch(() => {});
    }

    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    let targetDeviceId = null;

    if (nextFacing === 'user' && this.frontDevice && !this.failedDeviceIds.has(this.frontDevice.deviceId)) {
      targetDeviceId = this.frontDevice.deviceId;
      this.activeLensType = 'front';
      this.baseLensZoom = 1.0;
    } else if (nextFacing === 'environment' && this.backLenses.wide && !this.failedDeviceIds.has(this.backLenses.wide.deviceId)) {
      targetDeviceId = this.backLenses.wide.deviceId;
      this.activeLensType = 'wide';
      this.baseLensZoom = 1.0;
    }

    this.currentZoom = 1.0;
    this.digitalZoomFactor = 1.0;
    this.aeAfLocked = false;
    this._pendingZoomTarget = null;

    const job = this.startStream({ facingMode: nextFacing, deviceId: targetDeviceId });
    this._switchingPromise = job;
    try {
      await job;
    } finally {
      if (this._switchingPromise === job) {
        this._switchingPromise = null;
      }
    }
    return this.getLensSummary();
  }

  /**
   * 露出補正 (-2.0 〜 +2.0 EV)
   */
  async setExposure(ev) {
    this.exposureEv = Math.max(-2.0, Math.min(2.0, Number(ev)));
    let usedHw = false;
    if (this.track && this.track.readyState === 'live' && this.hwExposureCaps) {
      const clamped = Math.max(this.hwExposureCaps.min, Math.min(this.hwExposureCaps.max, this.exposureEv));
      try {
        await this.track.applyConstraints({ advanced: [{ exposureCompensation: clamped }] });
        usedHw = true;
      } catch {
        usedHw = false;
      }
    }
    return { exposureEv: this.exposureEv, usedHardware: usedHw };
  }

  /**
   * タップフォーカス / AE-AFロック
   */
  async focusAt(normX, normY, lock = false) {
    this.aeAfLocked = lock;
    if (!this.track || this.track.readyState !== 'live') return;
    const caps = typeof this.track.getCapabilities === 'function' ? this.track.getCapabilities() : {};
    const advanced = {};

    if (caps.focusMode) {
      if (lock && caps.focusMode.includes('manual')) {
        advanced.focusMode = 'manual';
      } else if (caps.focusMode.includes('single-shot')) {
        advanced.focusMode = 'single-shot';
      } else if (caps.focusMode.includes('continuous')) {
        advanced.focusMode = 'continuous';
      }
    }

    if (caps.exposureMode) {
      if (lock && caps.exposureMode.includes('manual')) {
        advanced.exposureMode = 'manual';
      } else if (caps.exposureMode.includes('continuous')) {
        advanced.exposureMode = 'continuous';
      }
    }

    if (caps.pointsOfInterest) {
      advanced.pointsOfInterest = [{ x: normX, y: normY }];
    }

    if (Object.keys(advanced).length > 0) {
      try {
        await this.track.applyConstraints({ advanced: [advanced] });
      } catch {
        // 未対応パラメータは無視
      }
    }
  }

  /**
   * 完全無音で高解像度の静止画をキャプチャする
   */
  captureSilentPhoto({
    aspectRatio = 'full',
    frameAspect = null,
    filterId = 'original',
    mirrorFront = true,
    portraitMode = false,
    useSoftwareExposure = true
  } = {}) {
    return new Promise((resolve, reject) => {
      const video = this.videoEl;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        reject(new Error('カメラ映像が準備できていません'));
        return;
      }

      const isVideoPortrait = vh >= vw;
      let targetRatio;
      if (aspectRatio === 'full' && frameAspect && frameAspect > 0) {
        targetRatio = frameAspect;
      } else if (aspectRatio === '1:1') {
        targetRatio = 1;
      } else if (aspectRatio === '16:9') {
        targetRatio = isVideoPortrait ? 9 / 16 : 16 / 9;
      } else {
        targetRatio = isVideoPortrait ? 3 / 4 : 4 / 3;
      }

      const videoRatio = vw / vh;
      let cropW = vw;
      let cropH = vh;
      if (videoRatio > targetRatio) {
        cropW = vh * targetRatio;
      } else {
        cropH = vw / targetRatio;
      }

      const z = Math.max(1.0, this.digitalZoomFactor);
      const srcW = cropW / z;
      const srcH = cropH / z;
      const srcX = (vw - srcW) / 2;
      const srcY = (vh - srcH) / 2;

      const outW = Math.round(cropW);
      const outH = Math.round(cropH);

      const canvas = this.canvasEl;
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: false });

      ctx.save();
      const cssFilter = buildCssFilter(filterId, this.exposureEv, useSoftwareExposure);
      if (cssFilter !== 'none') {
        ctx.filter = cssFilter;
      }

      const shouldMirror = this.facingMode === 'user' && mirrorFront;
      if (shouldMirror) {
        ctx.translate(outW, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
      ctx.restore();

      if (portraitMode) {
        this._applyPortraitVignetteBlur(ctx, outW, outH);
      }

      const meta = {
        width: outW,
        height: outH,
        zoom: this.currentZoom,
        lensName: this.getActiveLensLabel(),
        aspectRatio,
        filterId
      };

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('画像の生成に失敗しました'));
            return;
          }
          resolve({ blob, meta });
        },
        'image/jpeg',
        0.95
      );
    });
  }

  _applyPortraitVignetteBlur(ctx, w, h) {
    try {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      octx.filter = `blur(${Math.max(8, Math.round(Math.min(w, h) * 0.012))}px)`;
      octx.drawImage(this.canvasEl, 0, 0);

      octx.globalCompositeOperation = 'destination-out';
      const grad = octx.createRadialGradient(
        w * 0.5,
        h * 0.46,
        Math.min(w, h) * 0.18,
        w * 0.5,
        h * 0.46,
        Math.max(w, h) * 0.54
      );
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.62, 'rgba(0,0,0,0.92)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      octx.fillStyle = grad;
      octx.fillRect(0, 0, w, h);

      ctx.drawImage(off, 0, 0);
    } catch {
      // ignore
    }
  }

  async startVideoRecording() {
    if (!this.stream || this.isRecording) return false;

    const mimeCandidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    let selectedMime = '';
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      selectedMime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    }

    this.recordedChunks = [];
    const options = selectedMime ? { mimeType: selectedMime } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.start(250);
    this.isRecording = true;
    return true;
  }

  stopVideoRecording() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording) {
        resolve(null);
        return;
      }

      const recorder = this.mediaRecorder;
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'video/mp4';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        this.recordedChunks = [];
        this.isRecording = false;
        this.mediaRecorder = null;
        resolve({
          blob,
          mimeType,
          meta: {
            width: this.videoEl.videoWidth,
            height: this.videoEl.videoHeight,
            zoom: this.currentZoom,
            lensName: this.getActiveLensLabel()
          }
        });
      };
      recorder.onerror = (e) => {
        this.isRecording = false;
        reject(e.error || new Error('録画の停止に失敗しました'));
      };
      recorder.stop();
    });
  }

  getActiveLensLabel() {
    if (this.facingMode === 'user') return '前面カメラ';
    if (this.activeLensType === 'ultraWide') return '超広角 (0.5×)';
    if (this.activeLensType === 'telephoto') return '望遠レンズ';
    return '広角 (1×)';
  }

  getFriendlyLensName(dev) {
    const raw = (dev.label || '').trim();
    const low = raw.toLowerCase();
    if (!raw) return 'カメラ';
    if (low.includes('ultra wide') || low.includes('超広角')) return '背面 超広角 (0.5×)';
    if (low.includes('telephoto') || low.includes('望遠')) return '背面 望遠';
    if (low.includes('triple') || low.includes('トリプル')) return '背面 トリプルカメラ';
    if (low.includes('dual wide') || low.includes('デュアル')) return '背面 デュアル広角';
    if (low.includes('front') || low.includes('前面') || low.includes('truedepth')) return '前面カメラ';
    if (low.includes('back') || low.includes('背面')) return '背面 広角 (1×)';
    return raw;
  }

  _inferLensTypeById(deviceId) {
    if (this.backLenses.ultraWide?.deviceId === deviceId) return 'ultraWide';
    if (this.backLenses.telephoto?.deviceId === deviceId) return 'telephoto';
    if (this.backLenses.multi?.deviceId === deviceId) return 'multi';
    if (this.frontDevice?.deviceId === deviceId) return 'front';
    return 'wide';
  }

  _baseZoomForLensType(type) {
    if (type === 'ultraWide') return 0.5;
    if (type === 'telephoto') return 3.0;
    return 1.0;
  }
}
