# モダンWebAudio FSKモデム開発計画書

## プロジェクト概要

既存のWebAudio-Modem実装をベースに、現代的な技術スタックとベストプラクティスを採用した新しいFSKモデムを開発する。

## 技術スタック選定

### コア技術
- **Web Audio API 2.0**: AudioWorkletを使用（ScriptProcessorNodeからの移行）
- **TypeScript**: 型安全性とコード品質の向上
- **ES2022+**: モダンJavaScript機能の活用
- **Web Standards**: Web Components + ES Modules

### 開発・ビルドツール
- **Vite**: 高速開発環境とビルドツール
- **Vitest**: TypeScript対応テストフレームワーク
- **ESLint**: コード品質管理
- **TypeScript**: 型チェックと開発体験向上

### フロントエンド
- **Vanilla JS + Web Components**: フレームワーク依存を避けたモダンなアプローチ
- **Canvas API**: リアルタイム波形可視化
- **CSS Grid/Flexbox**: レスポンシブUI

## 拡張可能なアーキテクチャ設計

### 変調方式抽象化インターフェース

将来的なPSK、QAM等の変調方式追加を見据えた抽象化レイヤーを設計。

#### IModulator インターフェース
```typescript
interface BaseModulatorConfig {
  sampleRate: number;
  baudRate: number;
}

interface IModulator<TConfig extends BaseModulatorConfig = BaseModulatorConfig> {
  readonly name: string;
  readonly type: 'FSK' | 'PSK' | 'QAM' | 'ASK';
  
  // 設定管理（変調方式固有の設定型を使用）
  configure(config: TConfig): void;
  getConfig(): TConfig;
  
  // 変調・復調
  modulate(data: Uint8Array): Float32Array;
  demodulate(samples: Float32Array): Uint8Array;
  
  // 状態管理
  reset(): void;
  isReady(): boolean;
  
  // 品質監視
  getSignalQuality(): SignalQuality;
  
  // イベント処理
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
}

interface SignalQuality {
  snr: number;           // Signal-to-Noise Ratio
  ber: number;           // Bit Error Rate
  eyeOpening: number;    // Eye Pattern Opening
  phaseJitter: number;   // Phase Jitter (PSK用)
  frequencyOffset: number; // Frequency Offset
}
```

#### 具体的な実装例
```typescript
// FSK固有の設定
interface FSKConfig extends BaseModulatorConfig {
  markFrequency: number;
  spaceFrequency: number;
  startBit: number;
  stopBit: number;
  threshold: number;
}

// PSK固有の設定
interface PSKConfig extends BaseModulatorConfig {
  carrierFrequency: number;
  constellation: 2 | 4 | 8 | 16; // BPSK, QPSK, 8-PSK, 16-PSK
  symbolRate: number;
  pulseShaping: 'none' | 'rrc' | 'cosine';
}

// FSK実装
class FSKModulator implements IModulator<FSKConfig> {
  readonly name = 'FSK';
  readonly type = 'FSK';
  
  private config: FSKConfig;
  
  configure(config: FSKConfig): void {
    this.config = config;
  }
  
  getConfig(): FSKConfig {
    return this.config;
  }
  
  modulate(data: Uint8Array): Float32Array {
    // FSK変調実装
  }
  
  demodulate(samples: Float32Array): Uint8Array {
    // FSK復調実装
  }
}

// PSK実装（将来）
class PSKModulator implements IModulator<PSKConfig> {
  readonly name = 'PSK';
  readonly type = 'PSK';
  
  private config: PSKConfig;
  
  configure(config: PSKConfig): void {
    this.config = config;
  }
  
  getConfig(): PSKConfig {
    return this.config;
  }
  
  modulate(data: Uint8Array): Float32Array {
    // PSK変調実装
  }
  
  demodulate(samples: Float32Array): Uint8Array {
    // PSK復調実装
  }
}
```

### プロジェクトディレクトリ構造

