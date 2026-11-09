import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('source AudioWorklet', () => {
  it.each([16000, 44100, 48000])(
    'emits 100 ms mono packets at 16 kHz from a %s Hz device',
    (rate) => {
      let Processor;
      const packets = [];
      runInNewContext(
        readFileSync(resolve('public/pcm-capture-processor.js'), 'utf8'),
        {
          AudioWorkletProcessor: class {
            port = {
              postMessage(value) {
                packets.push(value);
              }
            };
          },
          sampleRate: rate,
          Float32Array,
          registerProcessor(_name, implementation) {
            Processor = implementation;
          }
        }
      );
      const processor = new Processor();
      expect(
        processor.process([
          [
            new Float32Array(rate / 10).fill(1),
            new Float32Array(rate / 10).fill(-1)
          ]
        ])
      ).toBe(true);
      expect(packets).toHaveLength(1);
      expect(packets[0]).toHaveLength(1600);
      expect(packets[0].every((value) => value === 0)).toBe(true);
    }
  );
});
