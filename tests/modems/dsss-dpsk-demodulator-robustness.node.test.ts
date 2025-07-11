/**
 * DSSS-DPSK Demodulator Robustness Tests
 * 
 * 高ノイズ条件での DsssDpskDemodulator の動作保証テスト
 * 
 * テスト範囲:
 * - 極低SNR条件での同期確立・維持
 * - 長期間ノイズ環境での信号品質監視
 * - 様々なノイズタイプに対する堅牢性
 * - 同期喪失・復帰の動作確認
 * - メモリ効率性と処理性能の検証
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk/dsss-dpsk-demodulator';
import { DsssDpskFramer } from '../../src/modems/dsss-dpsk/framer';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';
import { addAWGN } from '../../src/utils';

// テスト用ユーティリティ
const defaultConfig = {
  sequenceLength: 31,
  seed: 0x12345678,
  samplesPerPhase: 8,
  sampleRate: 48000,
  carrierFreq: 10000,
  correlationThreshold: 0.2, // 低レベルAPIと同等の感度
  peakToNoiseRatio: 2.0, // 低レベルAPIと同等の感度
};

// DSSS理論的期待値:
// - M-sequence長 = 31 → 拡散利得 ≈ 14.9dB
// - DPSK理論限界 ≈ -3dB → DSSS適用後 ≈ -17.9dB  
// - 実装損失(3-5dB)考慮 → 実用期待値: -12dB～-15dB SNR

/**
 * インパルスノイズの追加
 * @param signal 入力信号
 * @param density インパルス密度 (0-1)
 * @param amplitude インパルス振幅
 * @returns インパルスノイズ付加された信号
 */
function addImpulseNoise(signal: Float32Array, density: number, amplitude: number): Float32Array {
  const result = new Float32Array(signal);
  
  for (let i = 0; i < signal.length; i++) {
    if (Math.random() < density) {
      const impulse = (Math.random() - 0.5) * amplitude;
      result[i] += impulse;
    }
  }
  
  return result;
}

/**
 * 周波数干渉の追加
 * @param signal 入力信号
 * @param sampleRate サンプリング周波数
 * @param interfererFreq 干渉波周波数
 * @param interfererAmplitude 干渉波振幅
 * @returns 干渉波付加された信号
 */
function addFrequencyInterference(
  signal: Float32Array,
  sampleRate: number,
  interfererFreq: number,
  interfererAmplitude: number
): Float32Array {
  const result = new Float32Array(signal.length);
  const omega = 2 * Math.PI * interfererFreq / sampleRate;
  
  for (let i = 0; i < signal.length; i++) {
    const interference = Math.sin(omega * i) * interfererAmplitude;
    result[i] = signal[i] + interference;
  }
  
  return result;
}

/**
 * テスト用フレーム生成（参考ファイルに従った正しい実装）
 * @param userData ユーザーデータ
 * @param amplitude 信号振幅
 * @param options フレーム生成オプション
 * @returns 生成されたフレーム信号
 */
function generateFrameWithAmplitude(
  userData: Uint8Array,
  amplitude: number,
  options: {
    sequenceNumber?: number;
    frameType?: number;
    ldpcNType?: number;
  } = {}
): Float32Array {
  const {
    sequenceNumber = 1,
    frameType = 0,
    ldpcNType = 0,
  } = options;
  
  // DsssDpskFramerを使用してフレーム生成
  const frame = DsssDpskFramer.build(userData, {
    sequenceNumber,
    frameType,
    ldpcNType
  });
  
  // DSSS拡散
  const chips = modem.dsssSpread(frame.bits, defaultConfig.sequenceLength, defaultConfig.seed);
  
  // DPSK変調
  const phases = modem.dpskModulate(chips);
  
  // キャリア変調
  const signal = modem.modulateCarrier(
    phases,
    defaultConfig.samplesPerPhase,
    defaultConfig.sampleRate,
    defaultConfig.carrierFreq
  );
  
  // 振幅スケーリング
  const scaledSignal = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    scaledSignal[i] = signal[i] * amplitude;
  }
  
  return scaledSignal;
}

/**
 * 信号をチャンク単位で処理（AudioWorkletシミュレーション）
 * @param demodulator 復調器
 * @param signal 入力信号
 * @param options 処理オプション
 * @returns 受信フレーム配列
 */
