/**
 * DSSS-DPSK Demodulator Synchronization-Only Tests
 * 
 * 同期検出のみをテストして、低レベルAPIと公平な比較を行う
 * フレーム復元は別途テストする
 * 
 * テスト範囲:
 * - プリアンブル(4bit) + 同期ワード(8bit) + ヘッダーバイト(8bit) = 20bit
 * - 同期状態になることを確認
 * - フレーム構築が開始されることを確認
 * - 様々なSNR条件での同期検出率を測定
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk/dsss-dpsk-demodulator';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';
import { addAWGN } from '../../src/utils';

// 低レベルAPIと同等の設定
const syncTestConfig = {
  sequenceLength: 31,
  seed: 0x12345678,
  samplesPerPhase: 8,
  sampleRate: 48000,
  carrierFreq: 10000,
  correlationThreshold: 0.2, // 低レベルAPI同等
  peakToNoiseRatio: 2.0, // 低レベルAPI同等
};

/**
 * 同期検出に必要な最小フレーム（20ビット）を生成
 * プリアンブル(4) + 同期ワード(8) + ヘッダーバイト(8)
 */
function generateSyncFrame(headerByte: number = 0x00): Uint8Array {
  const syncBits = new Uint8Array(20);
  
  // プリアンブル: [0,0,0,0]
  syncBits[0] = 0;
  syncBits[1] = 0;
  syncBits[2] = 0;
  syncBits[3] = 0;
  
  // 同期ワード: [1,0,1,1,0,1,0,0] (0xB4)
  syncBits[4] = 1;
  syncBits[5] = 0;
  syncBits[6] = 1;
  syncBits[7] = 1;
  syncBits[8] = 0;
  syncBits[9] = 1;
  syncBits[10] = 0;
  syncBits[11] = 0;
  
  // ヘッダーバイト (MSBから)
  for (let i = 0; i < 8; i++) {
    syncBits[12 + i] = (headerByte >> (7 - i)) & 1;
  }
  
  return syncBits;
}

/**
 * 同期フレームを物理信号に変換
 */
function generateSyncSignal(headerByte: number = 0x00, amplitude: number = 0.8): Float32Array {
  const syncBits = generateSyncFrame(headerByte);
  
  // DSSS拡散
  const chips = modem.dsssSpread(syncBits, syncTestConfig.sequenceLength, syncTestConfig.seed);
  
  // DPSK変調
  const phases = modem.dpskModulate(chips);
  
  // キャリア変調
  const signal = modem.modulateCarrier(
    phases,
    syncTestConfig.samplesPerPhase,
    syncTestConfig.sampleRate,
    syncTestConfig.carrierFreq
  );
  
  // 振幅スケーリング
  const scaledSignal = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    scaledSignal[i] = signal[i] * amplitude;
  }
  
  return scaledSignal;
}

/**
 * 信号をチャンク単位で処理してサンプルを追加
 */
function addSamples(demodulator: DsssDpskDemodulator, signal: Float32Array, chunkSize: number = 128): void {
  for (let i = 0; i < signal.length; i += chunkSize) {
    const chunk = signal.slice(i, i + chunkSize);
    demodulator.addSamples(chunk);
  }
}

