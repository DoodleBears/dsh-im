export function detectedVideoMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return undefined;
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > bytes.byteLength || ascii(4, 8) !== 'ftyp') return undefined;
  const brands = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1']);
  if (brands.has(ascii(8, 12))) return 'video/mp4';
  return undefined;
}