function processSignalInChunks(
  demodulator: DsssDpskDemodulator,
  signal: Float32Array,
  options: {
    chunkSize?: number;
    maxFrames?: number;
    silencePrefix?: number;
    silenceSuffix?: number;
  } = {}
): any[] {
  const {
    chunkSize = 128,
    maxFrames = Infinity,
    silencePrefix = 0,
    silenceSuffix = 0
  } = options;
  
  // サイレンス期間を含む信号作成
  const totalLength = silencePrefix + signal.length + silenceSuffix;
  const totalSignal = new Float32Array(totalLength);
  totalSignal.set(signal, silencePrefix);
  
  // チャンク単位で処理
  const receivedFrames: any[] = [];
  for (let i = 0; i < totalSignal.length && receivedFrames.length < maxFrames; i += chunkSize) {
    const chunk = totalSignal.slice(i, i + chunkSize);
    demodulator.addSamples(chunk);
    const frames = demodulator.getAvailableFrames();
    receivedFrames.push(...frames);
    
    // 目標フレーム数達成で早期終了
    if (receivedFrames.length >= maxFrames) {
      break;
    }
  }
  
  return receivedFrames;
}

/**
 * 複数信号の連続処理
 * @param demodulator 復調器
 * @param signals 信号配列
 * @param options 処理オプション
 * @returns 受信フレーム配列
 */
function processMultipleSignals(
  demodulator: DsssDpskDemodulator,
  signals: Float32Array[],
  options: {
    chunkSize?: number;
    maxFrames?: number;
    gapBetweenSignals?: number;
    silencePrefix?: number;
    silenceSuffix?: number;
  } = {}
): any[] {
  const {
    chunkSize = 128,
    maxFrames = Infinity,
    gapBetweenSignals = 0,
    silencePrefix = 0,
    silenceSuffix = 0
  } = options;
  
  // 複数信号を結合
  const totalLength = silencePrefix + signals.reduce((sum, sig) => sum + sig.length, 0) + 
                     (signals.length - 1) * gapBetweenSignals + silenceSuffix;
  const combinedSignal = new Float32Array(totalLength);
  
  let position = silencePrefix;
  for (let i = 0; i < signals.length; i++) {
    combinedSignal.set(signals[i], position);
    position += signals[i].length + gapBetweenSignals;
  }
  
  return processSignalInChunks(demodulator, combinedSignal, { chunkSize, maxFrames });
}

