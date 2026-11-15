/* 从图片头部读出宽高，纯 JS、零依赖、不解码像素。
 *
 * 为什么要这个：<img> 不写 width/height，浏览器在图片下载完之前不知道该留多高，
 * 加载完成那一刻整页往下顶一下 —— 这就是 CLS 的全部来源。写上真实宽高，
 * 浏览器按 attr(width)/attr(height) 推出宽高比，图片没到也能先把位置占住。
 *
 * 为什么不在 Worker 里用 sharp：Workers 跑不了原生模块。也不需要 ——
 * PNG 的宽高固定在 IHDR 的 16/20 字节，JPEG 在 SOF 段，都是一次下标访问的事。
 *
 * 认不出来的格式返回 null，调用方就别写属性，不要瞎猜一个值。
 */

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function imageSize(input) {
  let b;
  if (input instanceof Uint8Array) b = input;
  else if (input instanceof ArrayBuffer) b = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) b = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else return null;
  if (b.length < 16) return null;

  const be16 = (o) => (b[o] << 8) | b[o + 1];
  const be32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const le16 = (o) => b[o] | (b[o + 1] << 8);
  const le24 = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));

  /* PNG：签名 8 字节 + 长度 4 + 'IHDR' 4，宽在 16、高在 20 */
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    if (ascii(12, 4) !== 'IHDR') return null;
    return { w: be32(16), h: be32(20), type: 'png' };
  }

  /* GIF：宽高是 LE16，紧跟在 6 字节签名+版本后面 */
  if (ascii(0, 3) === 'GIF') {
    return { w: le16(6), h: le16(8), type: 'gif' };
  }

  /* JPEG：扫段。SOF 系列里记着真实尺寸，高在前宽在后（跟直觉相反）。
     段长含自身 2 字节，所以下一段起点是 i + 2 + 段长。 */
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }            // 填充字节
      if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = be16(i + 2);
      if (len < 2) return null;
      if (SOF.has(m)) return { w: be16(i + 7), h: be16(i + 5), type: 'jpeg' };
      i += 2 + len;
    }
    return null;
  }

  /* WebP：RIFF 容器，三种子格式的尺寸位置各不相同 */
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') {
      // 关键帧起始码 9d 01 2a 之后是 14 位的宽和高
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff, type: 'webp' };
    }
    if (chunk === 'VP8L') {
      // 无符号位流：14 位宽-1、14 位高-1，从第 21 字节起
      if (b[20] !== 0x2f) return null;
      const bits = le24(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (chunk === 'VP8X') {
      return { w: le24(24) + 1, h: le24(27) + 1, type: 'webp' };
    }
    return null;
  }

  /* AVIF / HEIF：跟着 ftyp 走 box，尺寸在 meta → iprp → ipco 的 ispe 里。
     完整遍历要写几十行 box walker，直接找 'ispe' 更快 —— 它只会出现在头部元数据区，
     第一处命中就是图像尺寸，误命中像素数据的概率可以忽略。 */
  if (ascii(4, 4) === 'ftyp' && /avi[fs]|heic|heix|mif1/.test(ascii(8, 4))) {
    for (let i = 0; i + 16 < b.length && i < 4096; i++) {
      if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
        const w = be32(i + 8);
        const h = be32(i + 12);
        if (w > 0 && h > 0 && w < 100000 && h < 100000) return { w, h, type: 'avif' };
      }
    }
    return null;
  }

  /* SVG 是文本，读属性即可；viewBox 兜底（很多导出工具只写 viewBox） */
  const head = ascii(0, Math.min(600, b.length));
  if (/<svg[\s>]/i.test(head)) {
    const text = new TextDecoder().decode(b.subarray(0, Math.min(4096, b.length)));
    const w = Number((/\bwidth\s*=\s*"(\d+(?:\.\d+)?)/i.exec(text) || [])[1]);
    const h = Number((/\bheight\s*=\s*"(\d+(?:\.\d+)?)/i.exec(text) || [])[1]);
    if (w > 0 && h > 0) return { w: Math.round(w), h: Math.round(h), type: 'svg' };
    const vb = /viewBox\s*=\s*"[\d.\s-]*?([\d.]+)[\s,]+([\d.]+)"\s*\/?>/i.exec(text);
    if (vb) {
      const vw = Number(vb[1]);
      const vh = Number(vb[2]);
      if (vw > 0 && vh > 0) return { w: Math.round(vw), h: Math.round(vh), type: 'svg' };
    }
  }

  return null;
}

/* 把尺寸拼进 URL 查询串。为什么不塞进路径或另建一张表：
 *   - 塞路径要改 key 命名规则，老图的引用全得重写；
 *   - 建表要一次 D1 查询 + 一次 JOIN，只为了两个整数；
 *   - 查询串由图片自己携带，渲染时零 IO 就能拿到，而且天然跟着 markdown 走。 */
export function withSize(url, size) {
  if (!size || !size.w || !size.h) return url;
  if (/[?&](?:amp;)?w=/.test(url)) return url; // 已经有了，别重复追加
  return `${url}${url.includes('?') ? '&' : '?'}w=${size.w}&h=${size.h}`;
}
