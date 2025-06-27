---
```mermaid
graph TD
    A[アプリ/上位層] --> B[FEC/Framer]
    B --> C{DSSS層\n(任意)}
    C --> D[MODEM層\n(FSK/BPSK/QPSK等)]
    D --> E[物理層(音声)]
```
---

# 高度なエラー訂正を持つ復調器・データフレーム伝送の設計メモ（2025/06整理）

## 目的

ノイズ・歪みの多い環境下でも高信頼なデータ伝送を実現するため、
- ソフト判定復調（Soft-Decision Demodulation）
- 前方誤り訂正（FEC）
- データフレーミング（フレーム境界検出・誤り検出・再送制御）
を組み合わせたストリーム指向の設計・実装指針をまとめる。

---

## 設計要求要件（要約）

- ストリーム処理・低遅延（小単位サンプルで逐次処理、即時通知）
- 変調・復調方式の差し替え容易性（FSK/BPSK/QPSK等、1シンボル=1bit/2bit...）
- FEC・フレーマの抽象化と統合
- データフレーム境界検出の堅牢性（プレアンブル/SFD/CRC等）
- エラー通知・再送制御のフック
- パラメータ自動調整（SNR/レート/信号レベル等）
- テスト容易性・ロギング
- ビット列はUint8Array（バイト単位）で効率的に扱い、有効データ長（バイト長）はDataFrameFramerが管理

---

## 推奨アーキテクチャと責務分離（概要）

- 各層は「バイト列（Uint8Array）」を基本単位として受け渡し、端数ビット（パディング）はmodulatorが付加し、demodulatorがそのまま復元する。
- DataFrameFramerはフレームヘッダ等で有効データ長（バイト長）を必ず管理し、パディング分を除去して正しいデータを上位層に渡す。
- 各層の責務は下記インターフェース例のコメントに明記。

---

## データフロー（受信側例）

1. `process(samples)`
2. → SoftDecisionDemodulator.demodulate
3. → FECDecoder.decode
4. → DataFrameFramer.extractFrames
5. → onFrameコールバックで上位層へ通知

- 各段階でbitLengthを明示的に管理・伝播
- 1シンボル=複数ビットのパッキング・アンパッキングやパディング付加はModulator/SoftDecisionDemodulatorの責務。ただし、ビット列は常にUint8Array（バイト単位）で扱い、端数ビット（パディング）はmodulatorが付加し、demodulatorがそのまま復元する。DataFrameFramerはデータフレームのヘッダ等で「有効データ長（バイト長）」を必ず管理し、パディング分を除去して正しいデータを上位層に渡す責務を持つ。
- バッファリング・部分フレーム対応も責務分離

---

## インターフェース例（責務コメント付き・バイト単位設計）

```ts
// 変調器: バイト列を変調方式に応じて信号化。端数ビットはパディングして出力する責務。
// bitsPerSymbolはインスタンス設定プロパティ（API引数ではない）
interface Modulator {
  readonly bitsPerSymbol: number;
  modulate(payload: Uint8Array): Float32Array;
}

// 復調器: 信号からsoft value列（バイト列）を復元するのみ。フレーム境界検出は責務外。
// bitsPerSymbolはインスタンス設定プロパティ（API引数ではない）
interface SoftDecisionDemodulator {
  readonly bitsPerSymbol: number;
  demodulate(samples: Float32Array): Uint8Array;
}

// FrameEncoder: ペイロードをフレーム化し、FEC符号化まで一括で行う（送信側統合層）。
interface FrameEncoder {
  encodeFrame(payload: Uint8Array): Uint8Array;
}

// FrameDecoder: soft value列からフレーム境界検出・FEC復号・フレーム抽出まで一括で行う（受信側統合層）。
// 連続したsoft value列から複数フレームを抽出可能。部分データは内部バッファリング。
interface FrameDecoder {
  /**
   * soft value列を追加投入し、復号済みフレームがあれば返す（なければ空配列）。
   * 内部でフレーム境界検出・FEC復号・フレーム抽出を一括管理。
   */
  process(samples: Float32Array): Uint8Array[];
  /**
   * 内部状態を初期化
   */
  reset(): void;
}
```

---

## 備考・設計指針
- number[]ではなくUint8Array/Float32Arrayで統一
- bitsPerSymbolは変調方式ごとに明示
- FECやフレーマは部分バイト対応・bitLength管理必須
- ストリーム処理はバッファリング・部分フレーム対応を内部で吸収
- 責務分離を徹底し、各層のテスト容易性・交換性を担保

