/**
 * iPhone純正カメラ準拠のフィルター定義と露出フィルター合成
 */
export const FILTERS = [
  { id: 'original', name: 'オリジナル', css: '' },
  { id: 'vivid', name: 'ビビッド', css: 'saturate(1.38) contrast(1.08)' },
  { id: 'vivid-warm', name: 'ビビッド(暖)', css: 'saturate(1.35) contrast(1.06) sepia(0.16) hue-rotate(-6deg)' },
  { id: 'vivid-cool', name: 'ビビッド(寒)', css: 'saturate(1.28) contrast(1.08) hue-rotate(10deg) brightness(1.02)' },
  { id: 'dramatic', name: 'ドラマチック', css: 'contrast(1.32) saturate(0.86) brightness(0.95)' },
  { id: 'dramatic-warm', name: 'ドラマチック(暖)', css: 'contrast(1.28) saturate(0.9) sepia(0.22) brightness(0.96)' },
  { id: 'mono', name: 'モノ', css: 'grayscale(1) contrast(1.08)' },
  { id: 'silvertone', name: 'シルバートーン', css: 'grayscale(1) contrast(1.22) brightness(1.05)' },
  { id: 'noir', name: 'ノワール', css: 'grayscale(1) contrast(1.52) brightness(0.88)' }
];

export function getFilterById(id) {
  return FILTERS.find((f) => f.id === id) || FILTERS[0];
}

/**
 * フィルターとソフトウェア露出補正値(-2.0〜+2.0)をCSS filter文字列へ合成する
 */
export function buildCssFilter(filterId, exposureEv = 0, useSoftwareExposure = true) {
  const parts = [];
  const f = getFilterById(filterId);
  if (f && f.css) {
    parts.push(f.css);
  }
  if (useSoftwareExposure && Math.abs(exposureEv) > 0.01) {
    // EV -2..+2 を自然な明るさ係数 (0.55..1.65) に変換
    const brightness = Math.max(0.45, Math.min(1.75, Math.pow(1.28, exposureEv)));
    parts.push(`brightness(${brightness.toFixed(3)})`);
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}
