import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12);
  buffer.writeUInt32BE(data.length, 0);
  buffer.write(type, 4);
  data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, buffer.length - 4)), buffer.length - 4);
  return buffer;
}

await mkdir("extension/icons", { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const horizontal = column / size;
      const vertical = row / size;
      const cornerX = Math.max(.19 - horizontal, horizontal - .81, 0);
      const cornerY = Math.max(.19 - vertical, vertical - .81, 0);
      const inside = cornerX * cornerX + cornerY * cornerY < .19 ** 2;
      const spine = horizontal > .47 && horizontal < .52 && vertical > .27 && vertical < .78;
      const page = horizontal > .22 && horizontal < .78 && vertical > .25 && vertical < .7 && !spine;
      const line = (vertical > .36 && vertical < .4 || vertical > .48 && vertical < .52) && (horizontal > .28 && horizontal < .42 || horizontal > .58 && horizontal < .72);
      const color = !inside ? [0, 0, 0, 0] : line || spine ? [67, 97, 77, 255] : page ? [245, 243, 229, 255] : [67, 97, 77, 255];
      pixels.set(color, row * (size * 4 + 1) + 1 + column * 4);
    }
  }
  await writeFile(`extension/icons/${size}.png`, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
}
console.log("Generated extension icons (16, 32, 48, 128 px).");
