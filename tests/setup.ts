// Vitest global setup for jsdom environment
import { vi } from 'vitest'

// Mock AudioWorkletProcessor for testing
class MockAudioWorkletProcessor {
  process(_inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    return true
  }
}

// Mock AudioContext APIs
class MockAudioContext {
  sampleRate = 44100
  destination = {}
  
  createScriptProcessor() {
    return {}
  }
  
  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length)
    }
  }
  
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn()
    }
  }
  
  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn()
    }
  }
  
  createAnalyser() {
    return {
      fftSize: 2048,
      frequencyBinCount: 1024,
      getFloatFrequencyData: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
      connect: vi.fn()
    }
  }
  
  addModule() {
    return Promise.resolve()
  }
}

// Setup global mocks
global.AudioWorkletProcessor = MockAudioWorkletProcessor
global.AudioContext = MockAudioContext as any
global.registerProcessor = vi.fn()

// // Mock getUserMedia
// Object.defineProperty(navigator, 'mediaDevices', {
//   writable: true,
//   value: {
//     getUserMedia: vi.fn().mockResolvedValue({
//       getTracks: () => [],
//       addEventListener: vi.fn()
//     })
//   }
// })
