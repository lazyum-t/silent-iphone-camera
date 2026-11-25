/**
 * iOS純正「写真」アプリへの保存モジュール
 * Web Share API (navigator.share({ files })) を使い、iOSの共有シート経由で
 * 「画像を保存」／「N枚の画像を保存」／「ビデオを保存」により写真アプリへ直接保存する。
 */

export function isIOSDevice() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function buildMediaFilename(type = 'photo', mimeType = 'image/jpeg', date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
  if (type === 'video') {
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    return `VID_${stamp}.${ext}`;
  }
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  return `IMG_${stamp}.${ext}`;
}

export function blobToFile(blob, filename) {
  return new File([blob], filename, {
    type: blob.type || 'image/jpeg',
    lastModified: Date.now()
  });
}

export function canShareFiles(files) {
  if (!navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * ファイルをiOS共有シート（「画像を保存」→純正写真アプリ）で保存する
 * @returns {Promise<{status: 'shared'|'cancelled'|'blocked'|'unsupported', error?: Error}>}
 */
export async function saveFilesToIOSPhotos(files) {
  if (!files || files.length === 0) {
    return { status: 'unsupported' };
  }

  if (!canShareFiles(files)) {
    return { status: 'unsupported' };
  }

  try {
    await navigator.share({
      files
    });
    return { status: 'shared' };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { status: 'cancelled', error: err };
    }
    if (err && err.name === 'NotAllowedError') {
      // User Activation 期限切れ（シャッター後の非同期処理で発生しうる）
      return { status: 'blocked', error: err };
    }
    return { status: 'unsupported', error: err };
  }
}

/**
 * 通常のファイルダウンロード（PCや非対応ブラウザ、ファイルアプリ保存用）
 */
export function downloadBlobAsFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}
