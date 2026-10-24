import { Transform } from 'node:stream';
export const MAX_MESSAGE_BYTES = 512 * 1024;
export function encodeMessage(message) {
  const data = Buffer.from(JSON.stringify(message), 'utf8');
  if (data.length > MAX_MESSAGE_BYTES) throw new Error('Native message is too large');
  const frame = Buffer.allocUnsafe(data.length + 4);
  frame.writeUInt32LE(data.length, 0); data.copy(frame, 4); return frame;
}
export class MessageDecoder extends Transform {
  constructor() { super({ readableObjectMode: true }); this.pending = Buffer.alloc(0); }
  _transform(chunk, encoding, callback) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const size = this.pending.readUInt32LE(0);
        if (size === 0 || size > MAX_MESSAGE_BYTES) throw new Error('Invalid native message size');
        if (this.pending.length < size + 4) break;
        const message = JSON.parse(this.pending.subarray(4, size + 4).toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid native message');
        this.push(message); this.pending = this.pending.subarray(size + 4);
      }
      callback();
    } catch { callback(new Error('Invalid native message')); }
  }
  _flush(callback) { callback(this.pending.length ? new Error('Incomplete native message') : null); }
}