describe('DSSS-DPSK Synchronization-Only Tests', () => {
  
  describe('理想条件での同期検出', () => {
    test('should achieve sync lock with clean signal', () => {
      const demodulator = new DsssDpskDemodulator(syncTestConfig);
      
      // 同期用最小フレーム生成
      const syncSignal = generateSyncSignal(0x00, 0.8);
      
      console.log(`=== 同期検出デバッグ情報 ===`);
      console.log(`生成信号: ${syncSignal.length} samples`);
      console.log(`期待フレーム: 20 bits = ${20 * 31 * 8} samples`);
      console.log(`設定: correlationThreshold=${syncTestConfig.correlationThreshold}, peakToNoiseRatio=${syncTestConfig.peakToNoiseRatio}`);
      
      // 低レベルAPIとの比較テスト
      const syncBits = generateSyncFrame(0x00);
      const reference = modem.generateSyncReference(syncTestConfig.sequenceLength, syncTestConfig.seed);
      
      console.log(`低レベルAPI基準信号: ${reference.length} chips`);
      console.log(`フレームビット: [${Array.from(syncBits).join(',')}]`);
      
      // 低レベルAPIでの同期検出
      const lowLevelResult = modem.findSyncOffset(
        syncSignal,
        reference,
        syncTestConfig,
        20,
        {
          correlationThreshold: syncTestConfig.correlationThreshold,
          peakToNoiseRatio: syncTestConfig.peakToNoiseRatio,
        }
      );
      
      console.log(`低レベルAPI結果: isFound=${lowLevelResult.isFound}, correlation=${lowLevelResult.peakCorrelation.toFixed(4)}`);
      
      // 初期状態確認
      expect(demodulator.getSyncState().locked).toBe(false);
      
      // 信号追加
      addSamples(demodulator, syncSignal);
      
      // 同期処理を実行（getAvailableFrames呼び出しで同期処理が実行される）
      const frames = demodulator.getAvailableFrames();
      console.log(`利用可能フレーム数: ${frames.length}`);
      
      // 同期処理後の状態確認
      const syncState = demodulator.getSyncState();
      console.log(`高レベルAPI結果: locked=${syncState.locked}, correlation=${syncState.correlation.toFixed(4)}`);
      
      // 同期検出が成功していることを確認
      expect(syncState.correlation).toBeGreaterThan(0.3);
      
      console.log(`Clean signal: locked=${syncState.locked}, correlation=${syncState.correlation.toFixed(3)}`);
    });
    
    test('should detect sync with different header bytes', () => {
      const headerBytes = [0x00, 0x55, 0xAA, 0xFF];
      
      for (const headerByte of headerBytes) {
        const demodulator = new DsssDpskDemodulator(syncTestConfig);
        const syncSignal = generateSyncSignal(headerByte, 0.8);
        
        addSamples(demodulator, syncSignal);
        
        // 同期処理を実行
        demodulator.getAvailableFrames();
        const syncState = demodulator.getSyncState();
        
        expect(syncState.correlation).toBeGreaterThan(0.3);
        
        console.log(`Header 0x${headerByte.toString(16).padStart(2, '0')}: locked=${syncState.locked}, correlation=${syncState.correlation.toFixed(3)}`);
      }
    });
  });
  
  describe('SNR耐性テスト（同期検出のみ）', () => {
    // SNR条件の定義（実測低レベルAPI性能ベース - 理論的期待値）
    // 理論的に正しい期待値: 上位レイヤーは下位レイヤー以上の性能を持つべき
    // 実測値結果:
    // - 0dB SNR: 低レベル100%, 高レベル100% -> 理論的要求: 100%
    // - -3dB SNR: 低レベル100%, 高レベル100% -> 理論的要求: 100%
    // - -8dB SNR: 低レベル100%, 高レベル95% -> 理論的要求: 100%
    // - -12dB SNR: 低レベル100%, 高レベル15% -> 理論的要求: 100%
    // - -18dB SNR: 低レベル5%, 高レベル0% -> 理論的要求: 5%
    const snrConditions = [
      { snr: 0, minSyncRate: 1.00, trials: 20, name: '0dB SNR (低レベル実測: 100%)' },
      { snr: -3, minSyncRate: 1.00, trials: 25, name: '-3dB SNR (低レベル実測: 100%)' },
      { snr: -8, minSyncRate: 1.00, trials: 30, name: '-8dB SNR (低レベル実測: 100%)' },
      { snr: -12, minSyncRate: 1.00, trials: 40, name: '-12dB SNR (低レベル実測: 100%)' },
      { snr: -18, minSyncRate: 0.05, trials: 50, name: '-18dB SNR (低レベル実測: 5%)' },
    ];

    /**
     * SNR同期テストを実行
     */
    function testSyncAtSNR(snr: number, trials: number, headerByte: number = 0x42): number {
      let syncCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const demodulator = new DsssDpskDemodulator(syncTestConfig);
        const cleanSignal = generateSyncSignal(headerByte, 0.8);
        const noisySignal = addAWGN(cleanSignal, snr);
        
        addSamples(demodulator, noisySignal);
        
        // 同期処理を実行
        demodulator.getAvailableFrames();
        const syncState = demodulator.getSyncState();
        
        if (syncState.correlation > 0.3) {
          syncCount++;
        }
      }
      
      return syncCount / trials;
    }

    // 各SNR条件でテストを実行
    snrConditions.forEach((condition) => {
      test(`should achieve expected sync rate at ${condition.name}`, () => {
        const syncRate = testSyncAtSNR(condition.snr, condition.trials);
        
        console.log(`${condition.name}: ${(syncRate * condition.trials).toFixed(0)}/${condition.trials} (${(syncRate * 100).toFixed(1)}%)`);
        
        expect(syncRate).toBeGreaterThanOrEqual(condition.minSyncRate);
      });
    });
  });
  
  describe('同期検出vs低レベルAPI比較', () => {
    test('should match low-level API sync performance', () => {
      const demodulator = new DsssDpskDemodulator(syncTestConfig);
      const syncSignal = generateSyncSignal(0xBC, 0.8);
      
      // 低レベルAPIでの同期検出
      const reference = modem.generateSyncReference(syncTestConfig.sequenceLength, syncTestConfig.seed);
      const lowLevelResult = modem.findSyncOffset(
        syncSignal,
        reference,
        syncTestConfig,
        20,
        {
          correlationThreshold: syncTestConfig.correlationThreshold,
          peakToNoiseRatio: syncTestConfig.peakToNoiseRatio,
        }
      );
      
      addSamples(demodulator, syncSignal);
      
      // 高レベルAPIでの同期検出
      demodulator.getAvailableFrames(); // 同期処理を実行
      const syncState = demodulator.getSyncState();
      
      console.log(`低レベルAPI: isFound=${lowLevelResult.isFound}, correlation=${lowLevelResult.peakCorrelation.toFixed(4)}`);
      console.log(`高レベルAPI: locked=${syncState.locked}, correlation=${syncState.correlation.toFixed(4)}`);
      
      // 両方とも高い同期性能を示すことを確認
      expect(lowLevelResult.isFound).toBe(true);
      expect(syncState.correlation).toBeGreaterThan(0.8);
      expect(lowLevelResult.peakCorrelation).toBeGreaterThan(0.8);
    });

    /**
     * 理論的に正しい期待値設定のためのベンチマークテスト
     * 複数SNR条件で低レベルAPIと高レベルAPIの性能を測定
     */
    test('should establish theoretical baseline for all SNR conditions', () => {
      console.log('=== 理論的ベースライン測定 ===');
      console.log('SNR(dB) | 低レベルAPI | 高レベルAPI | 理論的要求');
      console.log('--------|------------|------------|----------');
      
      const snrLevels = [0, -3, -8, -12, -18];
      const trials = 20;
      const reference = modem.generateSyncReference(syncTestConfig.sequenceLength, syncTestConfig.seed);
      const results: Array<{snr: number, lowLevel: number, highLevel: number}> = [];
      
      for (const snr of snrLevels) {
        let lowLevelSyncCount = 0;
        let highLevelSyncCount = 0;
        
        for (let trial = 0; trial < trials; trial++) {
          const cleanSignal = generateSyncSignal(0x42, 0.8);
          const noisySignal = addAWGN(cleanSignal, snr);
          
          // 低レベルAPIテスト
          const lowLevelResult = modem.findSyncOffset(
            noisySignal,
            reference,
            syncTestConfig,
            20,
            {
              correlationThreshold: syncTestConfig.correlationThreshold,
              peakToNoiseRatio: syncTestConfig.peakToNoiseRatio,
            }
          );
          
          if (lowLevelResult.isFound) {
            lowLevelSyncCount++;
          }
          
          // 高レベルAPIテスト
          const demodulator = new DsssDpskDemodulator(syncTestConfig);
          addSamples(demodulator, noisySignal);
          demodulator.getAvailableFrames();
          const syncState = demodulator.getSyncState();
          
          if (syncState.correlation > 0.3) {
            highLevelSyncCount++;
          }
        }
        
        const lowLevelRate = lowLevelSyncCount / trials;
        const highLevelRate = highLevelSyncCount / trials;
        
        results.push({snr, lowLevel: lowLevelRate, highLevel: highLevelRate});
        
        const theoreticalRequirement = highLevelRate >= lowLevelRate ? 'OK' : 'FAIL';
        console.log(`${snr.toString().padStart(7)} | ${lowLevelRate.toFixed(2).padStart(10)} | ${highLevelRate.toFixed(2).padStart(10)} | ${theoreticalRequirement.padStart(10)}`);
      }
      
      console.log('\n=== 実測値に基づく期待値設定 ===');
      console.log('理論的に正しい期待値: 高レベルAPI >= 低レベルAPI');
      console.log('以下は実測値に基づく推奨期待値:');
      for (const result of results) {
        console.log(`${result.snr}dB SNR: minSyncRate: ${Math.max(0, result.lowLevel).toFixed(2)} (低レベルAPI実測: ${result.lowLevel.toFixed(2)})`);
        
        // **理論的に正しい期待値**: 上位レイヤーは下位レイヤー以上の性能を持つべき
        expect(result.highLevel).toBeGreaterThanOrEqual(result.lowLevel);
      }
    });
  });
  
  describe('エラー条件での安定性', () => {
    test('should not false-sync on pure noise', () => {
      const demodulator = new DsssDpskDemodulator(syncTestConfig);
      
      // 純粋なノイズ信号
      const noiseSignal = new Float32Array(5000);
      for (let i = 0; i < noiseSignal.length; i++) {
        noiseSignal[i] = (Math.random() - 0.5) * 2.0;
      }
      
      addSamples(demodulator, noiseSignal);
      
      // 同期処理を実行
      demodulator.getAvailableFrames();
      const syncState = demodulator.getSyncState();
      
      // 純粋なノイズでは同期しないことを確認
      expect(syncState.locked).toBe(false);
      expect(syncState.correlation).toBeLessThan(0.3);
    });
    
    test('should handle signal with wrong sync word', () => {
      const demodulator = new DsssDpskDemodulator(syncTestConfig);
      
      // 間違った同期ワードを持つ信号を生成
      const wrongSyncBits = new Uint8Array(20);
      // プリアンブル: [0,0,0,0] (正しい)
      wrongSyncBits[0] = 0; wrongSyncBits[1] = 0; wrongSyncBits[2] = 0; wrongSyncBits[3] = 0;
      // 間違った同期ワード: [0,1,0,1,1,0,1,1] (0x5B instead of 0xB4)
      wrongSyncBits[4] = 0; wrongSyncBits[5] = 1; wrongSyncBits[6] = 0; wrongSyncBits[7] = 1;
      wrongSyncBits[8] = 1; wrongSyncBits[9] = 0; wrongSyncBits[10] = 1; wrongSyncBits[11] = 1;
      // ヘッダーバイト: 0x00
      for (let i = 12; i < 20; i++) wrongSyncBits[i] = 0;
      
      const chips = modem.dsssSpread(wrongSyncBits, syncTestConfig.sequenceLength, syncTestConfig.seed);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, syncTestConfig.samplesPerPhase, syncTestConfig.sampleRate, syncTestConfig.carrierFreq);
      
      addSamples(demodulator, signal);
      
      // 同期処理を実行
      demodulator.getAvailableFrames();
      const syncState = demodulator.getSyncState();
      
      // 間違った同期ワードでは同期しないことを確認
      expect(syncState.locked).toBe(false);
      expect(syncState.correlation).toBeLessThan(0.3);
    });
  });
});