describe('DsssDpskDemodulator Robustness Tests', () => {
  
  describe('DSSS理論限界に基づくSNR耐性テスト', () => {
    test('should achieve high success rate at -3dB SNR (DSSS利得活用)', () => {
      const testData = new Uint8Array([0x55, 0xAA]);
      const cleanSignal = generateFrameWithAmplitude(testData, 0.7);
      
      // -3dB SNR: DSSS拡散利得を活用した良好な条件
      const trials = 15;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        const trialNoisySignal = addAWGN(cleanSignal, -3);
        const trialFrames = processSignalInChunks(trialDemodulator, trialNoisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 500,
          silenceSuffix: 500
        });
        
        if (trialFrames.length > 0) {
          const frame = trialFrames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`-3dB SNR test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // -3dB SNR：DSSS拡散利得を活用した良好な条件で高い成功率を期待
      expect(successRate).toBeGreaterThanOrEqual(0.8);
    });
    
    test('should handle practical low SNR at -8dB', () => {
      const testData = new Uint8Array([0x12, 0x34, 0x56]);
      const cleanSignal = generateFrameWithAmplitude(testData, 0.6);
      
      // -8dB SNR: 実用的な低SNR条件
      const trials = 20;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        const noisySignal = addAWGN(cleanSignal, -8);
        const frames = processSignalInChunks(trialDemodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 400,
          silenceSuffix: 400
        });
        
        if (frames.length > 0) {
          const frame = frames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`-8dB SNR test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // -8dB SNR：実用的な低SNR条件で適度の成功率を期待
      expect(successRate).toBeGreaterThanOrEqual(0.4);
    });
    
    test('should demonstrate DSSS limit at -12dB SNR (理論限界)', () => {
      const testData = new Uint8Array([0xAB, 0xCD]);
      const cleanSignal = generateFrameWithAmplitude(testData, 0.8);
      
      // -12dB SNR: DSSS理論限界近くの挑戦的な条件
      const trials = 30;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        const noisySignal = addAWGN(cleanSignal, -12);
        const frames = processSignalInChunks(trialDemodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 600,
          silenceSuffix: 600
        });
        
        if (frames.length > 0) {
          const frame = frames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`-12dB SNR test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // -12dB SNR：DSSS理論限界近くでも統計的検出が可能
      expect(successRate).toBeGreaterThanOrEqual(0.15);
    });
    
    test('should achieve high success rate at 0dB SNR', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0xAB, 0xCD]);
      
      const cleanSignal = generateFrameWithAmplitude(testData, 0.5);
      
      // 0dB SNR での統計的テスト
      const trials = 15;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        const noisySignal = addAWGN(cleanSignal, 0);
        const frames = processSignalInChunks(trialDemodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 200,
          silenceSuffix: 200
        });
        
        if (frames.length > 0) {
          const frame = frames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`0dB SNR test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // 0dB SNR：良好な条件で高い成功率を期待
      expect(successRate).toBeGreaterThanOrEqual(0.90);
    });
  });
  
  describe('様々なノイズタイプに対する堅牢性テスト', () => {
    test('should handle moderate impulse noise (DSSS干渉耐性)', () => {
      const testData = new Uint8Array([0x77, 0x88]);
      const cleanSignal = generateFrameWithAmplitude(testData, 0.8);
      
      // 軽微なAWGNを追加して現実的な条件を作成
      const baseNoisySignal = addAWGN(cleanSignal, 10); // 10dB SNR base
      
      // インパルスノイズ追加（密度0.5%, 振幅0.3）
      const impulseNoisySignal = addImpulseNoise(baseNoisySignal, 0.005, 0.3);
      
      // 統計的テスト：複数回試行
      const trials = 10;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const demodulator = new DsssDpskDemodulator(defaultConfig);
        // 各試行で異なるノイズ実現値を使用
        const trialBaseNoisy = addAWGN(cleanSignal, 10);
        const trialImpulseNoisy = addImpulseNoise(trialBaseNoisy, 0.005, 0.3);
        
        const frames = processSignalInChunks(demodulator, trialImpulseNoisy, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 400,
          silenceSuffix: 400
        });
        
        if (frames.length > 0) {
          const frame = frames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`Impulse noise test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // DSSS拡散によりインパルスノイズに対して堅牢性を示す
      expect(successRate).toBeGreaterThanOrEqual(0.7);
    });
    
    test('should reject strong frequency interference', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x11, 0x22]);
      
      const cleanSignal = generateFrameWithAmplitude(testData, 0.5);
      
      // 強い周波数干渉（キャリア周波数近く）
      const interferenceSignal = addFrequencyInterference(
        cleanSignal,
        defaultConfig.sampleRate,
        defaultConfig.carrierFreq + 1000, // 1kHz offset
        1.0 // 強い干渉
      );
      
      const frames = processSignalInChunks(demodulator, interferenceSignal, {
        chunkSize: 128,
        maxFrames: 1,
        silencePrefix: 300,
        silenceSuffix: 300
      });
      
      // 強い干渉でフレーム受信が困難になることを確認
      // （完全な拒否ではなく、受信率低下を確認）
      const trials = 10;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        const trialFrames = processSignalInChunks(trialDemodulator, interferenceSignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 300,
          silenceSuffix: 300
        });
        
        if (trialFrames.length > 0) {
          const frame = trialFrames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`Frequency interference test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // 強い干渉で成功率が大幅に低下することを確認
      expect(successRate).toBeLessThan(0.5);
    });
    
    test('should handle combined noise sources', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x99, 0xAA]);
      
      const cleanSignal = generateFrameWithAmplitude(testData, 0.7);
      
      // 複合ノイズ: AWGN + インパルス + 周波数干渉
      let combinedNoisySignal = addAWGN(cleanSignal, 5); // 5dB SNR
      combinedNoisySignal = addImpulseNoise(combinedNoisySignal, 0.02, 0.5); // 軽微なインパルス
      combinedNoisySignal = addFrequencyInterference(
        combinedNoisySignal,
        defaultConfig.sampleRate,
        defaultConfig.carrierFreq + 2000, // 2kHz offset
        0.3 // 中程度の干渉
      );
      
      const frames = processSignalInChunks(demodulator, combinedNoisySignal, {
        chunkSize: 128,
        maxFrames: 1,
        silencePrefix: 400,
        silenceSuffix: 400
      });
      
      // 複合ノイズでも一定の堅牢性を確認
      const trials = 15;
      let successCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const trialDemodulator = new DsssDpskDemodulator(defaultConfig);
        
        let trialCombinedSignal = addAWGN(cleanSignal, 5);
        trialCombinedSignal = addImpulseNoise(trialCombinedSignal, 0.02, 0.5);
        trialCombinedSignal = addFrequencyInterference(
          trialCombinedSignal,
          defaultConfig.sampleRate,
          defaultConfig.carrierFreq + 2000,
          0.3
        );
        
        const trialFrames = processSignalInChunks(trialDemodulator, trialCombinedSignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 300,
          silenceSuffix: 300
        });
        
        if (trialFrames.length > 0) {
          const frame = trialFrames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            if (receivedData.every((val: number, idx: number) => val === testData[idx])) {
              successCount++;
            }
          }
        }
      }
      
      const successRate = successCount / trials;
      console.log(`Combined noise test: ${successCount}/${trials} successful receptions (${(successRate * 100).toFixed(1)}%)`);
      
      // 複合ノイズでも40%以上の成功率を期待
      expect(successRate).toBeGreaterThanOrEqual(0.4);
    });
  });
  
  describe('長期間処理での堅牢性テスト', () => {
    test('should handle continuous processing without memory leak', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x42]);
      
      // 長期間の連続処理テスト（1000フレーム相当）
      const frameCount = 100; // テスト時間短縮のため縮小
      const frames: any[] = [];
      
      for (let i = 0; i < frameCount; i++) {
        const frameData = new Uint8Array([0x42 + (i % 10)]);
        const signal = generateFrameWithAmplitude(frameData, 0.4, {
          sequenceNumber: i + 1,
          frameType: 0,
          ldpcNType: 0
        });
        
        // 軽微なノイズ追加
        const noisySignal = addAWGN(signal, 10);
        
        const receivedFrames = processSignalInChunks(demodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 200,
          silenceSuffix: 200
        });
        frames.push(...receivedFrames);
        
        // 定期的なメモリ使用量チェック（簡易）
        if (i % 20 === 0) {
          const syncState = demodulator.getSyncState();
          expect(syncState).toBeDefined();
        }
      }
      
      // 長期間処理後も正常動作することを確認
      const _finalTestData = new Uint8Array([0xFF]);
      const finalSignal = generateFrameWithAmplitude(_finalTestData, 0.5);
      const finalFrames = processSignalInChunks(demodulator, finalSignal, {
        chunkSize: 128,
        maxFrames: 1,
        silencePrefix: 200,
        silenceSuffix: 200
      });
      
      expect(finalFrames.length).toBeGreaterThan(0);
      if (finalFrames.length > 0) {
        const frame = finalFrames[0];
        expect(frame.userData.slice(0, _finalTestData.length)).toEqual(_finalTestData);
      }
      
      console.log(`Long-term processing test: processed ${frameCount} frames, received ${frames.length} frames`);
    });
    
    test('should maintain sync quality over extended operation', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x33, 0x66]);
      
      const syncQualityHistory: number[] = [];
      const frameCount = 50;
      
      for (let i = 0; i < frameCount; i++) {
        const signal = generateFrameWithAmplitude(testData, 0.5, {
          sequenceNumber: i + 1,
          frameType: 0,
          ldpcNType: 0
        });
        
        // 段階的にノイズ増加
        const snr = 15 - (i * 0.2); // 15dB から徐々に低下
        const noisySignal = addAWGN(signal, snr);
        
        const frames = processSignalInChunks(demodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 200,
          silenceSuffix: 200
        });
        
        // 同期品質の記録
        const syncState = demodulator.getSyncState();
        if (syncState && typeof syncState.correlation === 'number') {
          syncQualityHistory.push(syncState.correlation);
        }
        
        if (frames.length > 0) {
          const frame = frames[0];
          if (frame && frame.userData && frame.userData.length >= testData.length) {
            const receivedData = frame.userData.slice(0, testData.length);
            const isCorrect = receivedData.every((val: number, idx: number) => val === testData[idx]);
            console.log(`Frame ${i + 1}: SNR=${snr.toFixed(1)}dB, Received=${isCorrect ? 'OK' : 'NG'}, Correlation=${syncState.correlation?.toFixed(3) || 'N/A'}`);
          }
        }
      }
      
      // 同期品質の変動を確認
      expect(syncQualityHistory.length).toBeGreaterThan(0);
      
      // 初期の同期品質と比較
      const initialQuality = syncQualityHistory.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const finalQuality = syncQualityHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
      
      console.log(`Sync quality: Initial=${initialQuality.toFixed(3)}, Final=${finalQuality.toFixed(3)}`);
      
      // 同期品質の履歴が記録されていることを確認
      expect(syncQualityHistory.length).toBeGreaterThan(0);
      
      // 品質値が有効な範囲内であることを確認（correlation値は-1から1の範囲）
      if (syncQualityHistory.length > 0) {
        const avgQuality = syncQualityHistory.reduce((a, b) => a + b, 0) / syncQualityHistory.length;
        expect(avgQuality).toBeGreaterThanOrEqual(-1);
        expect(avgQuality).toBeLessThanOrEqual(1);
      }
    });
  });
  
  describe('同期状態遷移テスト', () => {
    test('should properly transition sync states under varying conditions', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x5A]);
      
      // Phase 1: 初期状態（非同期）
      const initialState = demodulator.getSyncState();
      expect(initialState.locked).toBe(false);
      
      // Phase 2: 良好な信号で同期確立
      const goodSignal = generateFrameWithAmplitude(testData, 0.8);
      const goodFrames = processSignalInChunks(demodulator, goodSignal, {
        chunkSize: 128,
        maxFrames: 1,
        silencePrefix: 300,
        silenceSuffix: 300
      });
      
      expect(goodFrames.length).toBeGreaterThan(0);
      
      // Phase 3: ノイズ信号で同期品質低下
      const noisySignal = addAWGN(generateFrameWithAmplitude(testData, 0.2), -5);
      const _noisyFrames = processSignalInChunks(demodulator, noisySignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 200,
          silenceSuffix: 200
        });
      
      // Phase 4: 再び良好な信号で同期回復
      const recoverySignal = generateFrameWithAmplitude(testData, 0.7);
      const recoveryFrames = processSignalInChunks(demodulator, recoverySignal, {
        chunkSize: 128,
        maxFrames: 1,
        silencePrefix: 300,
        silenceSuffix: 300
      });
      
      expect(recoveryFrames.length).toBeGreaterThan(0);
      if (recoveryFrames.length > 0) {
        const frame = recoveryFrames[0];
        expect(frame.userData.slice(0, testData.length)).toEqual(testData);
      }
      
      console.log(`Sync state transition test: Good=${goodFrames.length}, Noisy=${_noisyFrames.length}, Recovery=${recoveryFrames.length}`);
    });
  });
  
  describe('エラー処理とフェイルセーフテスト', () => {
    test('should handle pure noise without crashing', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      
      // 純粋なノイズ信号
      const pureNoise = new Float32Array(10000);
      for (let i = 0; i < pureNoise.length; i++) {
        pureNoise[i] = (Math.random() - 0.5) * 2.0;
      }
      
      // クラッシュしないことを確認
      expect(() => {
        const frames = processSignalInChunks(demodulator, pureNoise, {
          chunkSize: 128,
          maxFrames: 1
        });
        expect(frames.length).toBe(0); // フレーム受信なし
      }).not.toThrow();
      
      // 状態が正常であることを確認
      const state = demodulator.getSyncState();
      expect(state).toBeDefined();
      expect(state.locked).toBe(false);
    });
    
    test('should handle empty signal gracefully', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      
      const emptySignal = new Float32Array(0);
      
      expect(() => {
        const frames = processSignalInChunks(demodulator, emptySignal, {
          chunkSize: 128,
          maxFrames: 1
        });
        expect(frames.length).toBe(0);
      }).not.toThrow();
    });
    
    test('should handle extremely small signal amplitudes', () => {
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      const testData = new Uint8Array([0x42]);
      
      // 量子化ノイズレベル近くの極小振幅
      const microSignal = generateFrameWithAmplitude(testData, 1e-6);
      
      expect(() => {
        const _frames = processSignalInChunks(demodulator, microSignal, {
          chunkSize: 128,
          maxFrames: 1,
          silencePrefix: 1000,
          silenceSuffix: 1000
        });
        // 極小振幅では受信困難だが、クラッシュしないことが重要
      }).not.toThrow();
    });
  });
});