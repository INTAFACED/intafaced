import { describe, expect, it } from 'vitest';
import { chooseTier, isSoftwareRenderer, type DeviceSignals } from './tier.js';

const strong: DeviceSignals = {
  webgl2: true,
  hardwareGl: true,
  reducedMotion: false,
  saveData: false,
  deviceMemory: 8,
  cores: 8,
  coarsePointer: false,
};

describe('chooseTier', () => {
  it('gives a strong device the full 3D', () => {
    expect(chooseTier(strong)).toBe('full');
  });
  it('gives the poster without WebGL 2, even when a tier is forced', () => {
    expect(chooseTier({ ...strong, webgl2: false, forced: 'full' })).toBe('poster');
  });
  it('lets tests force a tier on a software renderer', () => {
    expect(chooseTier({ ...strong, hardwareGl: false, forced: 'full' })).toBe('full');
    expect(chooseTier({ ...strong, hardwareGl: false })).toBe('poster');
  });
  it('honours reduced motion and data saving with the still poster', () => {
    expect(chooseTier({ ...strong, reducedMotion: true })).toBe('poster');
    expect(chooseTier({ ...strong, saveData: true })).toBe('poster');
  });
  it('steps weak devices down', () => {
    expect(chooseTier({ ...strong, deviceMemory: 2 })).toBe('poster');
    expect(chooseTier({ ...strong, cores: 2 })).toBe('poster');
    expect(chooseTier({ ...strong, deviceMemory: 4 })).toBe('lite');
    expect(chooseTier({ ...strong, cores: 4 })).toBe('lite');
  });
  it('starts a phone that reports nothing (iOS Safari) on lite', () => {
    expect(chooseTier({ ...strong, deviceMemory: undefined, cores: undefined, coarsePointer: true })).toBe('lite');
  });
  it('ignores an unknown forced value', () => {
    expect(chooseTier({ ...strong, forced: 'ultra' })).toBe('full');
  });
});

describe('isSoftwareRenderer', () => {
  it('spots software WebGL', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe(false);
    expect(isSoftwareRenderer('Apple GPU')).toBe(false);
  });
});
