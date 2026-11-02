/* DesignKit 移动端 · 图片预处理
 *
 * 上传前在本地压缩：长边 ≤ 1600px，JPEG 0.85。
 * 用 createImageBitmap({ imageOrientation: 'from-image' }) 处理 EXIF 方向；
 * 老浏览器回退到 <img>，Safari 渲染时会自带方向。
 *
 * 已知限制：透明 PNG 会被铺白底转 JPEG（商品图基本不透明，可接受）。
 */

export const MAX_EDGE = 1600;
export const JPEG_QUALITY = 0.85;
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

export function scaleToFit(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scaled: false };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scaled: true,
  };
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, objectURL: url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法解码，请换一张或重新拍摄'));
    };
    img.src = url;
  });
}

async function loadSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, objectURL: '' };
    } catch {
      /* 老浏览器可能不认 imageOrientation，继续尝试不带参数 */
    }
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, objectURL: '' };
    } catch {
      /* 回退 <img> */
    }
  }
  return loadViaImage(file);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('压缩失败，请换一张图重试'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

function baseName(name) {
  const n = String(name || 'photo');
  const dot = n.lastIndexOf('.');
  const stem = dot > 0 ? n.slice(0, dot) : n;
  return stem.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'photo';
}

/**
 * 压缩一张图片，返回可直接上传的 File。
 * @param {File} file
 * @returns {Promise<{file: File, blob: Blob, width: number, height: number, previewURL: string,
 *   originalBytes: number, bytes: number, compressed: boolean}>}
 */
export async function prepareImage(file) {
  if (!file) throw new Error('没有选择图片');
  if (file.type && !file.type.startsWith('image/')) throw new Error('仅支持图片文件');
  if (file.size > MAX_INPUT_BYTES) throw new Error('图片超过 30MB，请先在相册里压缩或重拍');

  const loaded = await loadSource(file);
  const src = loaded.source;
  const target = scaleToFit(loaded.width, loaded.height);

  let blob;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片压缩，请换浏览器重试');
    /* JPEG 不支持透明通道，先铺白底，避免透明区域变黑 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, target.width, target.height);
    blob = await canvasToBlob(canvas);
  } finally {
    if (src && typeof src.close === 'function') src.close();
    if (loaded.objectURL) URL.revokeObjectURL(loaded.objectURL);
  }

  const outFile = new File([blob], `${baseName(file.name)}.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });

  return {
    file: outFile,
    blob,
    width: target.width,
    height: target.height,
    previewURL: URL.createObjectURL(blob),
    originalBytes: file.size,
    bytes: blob.size,
    compressed: target.scaled || blob.size < file.size,
  };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
