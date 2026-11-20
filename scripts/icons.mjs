import { deflateSync } from "node:zlib";

const outline = [
  [[32, 18], [26, 14], [20, 13], [11, 16], [11, 46], [20, 43], [26, 44], [32, 48]],
  [[32, 18], [38, 14], [44, 13], [53, 16], [53, 46], [44, 43], [38, 44], [32, 48], [32, 18]],
];

function distance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function chunk(name, data) {
  const payload = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

export function renderIcon(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = 4 * size + 1;
  const content = Buffer.alloc(stride * size);
  const ink = [231, 235, 240];
  const paper = [23, 26, 31];
  const samples = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pixel = [0, 0, 0];
      let painted = 0;
      for (let dy = 0; dy < samples; dy++) for (let dx = 0; dx < samples; dx++) {
        const u = (x + (dx + .5) / samples) * 64 / size;
        const v = (y + (dy + .5) / samples) * 64 / size;
        if (Math.hypot(Math.max(0, Math.abs(u - 32) - 19), Math.max(0, Math.abs(v - 32) - 19)) > 9) continue;
        const line = outline.some((points) => points.some((point, i) =>
          i > 0 && distance(u, v, points[i - 1], point) < 2.25,
        ));
        const rgb = line ? ink : paper;
        for (let channel = 0; channel < 3; channel++) pixel[channel] += rgb[channel];
        painted++;
      }
      if (!painted) continue;
      const offset = y * stride + x * 4 + 1;
      for (let channel = 0; channel < 3; channel++) content[offset + channel] = Math.round(pixel[channel] / painted);
      content[offset + 3] = Math.round(255 * painted / (samples * samples));
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(content)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
