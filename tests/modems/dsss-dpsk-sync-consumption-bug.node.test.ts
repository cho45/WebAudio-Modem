/**
 * DSSS-DPSK 同期処理のサンプル消費問題テスト
 * 
 * 問題: 同期位置発見時に即座にサンプル消費するため、
 * フレーム復元失敗時に次の同期候補を探索できない
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';

describe('DSSS-DPSK Sync Consumption Bug', () => {
  const config = {
    sequenceLength: 15,
    seed: 21,
    samplesPerPhase: 23,
    sampleRate: 44100,
    carrierFreq: 10000,
    correlationThreshold: 0.5,
    peakToNoiseRatio: 4
  };

  /**
   * 偽の同期ピークと真の同期ピークを含む信号を生成
   */
  function createSignalWithFalsePeak(): Float32Array {
    // 1. 偽の同期パターン（相関ピークは検出されるが同期ワードが存在しない）
    // プリアンブルパターンに似ているが、正確な同期ワードを含まないランダムデータ
    const fakePattern = new Uint8Array(20); // 20ビットのランダムパターン
    for (let i = 0; i < fakePattern.length; i++) {
      fakePattern[i] = Math.random() > 0.5 ? 1 : 0;
    }
    // 最初の4ビットを正しいプリアンブルに近づけて相関を高める
    fakePattern[0] = 0; fakePattern[1] = 0; fakePattern[2] = 1; fakePattern[3] = 1;
    
    const fakeChips = modem.dsssSpread(fakePattern, config.sequenceLength, config.seed);
    const fakePhases = modem.dpskModulate(fakeChips);
    const fakeSamples = modem.modulateCarrier(
      fakePhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );

    // 2. ノイズ区間
    const noiseLength = config.samplesPerPhase * config.sequenceLength * 3;
    const noiseSamples = new Float32Array(noiseLength);
    for (let i = 0; i < noiseLength; i++) {
      noiseSamples[i] = (Math.random() - 0.5) * 0.1;
    }

    // 3. 真の同期パターン（正しいseedで完全なフレーム）
    const realReference = modem.generateSyncReference(config.sequenceLength, config.seed);
    
    // 完全なフレームを構築（プリアンブル + 同期ワード + データ）
    const preamble = new Uint8Array([0, 0, 0, 0]); // 4ビットプリアンブル
    const syncWord = new Uint8Array([1, 0, 1, 1, 0, 1, 0, 0]); // 8ビット同期ワード (0xB4)
    const userData = new Uint8Array([0, 1, 0, 1, 1, 0, 0, 1]); // 8ビットデータ
    
    const frameData = new Uint8Array(preamble.length + syncWord.length + userData.length);
    frameData.set(preamble, 0);
    frameData.set(syncWord, preamble.length);
    frameData.set(userData, preamble.length + syncWord.length);
    
    const realChips = modem.dsssSpread(frameData, config.sequenceLength, config.seed);
    const realPhases = modem.dpskModulate(realChips);
    const realSamples = modem.modulateCarrier(
      realPhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );

    // 4. 信号を結合: 偽ピーク + ノイズ + 真のピーク
    const totalLength = fakeSamples.length + noiseSamples.length + realSamples.length;
    const combinedSignal = new Float32Array(totalLength);
    
    let offset = 0;
    combinedSignal.set(fakeSamples, offset);
    offset += fakeSamples.length;
    
    combinedSignal.set(noiseSamples, offset);
    offset += noiseSamples.length;
    
    combinedSignal.set(realSamples, offset);

    return combinedSignal;
  }

  test('should reproduce sync consumption bug', () => {
    console.log('\n=== SYNC CONSUMPTION BUG REPRODUCTION TEST ===');
    
    const signal = createSignalWithFalsePeak();
    const demodulator = new DsssDpskDemodulator(config);
    
    console.log(`Created test signal: ${signal.length} samples`);
    
    // 信号を徐々に追加して同期プロセスを観察
    const chunkSize = 1024;
    let syncAcquiredCount = 0;
    let syncLostCount = 0;
    let totalBitsReceived = 0;
    
    for (let i = 0; i < signal.length; i += chunkSize) {
      const chunk = signal.slice(i, Math.min(i + chunkSize, signal.length));
      demodulator.addSamples(chunk);
      
      // 利用可能ビットを取得
      const bits = demodulator.getAvailableBits();
      totalBitsReceived += bits.length;
      
      const syncState = demodulator.getSyncState();
      
      if (syncState.locked) {
        syncAcquiredCount++;
        console.log(`Chunk ${Math.floor(i/chunkSize)}: SYNC LOCKED, correlation=${syncState.correlation.toFixed(4)}, bits=${bits.length}`);
      } else if (syncAcquiredCount > 0) {
        syncLostCount++;
        console.log(`Chunk ${Math.floor(i/chunkSize)}: SYNC LOST after ${syncAcquiredCount} locked chunks`);
        syncAcquiredCount = 0; // Reset for next sync attempt
      }
    }
    
    console.log(`\n=== RESULTS ===`);
    console.log(`Total sync acquisitions: ${syncAcquiredCount > 0 ? syncLostCount + 1 : syncLostCount}`);
    console.log(`Total sync losses: ${syncLostCount}`);
    console.log(`Total bits received: ${totalBitsReceived}`);
    console.log(`Final sync state: ${demodulator.getSyncState().locked ? 'LOCKED' : 'UNLOCKED'}`);
    
    // 現在の実装では偽ピークで同期してサンプル消費後、真のピークを見つけられない
    // 期待値: 少なくとも1回は同期確立するが、フレーム復元失敗で同期喪失
    // 修正後: 複数回の同期試行で最終的に真のピークで安定
    expect(totalBitsReceived).toBeGreaterThan(0); // 何らかのビットは受信される
  });

  test('should demonstrate sample consumption prevents retry - direct approach', () => {
    console.log('\n=== DIRECT SAMPLE CONSUMPTION BUG DEMONSTRATION ===');
    
    // より直接的なアプローチ：findSyncOffsetを直接呼び出して複数候補を確認
    
    // 第1候補：閾値を満たすが低い相関のパターン
    const weakPattern = new Uint8Array(12);
    // プリアンブルを模倣して相関を上げる
    weakPattern.set([0, 0, 0, 0, 1, 0, 1, 1], 0);
    
    const weakChips = modem.dsssSpread(weakPattern, config.sequenceLength, config.seed);
    const weakPhases = modem.dpskModulate(weakChips);
    const weakSamples = modem.modulateCarrier(
      weakPhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );
    
    // ノイズギャップ（短い）
    const shortGap = new Float32Array(config.samplesPerPhase * 2);
    for (let i = 0; i < shortGap.length; i++) {
      shortGap[i] = (Math.random() - 0.5) * 0.1;
    }
    
    // 第2候補：より強い相関のパターン
    const strongPattern = new Uint8Array([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1]); // より長いパターン
    const strongChips = modem.dsssSpread(strongPattern, config.sequenceLength, config.seed);
    const strongPhases = modem.dpskModulate(strongChips);
    const strongSamples = modem.modulateCarrier(
      strongPhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );
    
    // 信号結合
    const combinedSignal = new Float32Array(weakSamples.length + shortGap.length + strongSamples.length);
    let pos = 0;
    combinedSignal.set(weakSamples, pos);
    pos += weakSamples.length;
    combinedSignal.set(shortGap, pos);
    pos += shortGap.length;
    combinedSignal.set(strongSamples, pos);
    
    console.log(`Signal layout: weak(${weakSamples.length}) + gap(${shortGap.length}) + strong(${strongSamples.length}) = ${combinedSignal.length} samples`);
    
    // 直接findSyncOffsetをテストして複数候補を確認
    const reference = modem.generateSyncReference(config.sequenceLength, config.seed);
    
    const searchResult = modem.findSyncOffset(
      combinedSignal,
      reference,
      {
        samplesPerPhase: config.samplesPerPhase,
        sampleRate: config.sampleRate,
        carrierFreq: config.carrierFreq
      },
      50, // 大きな検索範囲
      {
        correlationThreshold: config.correlationThreshold,
        peakToNoiseRatio: config.peakToNoiseRatio
      }
    );
    
    console.log(`findSyncOffset result: found=${searchResult.isFound}, correlation=${searchResult.peakCorrelation.toFixed(4)}, offset=${searchResult.bestSampleOffset}`);
    
    if (searchResult.isFound) {
      // 検出位置を分析
      const detectedPosition = searchResult.bestSampleOffset;
      const weakPatternEnd = weakSamples.length;
      const strongPatternStart = weakSamples.length + shortGap.length;
      
      console.log(`Detection analysis:`);
      console.log(`  Detected at: ${detectedPosition}`);
      console.log(`  Weak pattern range: 0 - ${weakPatternEnd}`);
      console.log(`  Strong pattern start: ${strongPatternStart}`);
      
      if (detectedPosition < strongPatternStart) {
        console.log(`  *** BUG DEMONSTRATED: Detected weaker first candidate ***`);
        console.log(`  *** After consuming samples, stronger candidate would be lost ***`);
      } else {
        console.log(`  Detected stronger second candidate (expected)`);
      }
    }
    
    // デモデュレータでの実際の動作を確認
    const demodulator = new DsssDpskDemodulator(config);
    demodulator.addSamples(combinedSignal);
    
    const initialBits = demodulator.getAvailableBits();
    const initialSync = demodulator.getSyncState();
    
    console.log(`Demodulator result: locked=${initialSync.locked}, correlation=${initialSync.correlation.toFixed(4)}, bits=${initialBits.length}`);
    
    // 問題の証明：同期確立後に失敗した場合、より良い候補を探せない
    expect(searchResult.isFound).toBe(true); // 少なくとも1つの候補は見つかるはず
  });

  test('should verify correlation values for different patterns', () => {
    console.log('\n=== CORRELATION VALUE VERIFICATION ===');
    
    // 実際のフレーム構造を使用（プリアンブル + 同期ワード）
    const preamble = new Uint8Array([0, 0, 0, 0]); // 4ビットプリアンブル
    const syncWord = new Uint8Array([1, 0, 1, 1, 0, 1, 0, 0]); // 8ビット同期ワード (0xB4)
    const correctPattern = new Uint8Array(preamble.length + syncWord.length);
    correctPattern.set(preamble, 0);
    correctPattern.set(syncWord, preamble.length);
    
    // M-sequenceリファレンス（相関検出用）
    const correctReference = modem.generateSyncReference(config.sequenceLength, config.seed);
    
    // 正しいパターンでの相関
    const correctChips = modem.dsssSpread(correctPattern, config.sequenceLength, config.seed);
    const correctPhases = modem.dpskModulate(correctChips);
    const correctSamples = modem.modulateCarrier(
      correctPhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );
    
    // 間違ったパターンでの相関（異なる同期ワード）
    const wrongSyncWord = new Uint8Array([1, 1, 1, 0, 1, 0, 1, 1]); // 8ビット間違った同期ワード
    const wrongPattern = new Uint8Array(preamble.length + wrongSyncWord.length);
    wrongPattern.set(preamble, 0);
    wrongPattern.set(wrongSyncWord, preamble.length);
    
    const wrongChips = modem.dsssSpread(wrongPattern, config.sequenceLength, config.seed);
    const wrongPhases = modem.dpskModulate(wrongChips);
    const wrongSamples = modem.modulateCarrier(
      wrongPhases,
      config.samplesPerPhase,
      config.sampleRate,
      config.carrierFreq
    );
    
    // 相関値を確認
    const correctResult = modem.findSyncOffset(
      correctSamples,
      correctReference,
      {
        samplesPerPhase: config.samplesPerPhase,
        sampleRate: config.sampleRate,
        carrierFreq: config.carrierFreq
      },
      10,
      {
        correlationThreshold: config.correlationThreshold,
        peakToNoiseRatio: config.peakToNoiseRatio
      }
    );
    
    const wrongResult = modem.findSyncOffset(
      wrongSamples,
      correctReference,
      {
        samplesPerPhase: config.samplesPerPhase,
        sampleRate: config.sampleRate,
        carrierFreq: config.carrierFreq
      },
      10,
      {
        correlationThreshold: config.correlationThreshold,
        peakToNoiseRatio: config.peakToNoiseRatio
      }
    );
    
    console.log(`Correct pattern correlation: ${correctResult.peakCorrelation.toFixed(4)}, found: ${correctResult.isFound}`);
    console.log(`Wrong pattern correlation: ${wrongResult.peakCorrelation.toFixed(4)}, found: ${wrongResult.isFound}`);
    
    // 正しいパターンは高い相関を示すはず
    expect(correctResult.isFound).toBe(true);
    expect(correctResult.peakCorrelation).toBeGreaterThan(0.5);
    
    // 間違ったパターンでも閾値を超える可能性がある（これが問題の原因）
    console.log(`Wrong pattern exceeds threshold: ${wrongResult.peakCorrelation >= config.correlationThreshold}`);
  });
});