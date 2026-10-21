// OpenEXR decoding via three.js's EXRLoader (handles PIZ, ZIP, RLE, PXR24, B44 and DWA).
// three is already loaded for the preview, so this adds no new dependency.

export async function decodeExr(buffer) {
  const THREE = await import('three');
  const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
  const loader = new EXRLoader().setDataType(THREE.FloatType);
  let tex;
  try {
    tex = loader.parse(buffer);
  } catch (err) {
    throw new Error(`Couldn’t decode this EXR (${err.message})`);
  }
  const { width, height, data: src } = tex;
  if (!width || !height || !src) throw new Error('This EXR has no image data');
  const stride = src.length / (width * height); // 4 for RGBA, 1 for a single channel
  // EXRLoader stores rows bottom-up (texture order); flip back to top-down.
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const s = (from + x) * stride;
      const d = (y * width + x) * 3;
      const r = src[s];
      data[d] = r;
      data[d + 1] = stride >= 3 ? src[s + 1] : r;
      data[d + 2] = stride >= 3 ? src[s + 2] : r;
    }
  }
  return { width, height, data };
}
