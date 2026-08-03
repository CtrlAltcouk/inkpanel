import express from 'express';
import type { DeviceStore } from '../devices/store.ts';
import type { FrameService } from '../render/frameService.ts';
import { deviceRoutes } from './deviceRoutes.ts';

export interface AppDeps {
  store: DeviceStore;
  frames: FrameService;
  publicBaseUrl: string;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/api', deviceRoutes(deps.store, deps.frames, deps.publicBaseUrl));
  return app;
}
