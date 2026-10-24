import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist', 'extension');
await rm(output, { recursive: true, force: true });
await cp(join(root, 'extension'), output, { recursive: true });
await mkdir(join(output, 'shared'), { recursive: true });
await cp(join(root, 'src', 'urls.mjs'), join(output, 'shared', 'urls.mjs'));
const controller = await readFile(join(output, 'controller.mjs'), 'utf8');
await writeFile(join(output, 'controller.mjs'), controller.replace("'../src/urls.mjs'", "'./shared/urls.mjs'"));

// Dependency-free rasterization of the extension's geometric download mark.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function icon(size) {
  const scan = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size, i = y * (size * 4 + 1) + 1 + x * 4;
    const corner = Math.hypot(Math.max(.19-u, u-.81, 0), Math.max(.19-v, v-.81, 0));
    const solid = corner < .16;
    const shaft = u > .445 && u < .555 && v > .23 && v < .58;
    const arrow = v >= .46 && v <= .68 && Math.abs(u-.5) < (.68-v) && Math.abs(u-.5) > (.57-v);
    const base = u > .25 && u < .75 && v > .73 && v < .8;
    scan.set(solid ? shaft || arrow || base ? [255,250,240,255] : [201,87,59,255] : [0,0,0,0], i);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(scan)), chunk('IEND',Buffer.alloc(0))]);
}
await mkdir(join(output, 'icons'), { recursive: true });
for (const size of [16,32,48,128]) await writeFile(join(output, 'icons', `icon${size}.png`), icon(size));
const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
console.log(`扩展已构建：${output}\n扩展 ID：${id}`);