- FECとフレーマ（DataFrameFramer）は、特に受信側で密結合な処理が不可避であり、実装・テストも一体化（FrameDecoder/FrameEncoder等）するのが現実的。
- インターフェース分離は理論上の責務分離や将来の交換性のためだが、実装・テストは統合クラスで行うのが自然。
- テストも「FEC＋フレーマ一体型」の統合テストが主となる。

---

## 同期（プリアンブル検出）の重要性と代表的なアルゴリズム

- FEC復号（特にブロック型やViterbi復号）を正しく機能させるには、まず「ビット/シンボル境界の同期」が不可欠。
- 同期が取れていないと、FEC復号の前提が崩れ、誤り訂正が正しく機能しない。
- ストリーム型FECでも、同期が取れていないと誤りが連鎖しやすくなる。

### 代表的なプリアンブル同期アルゴリズム・戦略

- **相関法（Correlation Method）**
  - 既知のビット列（プリアンブル）と受信信号の相関値を計算し、ピーク位置で同期を取る。
  - ソフト判定値を使うことでSNRの低い環境でも堅牢。

- **自己相関法（Autocorrelation）**
  - プリアンブルが繰り返しパターンの場合、自己相関を利用して周期的なピークで同期。

- **マルチレベルしきい値法**
  - 相関値が複数のしきい値を超えた場合のみ同期成立とみなすことで誤検出を低減。

- **連続一致カウント法**
  - 一定数以上連続してプリアンブル一致が観測された場合のみ同期成立とする。

- **複数候補追跡・再同期戦略**
  - 誤検出や未検出時に複数の同期候補を同時に追跡し、最適なものを選択。
  - データ途中で同期が外れた場合の再同期処理も重要。

- **ソフト判定値の活用**
  - バイナリ一致だけでなく、soft value（信頼度）を加味した相関計算で堅牢性向上。

- **外部クロック同期**
  - 送信側・受信側が共通のクロック源（例：GPS時刻、NTP、専用クロック線）を参照し、
    例えば「毎秒の立ち上がりをビット/フレーム境界」とみなす。
  - 放送・衛星通信・一部の有線通信などで利用。

- **タイムスロット同期（TDMA等）**
  - システム全体で「時刻スロット」を共有し、各スロットの開始をビット/フレーム境界とする。

#### 備考
- クロック同期方式は信号内容に依存せず、高速・確実な同期が可能。
- クロック精度・ジッタ・ドリフトや外部同期信号の配線・配信が課題となる。
- 一般的な無線・インターネット通信では信号内容による同期（プリアンブル等）が主流だが、特定用途では外部クロック同期も有効。

### 備考
- プリアンブルは十分な長さ・ランダム性・自己相関特性を持つパターンが望ましい。
- 同期処理はFEC復号の前段で必ず実施し、同期成立後にFEC復号・フレーム抽出を行う。
- 実装上は「同期→FEC復号→フレーム抽出」の順で処理フローを設計する。

---