```
WebAudio-Modem/
├── src/
│   ├── core.ts                  # インターフェース・基底クラス定義
│   ├── utils.ts                 # DSP・数学・バッファ管理
│   │
│   ├── modulators/              # 変調方式実装
│   │   ├── fsk.ts               # FSK変調・復調
│   │   ├── psk.ts               # PSK変調・復調（将来実装）
│   │   └── qam.ts               # QAM変調・復調（将来実装）
│   │
│   ├── protocols.ts             # フレーミング・エラー制御・パケット
│   ├── visualization.ts         # 波形・スペクトラム・コンステレーション
│   ├── ui.ts                    # UI コンポーネント
│   │
│   └── main.ts                  # メインエントリーポイント
│
├── demo/                        # デモアプリケーション
│   ├── index.html
│   ├── style.css
│   ├── main.ts
│   └── assets/
│       └── sample-files/
│
├── tests/                       # テストファイル
│   ├── modulators.test.ts
│   ├── protocols.test.ts
│   ├── utils.test.ts
│   └── integration.test.ts
│
├── worklets/                    # AudioWorklet実装
│   ├── fsk-worklet.js
│   ├── psk-worklet.js
│   └── common-worklet.js
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── README.md
```

### ファイル構成の詳細

**src/core.ts**
- IModulator, IProtocol, IVisualizer インターフェース
- BaseModulator, BaseProtocol 基底クラス
- AudioWorkletBase 基底クラス
- ModulatorFactory クラス

**src/utils.ts**
- DSP関数（FFT、フィルタ、エンベロープ検波等）
- 数学関数（sin/cos テーブル、補間等）
- バッファ管理（RingBuffer、CircularBuffer等）
- 共通ユーティリティ関数

## 開発フェーズとマイルストーン

### Phase 1: 基盤構築 (Week 1-2)

#### 1.1 プロジェクト初期化
- [ ] プロジェクト構造の設計・作成
- [ ] TypeScript + Vite環境構築
- [ ] ESLint設定
- [ ] AudioWorklet前提の基盤設計

### Phase 2: コア信号処理 (Week 3-4)

#### 2.1 FSK変調器
- [ ] 位相連続FSK変調アルゴリズム実装
- [ ] AudioBuffer生成とスケジューリング
- [ ] 単体テスト作成

#### 2.2 FSK復調器
- [ ] 位相同期検波実装（I/Q復調）
- [ ] デジタルフィルタ設計（バンドパス・ローパス）
- [ ] 状態機械による復調制御
- [ ] ビット同期・フレーム同期

#### 2.3 信号品質向上
- [ ] 適応的閾値調整
- [ ] ノイズ除去フィルタ
- [ ] AGC（自動ゲイン制御）実装
- [ ] 信号品質メトリクス

### Phase 3: プロトコル層 (Week 5-6)

#### 3.1 フレーミングプロトコル
- [ ] スタート/ストップビット処理
- [ ] バイトフレーミング
- [ ] エラー検出（パリティ、CRC）
- [ ] 文字エンコーディング対応

#### 3.2 パケットプロトコル
- [ ] パケット構造設計（Header + Payload + CRC）
- [ ] ACK/NAK応答システム
- [ ] 自動再送（ARQ）メカニズム
- [ ] フロー制御

#### 3.3 高水準プロトコル
- [ ] ファイル転送プロトコル
- [ ] チャンキングと再構築
- [ ] プログレス監視
- [ ] エラーリカバリ

### Phase 4: ユーザーインターフェース (Week 7-8)

#### 4.1 コア UI コンポーネント
- [ ] モジュレーター制御パネル
- [ ] デモジュレーター表示
- [ ] リアルタイム波形ビューア
- [ ] 信号品質インディケータ

#### 4.2 高度な可視化
- [ ] スペクトラムアナライザー
- [ ] アイパターン表示
- [ ] 信号統計ダッシュボード
- [ ] エラー率グラフ

#### 4.3 ユーザー体験
- [ ] ドラッグ&ドロップファイル転送
- [ ] 設定のプリセット管理
- [ ] ヘルプ・チュートリアル
- [ ] レスポンシブデザイン

#### 4.4 変調方式切り替えデモ
- [ ] 変調方式選択UI（FSK/PSK/QAM）
- [ ] リアルタイム方式切り替え
- [ ] 各方式の特性比較表示
- [ ] パフォーマンス・品質比較チャート

### Phase 5: テスト・最適化 (Week 9-10)

#### 5.1 総合テスト
- [ ] 単体テスト完成度向上
- [ ] 統合テスト実装
- [ ] E2Eテスト（Playwright等）
- [ ] パフォーマンステスト

