import type { TrainData } from '../../src/sources/train.ts';

/** A morning board with one of each status — the render's worst case. */
export const mixedBoard: TrainData = {
  originCrs: 'MKC',
  originName: 'Milton Keynes Central',
  destinationCrs: 'EUS',
  destinationName: 'London Euston',
  departures: [
    { scheduled: '07:42', expected: null, status: 'on-time', delayMinutes: 0, platform: '3' },
    { scheduled: '07:58', expected: '08:01', status: 'delayed', delayMinutes: 9, platform: '1' },
    { scheduled: '08:19', expected: null, status: 'cancelled', delayMinutes: null, platform: null },
  ],
};
