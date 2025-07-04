/**
 * AudioWorklet type definitions
 */

declare global {
  class AudioWorkletProcessor {
    readonly port: MessagePort;
    process(
      _inputs: Float32Array[][],
      _outputs: Float32Array[][],
      _parameters: Record<string, Float32Array>
    ): boolean;
  }

  // eslint-disable-next-line no-unused-vars
  function registerProcessor(
    _name: string,
    _processorCtor: new (_options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
  ): void;
}

export {};