#### 5.2 AudioWorkletテスト戦略
- [ ] DSPロジックの分離・Node.jsテスト
- [ ] Web Audio API mockによるブラウザテスト
- [ ] 実ブラウザでのダミーデータ統合テスト
- [ ] UI コンポーネント動作テスト

#### 5.3 最適化
- [ ] AudioWorklet最適化
- [ ] メモリ使用量削減
- [ ] CPU負荷削減
- [ ] 遅延最小化

#### 5.4 互換性・品質保証
- [ ] ブラウザ互換性テスト
- [ ] モバイルデバイス対応
- [ ] アクセシビリティ確保
- [ ] セキュリティ監査

### Phase 6: ドキュメント・配布 (Week 11-12)

#### 6.1 ドキュメント作成
- [ ] API仕様書
- [ ] 使用方法ガイド
- [ ] 技術アーキテクチャ文書
- [ ] 貢献ガイドライン

#### 6.2 配布準備
- [ ] GitHub Pages対応
- [ ] NPMパッケージ化
- [ ] CDN配布準備
- [ ] Docker化（オプション）

## 技術要件詳細

### パフォーマンス要件
- **遅延**: < 100ms (エンドツーエンド)
- **CPU使用率**: < 20% (通常動作時)
- **メモリ使用量**: < 50MB
- **対応サンプリング周波数**: 44.1kHz, 48kHz

### 互換性要件
- **対応ブラウザ**: Chrome 90+, Firefox 90+, Safari 14+, Edge 90+
- **必須機能**: AudioWorklet, getUserMedia, Web Components
- **フォールバック**: なし（AudioWorklet前提設計）

### 機能要件
- **変調方式**: FSK (Frequency Shift Keying)
- **ボーレート**: 300bps - 4800bps (可変)
- **エラー訂正**: CRC-8, CRC-16, ハミング符号
- **プロトコル**: 独自プロトコル + 標準モデムプロトコル互換

## デモアプリケーション設計

### デモUI構成
```html
<!-- demo/index.html -->
<div class="demo-container">
  <header class="demo-header">
    <h1>WebAudio Modem Demo</h1>
    <div class="modulation-selector">
      <select id="modulation-type">
        <option value="fsk">FSK - Frequency Shift Keying</option>
        <option value="psk" disabled>PSK - Phase Shift Keying (Coming Soon)</option>
        <option value="qam" disabled>QAM - Quadrature Amplitude Modulation (Coming Soon)</option>
      </select>
    </div>
  </header>
  
  <main class="demo-main">
    <div class="control-panels">
      <div class="transmitter-panel">
        <h2>Transmitter</h2>
        <modulator-control></modulator-control>
      </div>
      
      <div class="receiver-panel">
        <h2>Receiver</h2>
        <demodulator-display></demodulator-display>
      </div>
    </div>
    
    <div class="visualization-area">
      <signal-monitor></signal-monitor>
      <spectrum-analyzer></spectrum-analyzer>
      <constellation-diagram></constellation-diagram>
    </div>
    
    <div class="comparison-area">
      <performance-comparison></performance-comparison>
    </div>
  </main>
</div>
```

### Web Components設計
```typescript
// 変調方式切り替え管理
class ModulationController extends HTMLElement {
  private currentModulator: IModulator;
  private availableModulators: Map<string, new() => IModulator>;
  
  switchModulation(type: string): void {
    const ModulatorClass = this.availableModulators.get(type);
    if (ModulatorClass) {
      this.currentModulator?.disconnect();
      this.currentModulator = new ModulatorClass();
      this.updateUI();
    }
  }
}

// パフォーマンス比較表示
class PerformanceComparison extends HTMLElement {
  private metrics: Map<string, SignalQuality[]>;
  
  updateComparison(modulationType: string, quality: SignalQuality): void {
    // リアルタイム比較チャート更新
  }
}
```

## アーキテクチャ設計

