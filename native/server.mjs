import net from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { MessageDecoder, encodeMessage } from './protocol.mjs';
import { publicError, bridgeError } from './errors.mjs';

export async function startServer(controller, socketPath) {
  const clients = new Set();
  let lastActivity = Date.now();
  const send = (socket, message) => { if (!socket.destroyed && socket.writable) { try { socket.write(encodeMessage(message)); } catch { socket.destroy(); } } };
  const broadcast = (state) => { for (const socket of clients) send(socket, { event: 'state', state }); };
  controller.on('state', broadcast);
  const server = net.createServer((socket) => {
    clients.add(socket); lastActivity = Date.now();
    const decoder = new MessageDecoder(); socket.pipe(decoder);
    socket.on('error', () => {}); decoder.on('error', () => socket.destroy());
    socket.on('close', () => { clients.delete(socket); lastActivity = Date.now(); });
    send(socket, { event: 'state', state: controller.snapshot() });
    decoder.on('data', async (message) => {
      lastActivity = Date.now();
      const id = typeof message.id === 'string' && message.id.length <= 128 ? message.id : null;
      try {
        if (!id || typeof message.method !== 'string') throw bridgeError('invalid_request');
        const result = await controller.request(message.method, message.params);
        send(socket, { id, ok: true, result });
      } catch (error) { send(socket, { id, ok: false, error: publicError(error) }); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
    await chmod(socketPath, 0o600);
  } catch (error) { controller.removeListener('state', broadcast); throw error; }
  return {
    server,
    get clientCount() { return clients.size; },
    get lastActivity() { return lastActivity; },
    async close() {
      controller.removeListener('state', broadcast);
      for (const socket of clients) socket.destroy();
      await new Promise((resolve) => server.close(resolve)); await rm(socketPath, { force: true });
    },
  };
}
