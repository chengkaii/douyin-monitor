import type { AppConfig } from '../types.js';
import type { Channel } from './types.js';
import { Evil0ctalChannel } from './evil0ctal.js';
import { TikHubChannel } from './tikhub.js';

export function createChannel(config: AppConfig): Channel {
  const kind = process.env['CHANNEL'] ?? 'evil0ctal';
  return kind === 'tikhub' ? new TikHubChannel() : new Evil0ctalChannel(config.dtk);
}

export type { Channel } from './types.js';
export { ChannelError } from './types.js';