### コンポーネント構成
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   UI Layer      │    │  Protocol Layer  │    │ Signal Layer    │
│                 │    │                  │    │                 │
│ - Web Components│◄──►│ - Packet Handler │◄──►│ - IModulator    │
│ - Canvas Render │    │ - Error Control  │    │   - FSK Impl    │
│ - User Controls │    │ - Flow Control   │    │   - PSK Impl    │
│ - Demo Controls │    │                  │    │   - QAM Impl    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### モジュラー設計による拡張性
```typescript
// 変調方式ファクトリー
class ModulatorFactory {
  private static modulators = new Map<string, new() => IModulator<any>>([
    ['fsk', FSKModulator],
    ['psk', PSKModulator],  // 将来実装
    ['qam', QAMModulator],  // 将来実装
  ]);
  
  static create(type: string): IModulator<any> {
    const ModulatorClass = this.modulators.get(type);
    if (!ModulatorClass) {
      throw new Error(`Unsupported modulation type: ${type}`);
    }
    return new ModulatorClass();
  }
  
  static getAvailableTypes(): string[] {
    return Array.from(this.modulators.keys());
  }
}

// 使用例
const fskModulator = ModulatorFactory.create('fsk') as FSKModulator;
fskModulator.configure({
  sampleRate: 44100,
  baudRate: 300,
  markFrequency: 1650,
  spaceFrequency: 1850,
  startBit: 1,
  stopBit: 1.5,
  threshold: 0.0001
});

const pskModulator = ModulatorFactory.create('psk') as PSKModulator;
pskModulator.configure({
  sampleRate: 44100,
  baudRate: 300,
  carrierFrequency: 1700,
  constellation: 4, // QPSK
  symbolRate: 150,
  pulseShaping: 'rrc'
});
```

### データフロー
```
送信: Text → Encode → Packet → [IModulator] → AudioBuffer → Speaker
                                    ↑
                              FSK/PSK/QAM切り替え

受信: Mic → AudioData → [IModulator] → Packet → Decode → Text
                           ↑
                     FSK/PSK/QAM切り替え
```

## 開発環境セットアップ手順

### 1. 基本環境
```bash
# Node.js 18+ 必須
node --version  # v18.0.0+

# プロジェクト初期化
npm init -y
npm install -D typescript vite vitest @types/node
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
npm install -D @vitest/ui @vitest/coverage-v8
```

### 2. TypeScript設定
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "strict": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]
  }
}
```

### 3. Vite設定
```javascript
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  worker: {
    format: 'es'  // AudioWorklet用
  },
  test: {
    environment: 'jsdom'
  }
})
```

## 品質保証

### AudioWorkletテスト戦略

AudioWorkletは特殊な実行環境のため、多層的なテスト戦略を採用：

#### 1. DSPロジック分離テスト（Node.js）
```typescript
// src/dsp/fsk-core.ts - AudioWorkletから分離したロジック
export class FSKCore {
  modulate(bits: number[], config: FSKConfig): Float32Array {
    // コアDSPロジック（AudioWorklet非依存）
  }
  
  demodulate(samples: Float32Array, config: FSKConfig): number[] {
    // コアDSPロジック（AudioWorklet非依存）
  }
}

// tests/dsp.test.ts
import { FSKCore } from '../src/dsp/fsk-core';

describe('FSK Core DSP', () => {
  test('modulation accuracy', () => {
    const core = new FSKCore();
    const bits = [1, 0, 1, 1, 0];
    const samples = core.modulate(bits, defaultConfig);
    
    // 周波数解析・精度検証
    expect(samples).toHaveLength(expectedLength);
    expect(measureFrequency(samples)).toBeCloseTo(markFreq, 1);
  });
});
```

#### 2. AudioWorklet Mockテスト（jsdom）
```typescript
// tests/setup.ts
class MockAudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // モックした process メソッド
    return true;
  }
}

global.AudioWorkletProcessor = MockAudioWorkletProcessor;
global.registerProcessor = jest.fn();

// tests/worklet.test.ts
import '../worklets/fsk-worklet'; // WorkletProcessorの登録

describe('FSK AudioWorklet', () => {
  test('processor registration', () => {
    expect(registerProcessor).toHaveBeenCalledWith('fsk-processor', expect.any(Function));
  });
});
```

#### 3. 統合テスト（実ブラウザ環境）
```typescript
// tests/integration.test.ts
import { FSKModulator } from '../src/modulators/fsk';