## 参考文献・リンク
- [Viterbi Algorithm](https://en.wikipedia.org/wiki/Viterbi_algorithm)
- [LDPC Codes](https://en.wikipedia.org/wiki/Low-density_parity-check_code)
- [Soft-decision decoding](https://en.wikipedia.org/wiki/Soft-decision_decoding)

---

## 代表的なFECアルゴリズムと必要情報

- **ブロック符号**（Reed-Solomon, BCH, Hamming など）
  - 固定長のデータブロックごとに冗長ビットを付加し、誤り訂正を行う。
  - 必要情報: ブロック長（データ長・符号長）、ブロック境界、有効データ長（パディング情報）
  - 例: RS(255,223) はデータ223バイト＋パリティ32バイト＝255バイトで1ブロック

- **畳み込み符号＋Viterbi復号**
  - データをシフトレジスタで逐次符号化し、Viterbiアルゴリズムで復号。
  - 必要情報: 符号化レート、生成多項式、データ開始・終了位置（トレリス終端処理）
  - ストリーム復号可能だが、フレーム単位でリセットやflushが必要な場合あり

- **LDPC符号（Low-Density Parity-Check）**
  - 疎なパリティ検査行列を用いたブロック符号。高い訂正能力。
  - 必要情報: パリティ検査行列（H行列）、符号長・データ長、ブロック境界

- **ターボ符号**
  - 2つ以上の畳み込み符号とインタリーバを組み合わせた高性能FEC。
  - 必要情報: 符号化パラメータ（インタリーバ、レート等）、ブロック境界

- **共通して必要な情報**
  - ブロック/フレーム境界、有効データ長、FECパラメータ（符号長・レート等）、soft value列（ソフト判定復号時）

---

## 直接スペクトラム拡散（DSSS）による高度な誤り訂正

### DSSSの理論的基礎と実装方針

直接スペクトラム拡散は、従来のFSK/DPSK変調に比べて大幅に向上した誤り訂正能力と干渉耐性を提供する。

#### 基本動作原理
1. **拡散（Spreading）**: 元データビットを疑似ランダム符号（PN符号）で拡散
2. **変調**: 拡散後の信号をBPSKで変調して送信
3. **逆拡散（Despreading）**: 受信側で同じPN符号を用いて逆拡散
4. **復調**: 元のデータビットを復元

#### 主要な技術的利点
- **処理利得**: 拡散率に応じたSNR改善
  - 31チップ拡散: 15dB利得
  - 127チップ拡散: 21dB利得
  - 511チップ拡散: 27dB利得
- **干渉耐性**: 狭帯域干渉に対する堅牢性
- **多重アクセス**: 異なるPN符号による複数信号の同時伝送
- **セキュリティ**: PN符号を知らない限り復調困難

### 既存WebAudio-Modemアーキテクチャとの統合設計

DSSSは既存の`IModulator`インターフェースに完全に統合可能な設計とする。

```typescript
// DSSS設定インターフェース
interface DSSSConfig extends BaseModulatorConfig {
  chipRate: number;              // チップレート（Hz）
  spreadingFactor: number;       // 拡散率（PN符号長）
  pnSequence?: number[];         // PN系列（手動指定時）
  pnType: 'maxLength' | 'gold' | 'walsh' | 'manual';
  carrierFrequency: number;      // 搬送波周波数
  syncThreshold: number;         // 同期検出閾値
  acquisitionMode: 'sliding' | 'matched'; // 同期取得方式
}

// DSSS実装クラス（IModulatorインターフェース準拠）
class DSSSModulator extends BaseModulator<DSSSConfig> {
  readonly name = 'DSSS';
  readonly type = 'PSK' as ModulationType;
  
  // 変調: データビット → 拡散 → BPSK変調
  async modulateData(data: Uint8Array): Promise<Float32Array> {
    const bits = this.bytesToBits(data);
    const spreadBits = this.spreadData(bits);
    return this.bpskModulate(spreadBits);
  }
  
  // 復調: BPSK復調 → 逆拡散 → データビット
  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    const softBits = this.bpskDemodulate(samples);
    const despreadBits = this.despreadData(softBits);
    return this.bitsToBytes(despreadBits);
  }
}
```

### PN系列生成アルゴリズム設計

#### 1. M系列生成器（最大長系列）
線形フィードバックシフトレジスタ（LFSR）による実装。

```typescript
class MaxLengthSequenceGenerator {
  private lfsr: LinearFeedbackShiftRegister;
  
  // M系列の特性: 周期 = 2^n - 1, 優れた自己相関特性
  generateSequence(length: number, polynomial: number): number[] {
    const sequence: number[] = [];
    const periods = Math.pow(2, length) - 1;
    
    for (let i = 0; i < periods; i++) {
      sequence.push(this.lfsr.shift());
    }
    return sequence;
  }
}

// LFSR実装
class LinearFeedbackShiftRegister {
  private register: number;
  
  constructor(private config: { taps: number[], seed: number, length: number }) {
    this.register = config.seed || 1; // 0は避ける
  }
  
  shift(): number {
    const output = this.register & 1; // LSB出力
    
    // フィードバック計算
    let feedback = 0;
    for (const tap of this.config.taps) {
      feedback ^= (this.register >> tap) & 1;
    }
    
    // レジスタシフト
    this.register = (this.register >> 1) | (feedback << (this.config.length - 1));
    return output;
  }
}
```

#### 2. Gold符号生成器（多重アクセス対応）
2つのM系列のXORによる相互相関特性改善。

```typescript
class GoldSequenceGenerator {
  // 2つのM系列の組み合わせで相互相関を最小化
  generateGoldSequence(preferred1: number[], preferred2: number[]): number[] {
    const sequence: number[] = [];
    for (let i = 0; i < preferred1.length; i++) {
      sequence.push(preferred1[i] ^ preferred2[i]);
    }
    return sequence;
  }
}
```

#### 3. Walsh符号生成器（直交符号）
アダマール行列による完全直交符号生成。

```typescript
class WalshSequenceGenerator {
  // Hadamard行列による直交符号
  generateWalshSequence(length: number, index: number): number[] {
    const matrix = this.generateHadamardMatrix(length);
    return matrix[index].map(x => x > 0 ? 1 : 0);
  }
}
```

### 同期取得アルゴリズム

#### 1. スライディング相関法
```typescript
class SlidingCorrelator {
  acquireSync(samples: Float32Array, pnSequence: number[]): { 
    synchronized: boolean, 
    offset: number, 
    correlation: number 
  } {
    let maxCorrelation = 0;
    let bestOffset = -1;
    
    // 1チップずつ位相をずらして相関計算
    for (let offset = 0; offset < samples.length - pnSequence.length; offset++) {
      const correlation = this.calculateCorrelation(samples, pnSequence, offset);
      
      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        bestOffset = offset;
      }
    }
    
    return {
      synchronized: maxCorrelation > this.syncThreshold,
      offset: bestOffset,
      correlation: maxCorrelation
    };
  }
}
```

#### 2. 遅延ロックループ（符号追跡）
```typescript
class DelayLockedLoop {
  // Early-Prompt-Late相関による高精度符号追跡
  trackCode(earlyChips: number[], promptChips: number[], lateChips: number[]): {
    codePhaseError: number,
    trackingError: number
  } {
    const earlyCorr = this.correlate(earlyChips, this.referenceCode);
    const lateCorr = this.correlate(lateChips, this.referenceCode);
    
    const discriminator = earlyCorr - lateCorr;
    const codePhaseError = discriminator / (earlyCorr + lateCorr);
    
    return {
      codePhaseError,
      trackingError: Math.abs(codePhaseError)
    };
  }
}
```

### 実装計画（4段階）

#### 第1段階: 基礎コンポーネント
**実装ファイル**:
- `src/dsp/pn-sequences.ts` - PN系列生成器
- `src/dsp/bpsk.ts` - BPSK変復調エンジン
- `src/dsp/correlators.ts` - 相関演算器

#### 第2段階: DSSS基本機能
**実装ファイル**:
- `src/modems/dsss.ts` - DSSSメイン実装
- `src/modems/dsss-config.ts` - DSSS設定定義

#### 第3段階: 高度な同期・信号品質機能
- マルチ閾値同期アルゴリズム
- 符号追跡ループ（Code Tracking Loop）
- SNR・BER推定
- 適応閾値制御

#### 第4段階: 統合・最適化・拡張機能
- XModem Transport層での動作確認
- WebAudio APIとの統合
- 性能最適化（FFTベース高速相関）
- Gold符号による多重アクセス対応

### 期待される性能指標

**処理利得**:
- 31チップ: 15dB利得
- 127チップ: 21dB利得
- 511チップ: 27dB利得

**同期性能**:
- 取得時間: < 2秒（SNR > 0dB時）
- 追跡精度: ±0.1チップ
- 誤検出率: < 10^-6

**計算負荷**:
- リアルタイム率: > 95%（48kHz, 127チップ）
- メモリ使用量: < 10MB

### DSSSと従来FECとの組み合わせ

DSSSは物理層での処理利得を提供し、上位層のFEC（Reed-Solomon、畳み込み符号等）と組み合わせることで、段階的な誤り訂正が可能となる。

**組み合わせ効果**:
1. **DSSS**: 物理層での干渉・フェージング耐性
2. **FEC**: 符号層での系統的誤り訂正
3. **ARQ**: トランスポート層での確実性保証

この階層的アプローチにより、極めて劣悪な通信環境でも高い信頼性を確保できる。

---

## 音声帯域DSSSの現実的性能分析

### 音声デバイスの実際の帯域制約

実際の音声通信で利用可能な帯域幅は理論値よりも大幅に狭い：

```typescript
interface AudioDeviceConstraints {
  telephoneQuality: {
    bandwidth: 3100;        // 300Hz - 3.4kHz
    description: "電話、VoIP";
    practicalChipRate: 1722; // Hz
  };
  
  pcBuiltinAudio: {
    bandwidth: 7900;        // 100Hz - 8kHz  
    description: "PC内蔵、安価なヘッドセット";
    practicalChipRate: 4385; // Hz
  };
  
  standardHeadset: {
    bandwidth: 14950;       // 50Hz - 15kHz
    description: "標準的なヘッドセット";
    practicalChipRate: 8296; // Hz
  };
  
  highQualityAudio: {
    bandwidth: 19980;       // 20Hz - 20kHz
    description: "高品質オーディオ機器";
    practicalChipRate: 11096; // Hz
  };
}
```

**実用チップレート計算式**:
```
実用チップレート = (帯域幅 × 2) ÷ (1 + ロールオフ率) × 0.75
ロールオフ率 = 0.35 (Root Raised Cosineフィルタ標準値)
0.75係数 = 隣接干渉・ハードウェア特性考慮
```

### 現実的なDSSS性能表

#### 電話品質 (3.1kHz帯域)
```
実用チップレート: 1,722 Hz

拡散率7   → 246 bps  (8.5dB利得)
拡散率15  → 114 bps  (11.8dB利得)  
拡散率31  → 55 bps   (14.9dB利得)
拡散率63  → 27 bps   (18.0dB利得)
拡散率127 → 13 bps   (21.0dB利得)
```

#### PC標準 (7.9kHz帯域)  
```
実用チップレート: 4,385 Hz

拡散率7   → 626 bps  (8.5dB利得)
拡散率15  → 292 bps  (11.8dB利得)
拡散率31  → 141 bps  (14.9dB利得) 
拡散率63  → 69 bps   (18.0dB利得)
拡散率127 → 34 bps   (21.0dB利得)
```

#### 標準ヘッドセット (15kHz帯域)
```
実用チップレート: 8,296 Hz

拡散率7   → 1,185 bps (8.5dB利得)
拡散率15  → 553 bps   (11.8dB利得)
拡散率31  → 267 bps   (14.9dB利得)
拡散率63  → 131 bps   (18.0dB利得) 
拡散率127 → 65 bps    (21.0dB利得)
```

#### 高品質オーディオ (20kHz帯域)
```
実用チップレート: 11,096 Hz

拡散率7   → 1,585 bps (8.5dB利得)
拡散率15  → 739 bps   (11.8dB利得)
拡散率31  → 357 bps   (14.9dB利得)
拡散率63  → 176 bps   (18.0dB利得)
拡散率127 → 87 bps    (21.0dB利得)
```

### 用途別推奨設定

#### IoT/センサーデータ通信（高信頼性優先）
```typescript
const iotSensorConfig = {
  targetDevice: "PC標準 (7.9kHz)",
  chipRate: 4385,
  spreadingFactor: 63,
  dataRate: 69, // bps
  processingGain: 18.0, // dB
  useCase: "温度センサー、制御信号",
  reliability: "極高",
  batteryLife: "重要"
};
```

#### テキスト通信（バランス重視）
```typescript
const textMessagingConfig = {
  targetDevice: "標準ヘッドセット (15kHz)",
  chipRate: 8296,
  spreadingFactor: 31,
  dataRate: 267, // bps
  processingGain: 14.9, // dB
  useCase: "チャット、ショートメッセージ",
  reliability: "高",
  latency: "許容可能"
};
```

#### ファイル転送（速度優先）
```typescript
const fileTransferConfig = {
  targetDevice: "高品質オーディオ (20kHz)",
  chipRate: 11096,
  spreadingFactor: 15,
  dataRate: 739, // bps
  processingGain: 11.8, // dB
  useCase: "小サイズファイル、音声データ",
  reliability: "中",
  throughput: "重要"
};
```

### 既存システムとの性能比較

```typescript
interface SystemComparison {
  currentFSK: {
    dataRate: 1200; // bps
    processingGain: 0; // dB
    interferenceResistance: "低";
    implementation: "完成";
    complexity: "低";
  };
  
  dsssHighSpeed: {
    dataRate: 739; // bps (20kHz, 拡散率15)
    processingGain: 11.8; // dB
    interferenceResistance: "中";
    implementation: "要開発";
    complexity: "高";
    speedRatio: 0.62; // vs FSK
  };
  
  dsssBalanced: {
    dataRate: 267; // bps (15kHz, 拡散率31)
    processingGain: 14.9; // dB  
    interferenceResistance: "高";
    implementation: "要開発";
    complexity: "高";
    speedRatio: 0.22; // vs FSK
  };
  
  dsssHighReliability: {
    dataRate: 69; // bps (7.9kHz, 拡散率63)
    processingGain: 18.0; // dB
    interferenceResistance: "極高";
    implementation: "要開発";
    complexity: "高";
    speedRatio: 0.06; // vs FSK
  };
}
```

### 実装における現実的制約

#### 技術的課題と解決策
```typescript
interface ImplementationChallenges {
  synchronization: {
    problem: "初期同期の困難さ（コード位相 + 搬送波位相）";
    solutions: [
      "階層的同期アルゴリズム",
      "既存プリアンブル活用",
      "二段階取得戦略"
    ];
    complexity: "高";
  };
  
  computationalLoad: {
    problem: "リアルタイム相関計算の負荷";
    solutions: [
      "FFTベース高速相関",
      "間引き処理による負荷軽減",
      "並列処理アーキテクチャ"
    ];
    complexity: "中";
  };
  
  deviceVariability: {
    problem: "音声デバイス特性のばらつき";
    solutions: [
      "適応的帯域検出",
      "自動チップレート調整",
      "デバイス特性学習"
    ];
    complexity: "中";
  };
  
  webAudioConstraints: {
    problem: "128サンプル単位処理制約";
    solutions: [
      "効率的バッファリング",
      "状態管理最適化",
      "部分処理対応"
    ];
    complexity: "中";
  };
}
```

### 段階的実装戦略

#### フェーズ1: 概念実証（2-3週間）
```typescript
const phase1 = {
  objective: "DSSSの基本動作確認",
  specifications: {
    chipRate: 4000, // Hz
    spreadingFactor: 15,
    dataRate: 266, // bps
    pnSequence: "M系列（15チップ）",
    modulation: "BPSK",
    bandwidth: "8kHz"
  },
  deliverables: [
    "PN系列生成器",
    "基本的な拡散・逆拡散",
    "シンプルなBPSK変復調",
    "概念実証デモ"
  ]
};
```

#### フェーズ2: 実用プロトタイプ（1-2ヶ月）
```typescript
const phase2 = {
  objective: "実用的なDSSSシステム",
  specifications: {
    adaptiveChipRate: true,
    spreadingFactors: [7, 15, 31],
    autoNegotiation: true,
    advancedSync: "階層的同期",
    qualityMonitoring: "SNR/BER推定"
  },
  deliverables: [
    "適応制御システム",
    "堅牢な同期アルゴリズム",
    "性能監視機能",
    "統合テストスイート"
  ]
};
```

#### フェーズ3: 製品レベル（2-3ヶ月）
```typescript
const phase3 = {
  objective: "製品品質のDSSSシステム",
  specifications: {
    goldCodes: true,
    multipleAccess: "複数ユーザー同時通信",
    errorCorrection: "FEC統合",
    security: "暗号化拡張",
    optimization: "リアルタイム性能"
  },
  deliverables: [
    "Gold符号生成器",
    "多重アクセス機能",
    "完全統合システム",
    "製品ドキュメント"
  ]
};
```

### DSSSの現実的価値評価

#### 利点
- **干渉耐性**: 10-20dBの処理利得により劣悪環境でも通信可能
- **セキュリティ**: PN符号による暗号化効果
- **多重アクセス**: 複数信号の同時伝送
- **将来性**: 次世代通信技術の基盤

#### トレードオフ
- **速度低下**: 既存FSKの20-60%に減速
- **複雑性**: 実装・デバッグ・保守コストの増加
- **計算負荷**: リアルタイム処理要求の増大
- **同期困難**: 初期接続時間の延長

#### 推奨用途
- **IoT通信**: 低レート・高信頼性が要求される用途
- **制御信号**: 産業制御・ロボット通信
- **緊急通信**: 災害時・妨害環境下での通信
- **セキュア通信**: 盗聴対策が必要な用途

音声帯域DSSSは、**特定用途では既存FSKを大幅に上回る価値**を提供するが、汎用的な高速データ通信には適さない。用途を適切に選択することで、その真価を発揮できる技術である。

---

（このメモは今後の設計・実装・議論のたたき台とする）
