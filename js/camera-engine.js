import { buildCssFilter } from './filters.js';

/**
 * iPhone純正カメラ準拠のマルチレンズ・無音撮影カメラエンジン
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
    this.activeLensType = 'wide'; // 'ultraWide' | 'wide' | 'telephoto' | 'front'

    // ズーム管理
    this.currentZoom = 1.0;        // ユーザー表示上の倍率 (0.5 〜 10.0)
    this.baseLensZoom = 1.0;       // 現在の物理レンズの基準倍率 (0.5 / 1.0 / 2.0 / 3.0)
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

    // 背面メイン（1x）や超広角・望遠が見つかった場合、現在のアクティブデバイスを記録
    const settings = this.track?.getSettings?.() || {};
    if (settings.deviceId) {
      this.activeDeviceId = settings.deviceId;
      this.activeLensType = this._inferLensTypeById(settings.deviceId);
      this.baseLensZoom = this._baseZoomForLensType(this.activeLensType);
      this.currentZoom = this.baseLensZoom;
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

      // 背面カメラ候補
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

    // 広角カメラが未割り当てなら背面リストの先頭かマルチカメラを割り当て
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
    const hasUltraWide = Boolean(this.backLenses.ultraWide);
    const hasTelephoto = Boolean(this.backLenses.telephoto);
    // ユーザー向け倍率プリセット（iPhone純正と同じ 0.5, 1, 2, 3）
    const presets = [];
    if (this.facingMode === 'environment') {
      if (hasUltraWide) {
        presets.push({ zoom: 0.5, label: '.5', activeLabel: '0.5×', lensType: 'ultraWide', physical: true });
      } else {
        // 物理超広角が取れない機種でもUIに表示して案内／切替可能にする場合：
        // ハードウェアズームが0.5対応かチェック
        if (this.hwZoomCaps && this.hwZoomCaps.min <= 0.6) {
          presets.push({ zoom: 0.5, label: '.5', activeLabel: '0.5×', lensType: 'multi', physical: true });
        }
      }
      presets.push({ zoom: 1.0, label: '1', activeLabel: '1×', lensType: 'wide', physical: true });
      presets.push({ zoom: 2.0, label: '2', activeLabel: '2×', lensType: hasTelephoto ? 'telephoto' : 'wide', physical: hasTelephoto });
      presets.push({ zoom: 3.0, label: '3', activeLabel: '3×', lensType: hasTelephoto ? 'telephoto' : 'wide', physical: hasTelephoto });
    } else {
      // インカメラ（純正と同じ広角寄り・標準切替風）
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
   * カメラストリームを開始する（常に音声トラックなしで完全無音・カメラ専用）
   */
  async startStream({ facingMode = this.facingMode, deviceId = null, includeAudio = false } = {}) {
    this.stopStream();

    const videoConstraints = {
      width: { ideal: 4032 },
      height: { ideal: 3024 },
      frameRate: { ideal: 30 }
    };

    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = { ideal: facingMode };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: includeAudio
      });
    } catch (err) {
      // 高解像度指定で失敗する端末向けフォールバック
      const fallbackVideo = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode };
      stream = await navigator.mediaDevices.getUserMedia({
        video: fallbackVideo,
        audio: includeAudio
      });
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.facingMode = facingMode;

    const settings = this.track.getSettings?.() || {};
    if (settings.deviceId) {
      this.activeDeviceId = settings.deviceId;
    }

    // ハードウェア機能（zoom / exposureCompensation）を検査
    const caps = typeof this.track.getCapabilities === 'function' ? this.track.getCapabilities() : {};
    this.hwZoomCaps = caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null;
    this.hwExposureCaps = caps.exposureCompensation
      ? { min: caps.exposureCompensation.min, max: caps.exposureCompensation.max, step: caps.exposureCompensation.step || 0.1 }
      : null;

    this.videoEl.srcObject = stream;
    this.videoEl.muted = true; // 常にミュートでハウリング・音漏れ防止
    await this.videoEl.play().catch(() => {});

    // 露出を再適用
    if (Math.abs(this.exposureEv) > 0.01) {
      await this.setExposure(this.exposureEv);
    }

    return settings;
  }

  stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
    }
  }

  /**
   * 物理デバイスIDを指定してレンズ切替
   */
  async selectDeviceById(deviceId) {
    const dev = this.devices.find((d) => d.deviceId === deviceId);
    if (!dev) return;

    const label = (dev.label || '').toLowerCase();
    const isFront = label.includes('front') || label.includes('前面') || label.includes('truedepth');
    this.facingMode = isFront ? 'user' : 'environment';
    this.activeLensType = this._inferLensTypeById(deviceId);
    this.baseLensZoom = this._baseZoomForLensType(this.activeLensType);
    this.currentZoom = this.baseLensZoom;
    this.digitalZoomFactor = 1.0;

    await this.startStream({ facingMode: this.facingMode, deviceId });
    return {
      label: this.getFriendlyLensName(dev),
      zoom: this.currentZoom
    };
  }

  /**
   * 倍率指定でレンズ切替＆ズーム（0.5x〜10.0x）
   * 必要に応じて超広角(0.5x) / 広角(1x) / 望遠(3x)の物理レンズへ自動切替する
   */
  async setZoom(targetZoom, { allowLensSwitch = true } = {}) {
    const minZoom = this.facingMode === 'environment' && (this.backLenses.ultraWide || (this.hwZoomCaps && this.hwZoomCaps.min <= 0.6))
      ? 0.5
      : 1.0;
    const clamped = Math.max(minZoom, Math.min(10.0, Number(targetZoom)));

    if (this.facingMode === 'environment' && allowLensSwitch) {
      // 超広角へ切替 (0.5x 〜 0.94x)
      if (clamped < 0.95 && this.backLenses.ultraWide && this.activeDeviceId !== this.backLenses.ultraWide.deviceId) {
        this.activeLensType = 'ultraWide';
        this.baseLensZoom = 0.5;
        await this.startStream({ facingMode: 'environment', deviceId: this.backLenses.ultraWide.deviceId });
      }
      // 望遠へ切替 (2.95x 以上 & 望遠レンズがある場合)
      else if (clamped >= 2.95 && this.backLenses.telephoto && this.activeDeviceId !== this.backLenses.telephoto.deviceId) {
        this.activeLensType = 'telephoto';
        this.baseLensZoom = 3.0;
        await this.startStream({ facingMode: 'environment', deviceId: this.backLenses.telephoto.deviceId });
      }
      // 広角(1x)へ復帰 (0.95x 〜 2.94x、または望遠なし時)
      else if (
        clamped >= 0.95 &&
        (clamped < 2.95 || !this.backLenses.telephoto) &&
        this.backLenses.wide &&
        this.activeDeviceId !== this.backLenses.wide.deviceId
      ) {
        this.activeLensType = 'wide';
        this.baseLensZoom = 1.0;
        await this.startStream({ facingMode: 'environment', deviceId: this.backLenses.wide.deviceId });
      }
    }

    this.currentZoom = clamped;

    // 現在の物理レンズ基準に対する相対ズーム倍率
    const relativeZoom = Math.max(1.0, clamped / this.baseLensZoom);

    // ハードウェアzoomが使える場合は優先適用
    let appliedHw = false;
    if (this.track && this.hwZoomCaps) {
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
   * 前面・背面カメラの切替
   */
  async flipCamera() {
    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    let targetDeviceId = null;

    if (nextFacing === 'user' && this.frontDevice) {
      targetDeviceId = this.frontDevice.deviceId;
      this.activeLensType = 'front';
      this.baseLensZoom = 1.0;
    } else if (nextFacing === 'environment' && this.backLenses.wide) {
      targetDeviceId = this.backLenses.wide.deviceId;
      this.activeLensType = 'wide';
      this.baseLensZoom = 1.0;
    }

    this.currentZoom = 1.0;
    this.digitalZoomFactor = 1.0;
    this.aeAfLocked = false;

    await this.startStream({ facingMode: nextFacing, deviceId: targetDeviceId });
    return this.getLensSummary();
  }

  /**
   * 露出補正 (-2.0 〜 +2.0 EV)
   */
  async setExposure(ev) {
    this.exposureEv = Math.max(-2.0, Math.min(2.0, Number(ev)));
    let usedHw = false;
    if (this.track && this.hwExposureCaps) {
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
    if (!this.track) return;
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
   * プレビューの表示範囲（アスペクト比・デジタルズーム・鏡像・フィルター・ポートレートぼかし）と一致させて書き出す
   */
  captureSilentPhoto({
    aspectRatio = '4:3',
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

      // ターゲット縦横比（ポートレート/縦向き基準、横向き映像にも自動対応）
      const isVideoPortrait = vh >= vw;
      let targetRatio;
      if (aspectRatio === '1:1') {
        targetRatio = 1;
      } else if (aspectRatio === '16:9') {
        targetRatio = isVideoPortrait ? 9 / 16 : 16 / 9;
      } else {
        targetRatio = isVideoPortrait ? 3 / 4 : 4 / 3;
      }

      // 1. アスペクト比クロップ領域を計算
      const videoRatio = vw / vh;
      let cropW = vw;
      let cropH = vh;
      if (videoRatio > targetRatio) {
        cropW = vh * targetRatio;
      } else {
        cropH = vw / targetRatio;
      }

      // 2. デジタルズーム倍率をクロップに反映
      const z = Math.max(1.0, this.digitalZoomFactor);
      const srcW = cropW / z;
      const srcH = cropH / z;
      const srcX = (vw - srcW) / 2;
      const srcY = (vh - srcH) / 2;

      // 出力サイズ（最大センサー解像度を維持、過度なアップスケールはしない）
      const outW = Math.round(cropW);
      const outH = Math.round(cropH);

      const canvas = this.canvasEl;
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d', { alpha: false });

      ctx.save();

      // フィルター＋ソフトウェア露出
      const cssFilter = buildCssFilter(filterId, this.exposureEv, useSoftwareExposure);
      if (cssFilter !== 'none') {
        ctx.filter = cssFilter;
      }

      // インカメラ鏡像設定
      const shouldMirror = this.facingMode === 'user' && mirrorFront;
      if (shouldMirror) {
        ctx.translate(outW, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, outW, outH);
      ctx.restore();

      // ポートレートモード：周辺ソフトぼかしを自然に合成
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

  /**
   * ポートレートモード用の周辺ソフトフォーカス効果
   */
  _applyPortraitVignetteBlur(ctx, w, h) {
    try {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      octx.filter = `blur(${Math.max(8, Math.round(Math.min(w, h) * 0.012))}px)`;
      octx.drawImage(this.canvasEl, 0, 0);

      // 中央楕円をくり抜いたマスクを作成して背景側だけぼかしを重ねる
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
      // ぼかし非対応環境ではスキップ
    }
  }

  /**
   * ビデオ録画開始（シャッター音・開始音なし）
   */
  async startVideoRecording() {
    if (!this.stream || this.isRecording) return false;

    // 可能な限りiOS写真アプリ互換の高い video/mp4 を優先
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

  /**
   * ビデオ録画停止して Blob を返す
   */
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
    if (this.frontDevice?.deviceId === deviceId) return 'front';
    return 'wide';
  }

  _baseZoomForLensType(type) {
    if (type === 'ultraWide') return 0.5;
    if (type === 'telephoto') return 3.0;
    return 1.0;
  }
}