describe('FSK Integration', async () => {
  let audioContext: AudioContext;
  let modulator: FSKModulator;
  
  beforeAll(async () => {
    // 実際のAudioContextを使用
    audioContext = new AudioContext();
    modulator = new FSKModulator(audioContext);
    await modulator.initialize();
  });
  
  test('end-to-end modulation/demodulation', async () => {
    const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    
    // 変調
    const audioBuffer = await modulator.modulate(testData);
    
    // 復調（実際の音声処理パイプライン）
    const decodedData = await modulator.demodulate(audioBuffer);
    
    expect(decodedData).toEqual(testData);
  });
});
```

#### 4. 実ブラウザダミーデータテスト（Vitest Browser Mode）
```typescript
// tests/browser-integration.test.ts
import { test, expect } from 'vitest';
import { FSKModulator } from '../src/modulators/fsk';

test('FSK modulation-demodulation with dummy audio', async () => {
  // 実際のAudioContextでダミーデータテスト
  const audioContext = new AudioContext();
  const modulator = new FSKModulator(audioContext);
  
  await modulator.initialize();
  
  const testMessage = "Hello World";
  const testData = new TextEncoder().encode(testMessage);
  
  // 変調：データ → 音声バッファ
  const audioBuffer = await modulator.modulate(testData);
  expect(audioBuffer.length).toBeGreaterThan(0);
  
  // AudioContextを通さずに直接復調（ダミーパス）
  const samples = audioBuffer.getChannelData(0);
  const decodedData = await modulator.demodulateFromSamples(samples);
  
  const decodedMessage = new TextDecoder().decode(decodedData);
  expect(decodedMessage).toBe(testMessage);
});

test('UI component interaction', async () => {
  // DOMレベルでのUI動作テスト
  document.body.innerHTML = `
    <div id="demo-container">
      <select id="modulation-type">
        <option value="fsk">FSK</option>
        <option value="psk">PSK</option>
      </select>
      <textarea id="input-text"></textarea>
      <button id="send-button">Send</button>
      <textarea id="output-text"></textarea>
    </div>
  `;
  
  const { ModulationController } = await import('../src/ui');
  const controller = new ModulationController();
  
  // 変調方式切り替えテスト
  const selector = document.getElementById('modulation-type') as HTMLSelectElement;
  selector.value = 'psk';
  selector.dispatchEvent(new Event('change'));
  
  expect(controller.getCurrentModulationType()).toBe('psk');
});
```

### テスト構成
```json
// package.json
{
  "scripts": {
    "test": "vitest",
    "test:node": "vitest --config vitest.node.config.ts",
    "test:browser": "vitest --config vitest.browser.config.ts"
  },
  "devDependencies": {
    "@vitest/browser": "^1.0.0",
    "jsdom": "^22.0.0"
  }
}
```

### テスト対象範囲
- **Node.js単体テスト**: DSPアルゴリズム、ユーティリティ関数、プロトコル処理
- **AudioWorklet Mock**: Worklet登録・基本動作の検証
- **ブラウザ統合テスト**: 実AudioContextでのダミーデータ送受信
- **UI動作テスト**: DOM操作、イベント処理、状態管理

### テスト除外項目
- **実音声E2E**: マイク・スピーカーを使った完全な音声送受信
- **ブラウザ間互換性**: 手動テストまたはCI環境での限定実行
- **パフォーマンス測定**: 開発時の手動プロファイリング

### コード品質
- **TypeScript**: 型安全性確保
- **ESLint**: コーディング規約遵守
- **コードカバレッジ**: 80%以上維持（DSPコア部分）

## リスクと対策

### 技術リスク
- **AudioWorklet制限**: 新しいAPI仕様に対応した実装
- **ブラウザ互換性**: モダンブラウザ前提の設計
- **リアルタイム処理**: バッファリング戦略最適化

### スケジュールリスク
- **技術調査時間**: バッファ期間確保
- **テスト工数**: 自動化によるコスト削減
- **仕様変更**: アジャイル開発手法採用

## 成功指標

### 技術指標
- **信号品質**: BER < 1e-5 (理想環境)
- **遅延**: エンドツーエンド < 100ms
- **安定性**: 1時間連続動作エラー率 < 0.1%

### ユーザビリティ指標
- **学習コスト**: 初回使用で5分以内に送信成功
- **操作性**: ワンクリックでファイル転送開始
- **視覚的フィードバック**: リアルタイム状態表示

この開発計画書に基づいて、段階的にモダンなWebAudio FSKモデムを実装していきます。各フェーズでの成果物を明確にし、継続的な品質向上を図ります。
