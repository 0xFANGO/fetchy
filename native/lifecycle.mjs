export function shouldStopIdle(controller, bridge, now = Date.now(), idleMs = 5 * 60_000) {
  const busy = ['running', 'cancelling'].includes(controller.task?.status) || controller.choosingDirectory || controller.resolvers.size > 0;
  return !busy && bridge.clientCount === 0 && now - bridge.lastActivity > idleMs;
}
