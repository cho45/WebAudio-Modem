# FSKProcessor アーキテクチャ改善

## 問題

FSKProcessorが複雑すぎてテストが困難：

```typescript
// 元の実装 - 複数の責任が混在
class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore;
  private outputBuffer: RingBuffer;
  private inputBuffer: RingBuffer;
  private pendingModulation: PendingModulation | null = null;
  private chunkSize = 32;
  private minBufferSpace = 1000;

  // メッセージハンドリング
  private async handleMessage(event: MessageEvent<WorkletMessage>) { ... }
  
  // 段階的変調処理
  private async processChunk(): Promise<void> { ... }
  
  // オーディオI/O
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean { ... }
}
```

## 解決策：責任分離

### 1. ChunkedModulator - 段階的変調ロジック

```typescript
export class ChunkedModulator {
  async processNextChunk(): Promise<ChunkResult | null> {
    // 段階的変調の処理ロジック
    // AudioWorkletから独立してテスト可能
  }
}
```

**テスト例**：
```typescript
test('should process chunks sequentially', async () => {
  const mockFSKCore = { modulateData: vi.fn() };
  const modulator = new ChunkedModulator(mockFSKCore, { chunkSize: 4 });
  
  modulator.startModulation(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  
  const result1 = await modulator.processNextChunk();
  expect(result1.position).toBe(4);
  expect(result1.isComplete).toBe(false);
  
  const result2 = await modulator.processNextChunk();
  expect(result2.position).toBe(8);
  expect(result2.isComplete).toBe(true);
});
```

### 2. AudioBufferManager - リングバッファ管理

```typescript
export class AudioBufferManager {
  writeInput(samples: Float32Array): void { ... }
  readAllInput(): Float32Array { ... }
  writeOutput(samples: Float32Array): void { ... }
  readOutput(outputSamples: Float32Array): void { ... }
  hasOutputSpace(): boolean { ... }
}
```

**テスト例**：
```typescript
test('should handle input operations', () => {
  const bufferManager = new AudioBufferManager({ inputBufferSize: 8 });
  
  bufferManager.writeInput(new Float32Array([1.0, 2.0, 3.0]));
  const samples = bufferManager.readAllInput();
  
  expect(samples).toEqual(new Float32Array([1.0, 2.0, 3.0]));
});
```

### 3. FSKProcessor - シンプルなコーディネータ

```typescript
class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore;
  private bufferManager: AudioBufferManager;
  private pendingModulation: PendingModulation | null = null;

  // メッセージハンドリングのみ
  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    case 'modulate':
      const modulator = new ChunkedModulator(this.fskCore);
      modulator.startModulation(data.bytes);
      this.pendingModulation = { id, modulator };
      break;
  }

  // 段階的処理の呼び出しのみ
  private async processChunk(): Promise<void> {
    const result = await this.pendingModulation.modulator.processNextChunk();
    if (result) {
      this.bufferManager.writeOutput(result.signal);
    }
  }

  // オーディオI/Oの呼び出しのみ
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (input && input[0]) {
      this.bufferManager.writeInput(input[0]);
    }
    if (output && output[0]) {
      this.bufferManager.readOutput(output[0]);
    }
    return true;
  }
}
```

## 利点

1. **単体テスト可能**：各コンポーネントが独立してテスト可能
2. **責任分離**：各クラスが単一の責任を持つ
3. **再利用性**：ChunkedModulatorやAudioBufferManagerは他のモジュレータでも使用可能
4. **可読性**：FSKProcessorがシンプルで理解しやすい

## テスト結果

```
✓ tests/webaudio/chunked-modulator.test.ts (9 tests)
✓ tests/webaudio/audio-buffer-manager.test.ts (9 tests)
✓ All 236 tests passed
```

この設計により、複雑なAudioWorklet処理を単体テスト可能な小さなコンポーネントに分解できました。