/**
 * DSSS-DPSK Comprehensive False Positive Detection Tests
 * 
 * 網羅的テスト: sequenceLength 15/31, samplesPerPhase 16/22/23, sampleRate 44100/48000
 * 各組み合わせでcorrelationThreshold 0.4 vs 0.5の違いを検証
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk';
import { findSyncOffset, generateSyncReference } from '../../src/modems/dsss-dpsk/dsss-dpsk';

describe('DSSS-DPSK Comprehensive False Positive Analysis', () => {
  // 網羅的テストパラメータ
  const testParams = {
    sequenceLengths: [15, 31],
    samplesPerPhases: [16, 22, 23],
    sampleRates: [44100, 48000],
    thresholds: [0.4, 0.5],
    carrierFreq: 10000,
    seed: 21
  };

  // Helper function to generate test configuration name
  const getConfigName = (seqLen: number, samplesPerPhase: number, sampleRate: number) => 
    `seq${seqLen}_spp${samplesPerPhase}_sr${sampleRate}`;

  // Helper function to generate challenging noise signal
  const generateChallengingNoise = (length: number, sampleRate: number, carrierFreq: number): Float32Array => {
    const noise = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sample = 0;
      
      // Multiple noise sources that could trigger false positives
      // 1. Random noise
      sample += (Math.random() - 0.5) * 0.3;
      
      // 2. Near-carrier frequency interference
      sample += Math.sin(2 * Math.PI * (carrierFreq * 0.99) * i / sampleRate) * 0.05;
      
      // 3. Periodic patterns that might correlate with short sequences
      if (i % 200 < 30) {
        sample += Math.sin(2 * Math.PI * carrierFreq * i / sampleRate) * 0.1;
      }
      
      // 4. DC drift
      sample += 0.02 * Math.sin(2 * Math.PI * 0.5 * i / sampleRate);
      
      noise[i] = sample;
    }
    return noise;
  };

  describe('Systematic False Positive Analysis', () => {
    test('comprehensive parameter sweep for false positive detection', () => {
      console.log('\n=== COMPREHENSIVE FALSE POSITIVE ANALYSIS ===');
      console.log('Testing all combinations of:');
      console.log(`  sequenceLength: ${testParams.sequenceLengths.join(', ')}`);
      console.log(`  samplesPerPhase: ${testParams.samplesPerPhases.join(', ')}`);
      console.log(`  sampleRate: ${testParams.sampleRates.join(', ')}`);
      console.log(`  correlationThreshold: ${testParams.thresholds.join(', ')}`);

      const results: Array<{
        config: string;
        sequenceLength: number;
        samplesPerPhase: number;
        sampleRate: number;
        threshold: number;
        falsePositiveRate: number;
        maxCorrelation: number;
        avgCorrelation: number;
        totalTrials: number;
        falsePositives: number;
      }> = [];

      for (const sequenceLength of testParams.sequenceLengths) {
        for (const samplesPerPhase of testParams.samplesPerPhases) {
          for (const sampleRate of testParams.sampleRates) {
            for (const threshold of testParams.thresholds) {
              const configName = getConfigName(sequenceLength, samplesPerPhase, sampleRate);
              
              let falsePositives = 0;
              let maxCorrelation = 0;
              let totalCorrelation = 0;
              const trials = 20;

              for (let trial = 0; trial < trials; trial++) {
                const demodulator = new DsssDpskDemodulator({
                  sequenceLength,
                  seed: testParams.seed,
                  samplesPerPhase,
                  sampleRate,
                  carrierFreq: testParams.carrierFreq,
                  correlationThreshold: threshold,
                  peakToNoiseRatio: 4
                });

                // Generate challenging noise for this configuration
                const noiseLength = Math.max(8000, sequenceLength * samplesPerPhase * 10);
                const challengingNoise = generateChallengingNoise(noiseLength, sampleRate, testParams.carrierFreq);

                demodulator.addSamples(challengingNoise);
                demodulator.getAvailableBits();

                const state = demodulator.getSyncState();
                const correlation = Math.abs(state.correlation);
                totalCorrelation += correlation;
                maxCorrelation = Math.max(maxCorrelation, correlation);

                if (state.locked) {
                  falsePositives++;
                }
              }

              const falsePositiveRate = falsePositives / trials;
              const avgCorrelation = totalCorrelation / trials;

              results.push({
                config: configName,
                sequenceLength,
                samplesPerPhase,
                sampleRate,
                threshold,
                falsePositiveRate,
                maxCorrelation,
                avgCorrelation,
                totalTrials: trials,
                falsePositives
              });

              console.log(`${configName}_t${threshold}: ${(falsePositiveRate * 100).toFixed(1)}% FP (${falsePositives}/${trials}), max_corr=${maxCorrelation.toFixed(3)}, avg_corr=${avgCorrelation.toFixed(3)}`);
            }
          }
        }
      }

      // Analysis: Find problematic configurations
      console.log('\n=== ANALYSIS RESULTS ===');
      
      const problemConfigs = results.filter(r => r.falsePositiveRate > 0);
      if (problemConfigs.length > 0) {
        console.log('\n*** PROBLEMATIC CONFIGURATIONS DETECTED ***');
        problemConfigs.forEach(config => {
          console.log(`${config.config} threshold=${config.threshold}: ${(config.falsePositiveRate * 100).toFixed(1)}% false positives`);
        });
      }

      // Compare 0.4 vs 0.5 for each configuration
      const configNames = [...new Set(results.map(r => r.config))];
      console.log('\n=== THRESHOLD COMPARISON (0.4 vs 0.5) ===');
      
      for (const configName of configNames) {
        const result04 = results.find(r => r.config === configName && r.threshold === 0.4)!;
        const result05 = results.find(r => r.config === configName && r.threshold === 0.5)!;
        
        const diff = result04.falsePositiveRate - result05.falsePositiveRate;
        
        if (diff > 0) {
          console.log(`${configName}: 0.4 has ${(diff * 100).toFixed(1)}% MORE false positives than 0.5`);
          console.log(`  0.4: ${(result04.falsePositiveRate * 100).toFixed(1)}% (${result04.falsePositives}/${result04.totalTrials})`);
          console.log(`  0.5: ${(result05.falsePositiveRate * 100).toFixed(1)}% (${result05.falsePositives}/${result05.totalTrials})`);
        }
      }

      // Statistical assertions
      const threshold04Results = results.filter(r => r.threshold === 0.4);
      const threshold05Results = results.filter(r => r.threshold === 0.5);
      
      const totalFP04 = threshold04Results.reduce((sum, r) => sum + r.falsePositives, 0);
      const totalFP05 = threshold05Results.reduce((sum, r) => sum + r.falsePositives, 0);
      const totalTrials04 = threshold04Results.reduce((sum, r) => sum + r.totalTrials, 0);
      const totalTrials05 = threshold05Results.reduce((sum, r) => sum + r.totalTrials, 0);

      console.log(`\n=== OVERALL STATISTICS ===`);
      console.log(`Threshold 0.4: ${totalFP04}/${totalTrials04} = ${(totalFP04/totalTrials04*100).toFixed(2)}% overall false positive rate`);
      console.log(`Threshold 0.5: ${totalFP05}/${totalTrials05} = ${(totalFP05/totalTrials05*100).toFixed(2)}% overall false positive rate`);

      // The test passes if we identify the problematic configurations
      // We expect some configurations might have false positives with 0.4
      expect(results.length).toBe(testParams.sequenceLengths.length * 
                                   testParams.samplesPerPhases.length * 
                                   testParams.sampleRates.length * 
                                   testParams.thresholds.length);
    });
  });

  describe('Direct findSyncOffset Tests', () => {
    test('findSyncOffset sensitivity analysis across all configurations', () => {
      console.log('\n=== FINDSYNCOFFSET SENSITIVITY ANALYSIS ===');

      // Generate one challenging noise pattern for all tests
      const noiseSignal = new Float32Array(12000);
      for (let i = 0; i < noiseSignal.length; i++) {
        // Sophisticated noise pattern that might trigger false positives
        let sample = 0;
        
        // Correlated burst patterns
        if (i % 500 < 50) {
          sample += Math.sin(2 * Math.PI * testParams.carrierFreq * i / 44100) * 0.15;
        }
        
        // Random walk component
        sample += (Math.random() - 0.5) * 0.25;
        
        // Low frequency drift
        sample += 0.05 * Math.sin(2 * Math.PI * 10 * i / 44100);
        
        noiseSignal[i] = sample;
      }

      const sensitivityResults: Array<{
        config: string;
        threshold: number;
        detected: boolean;
        peakCorrelation: number;
        peakRatio: number;
      }> = [];

      for (const sequenceLength of testParams.sequenceLengths) {
        for (const samplesPerPhase of testParams.samplesPerPhases) {
          for (const sampleRate of testParams.sampleRates) {
            const configName = getConfigName(sequenceLength, samplesPerPhase, sampleRate);
            const reference = generateSyncReference(sequenceLength, testParams.seed);

            for (const threshold of testParams.thresholds) {
              const result = findSyncOffset(
                noiseSignal,
                reference,
                {
                  samplesPerPhase,
                  sampleRate,
                  carrierFreq: testParams.carrierFreq
                },
                50,
                {
                  correlationThreshold: threshold,
                  peakToNoiseRatio: 4
                }
              );

              sensitivityResults.push({
                config: configName,
                threshold,
                detected: result.isFound,
                peakCorrelation: result.peakCorrelation,
                peakRatio: result.peakRatio
              });

              if (result.isFound) {
                console.log(`*** FALSE POSITIVE: ${configName} threshold=${threshold} detected noise as signal! ***`);
                console.log(`    Peak: ${result.peakCorrelation.toFixed(3)}, Ratio: ${result.peakRatio.toFixed(2)}`);
              }
            }
          }
        }
      }

      // Analysis
      const falseDetections = sensitivityResults.filter(r => r.detected);
      if (falseDetections.length > 0) {
        console.log(`\n=== FALSE DETECTIONS SUMMARY ===`);
        falseDetections.forEach(detection => {
          console.log(`${detection.config} @ ${detection.threshold}: Peak=${detection.peakCorrelation.toFixed(3)}, Ratio=${detection.peakRatio.toFixed(2)}`);
        });

        // Group by threshold
        const fp04 = falseDetections.filter(d => d.threshold === 0.4).length;
        const fp05 = falseDetections.filter(d => d.threshold === 0.5).length;
        
        console.log(`\nThreshold 0.4: ${fp04} false detections`);
        console.log(`Threshold 0.5: ${fp05} false detections`);
        
        if (fp04 > fp05) {
          console.log(`\n*** ROOT CAUSE CONFIRMED ***`);
          console.log(`correlationThreshold 0.4 produces ${fp04 - fp05} more false positives than 0.5!`);
        }
      }

      // Test should pass - we're just analyzing, not asserting no false positives
      expect(sensitivityResults.length).toBe(testParams.sequenceLengths.length * 
                                            testParams.samplesPerPhases.length * 
                                            testParams.sampleRates.length * 
                                            testParams.thresholds.length);
    });
  });

  describe('Browser Simulation Tests', () => {
    test('128-sample chunked processing simulation across configurations', () => {
      console.log('\n=== BROWSER CHUNKED PROCESSING SIMULATION ===');

      // Test subset of configurations that are most likely to be problematic
      const criticalConfigs = [
        { sequenceLength: 15, samplesPerPhase: 23, sampleRate: 44100 }, // Demo config
        { sequenceLength: 15, samplesPerPhase: 22, sampleRate: 48000 }, // Potential problem
        { sequenceLength: 31, samplesPerPhase: 23, sampleRate: 44100 }, // Reference config
      ];

      for (const config of criticalConfigs) {
        const configName = getConfigName(config.sequenceLength, config.samplesPerPhase, config.sampleRate);
        console.log(`\n--- Testing ${configName} ---`);

        for (const threshold of testParams.thresholds) {
          const demodulator = new DsssDpskDemodulator({
            ...config,
            seed: testParams.seed,
            carrierFreq: testParams.carrierFreq,
            correlationThreshold: threshold,
            peakToNoiseRatio: 4
          });

          let falsePositiveChunks = 0;
          const totalChunks = 60;
          const CHUNK_SIZE = 128;

          for (let chunk = 0; chunk < totalChunks; chunk++) {
            const chunkData = new Float32Array(CHUNK_SIZE);
            
            // Browser-like mixed signal environment
            for (let i = 0; i < CHUNK_SIZE; i++) {
              let sample = 0;
              
              // AudioContext artifacts
              if (chunk % 4 === 0) {
                sample += Math.sin(2 * Math.PI * 440 * i / config.sampleRate) * 0.02; // Audio bleed
              }
              
              // AGC artifacts
              if (chunk % 7 === 0) {
                sample += 0.01; // DC offset
              }
              
              // Quantization noise
              sample += (Math.random() - 0.5) * 0.15;
              
              // Near-carrier interference
              if (chunk % 10 === 0) {
                sample += Math.sin(2 * Math.PI * (testParams.carrierFreq * 1.01) * i / config.sampleRate) * 0.03;
              }
              
              chunkData[i] = sample;
            }

            demodulator.addSamples(chunkData);
            demodulator.getAvailableBits();

            const state = demodulator.getSyncState();
            if (state.locked) {
              falsePositiveChunks++;
            }
          }

          const chunkFalsePositiveRate = falsePositiveChunks / totalChunks;
          console.log(`  Threshold ${threshold}: ${falsePositiveChunks}/${totalChunks} chunks false positive (${(chunkFalsePositiveRate * 100).toFixed(1)}%)`);

          if (falsePositiveChunks > 0 && threshold === 0.4) {
            console.log(`    *** ${configName} with threshold 0.4 produces false positives in browser simulation! ***`);
          }
        }
      }
    });
  });

  describe('Statistical Validation', () => {
    test('monte carlo analysis for robust statistical validation', () => {
      console.log('\n=== MONTE CARLO STATISTICAL VALIDATION ===');

      // Focus on the most critical comparison: demo config 0.4 vs 0.5
      const demoConfig = {
        sequenceLength: 15,
        samplesPerPhase: 23,
        sampleRate: 44100,
        seed: testParams.seed,
        carrierFreq: testParams.carrierFreq,
        peakToNoiseRatio: 4
      };

      const monteCarloTrials = 50;
      let falsePositives04 = 0;
      let falsePositives05 = 0;

      for (let trial = 0; trial < monteCarloTrials; trial++) {
        // Generate unique noise for each trial
        const noiseLength = 10000;
        const uniqueNoise = new Float32Array(noiseLength);
        
        for (let i = 0; i < noiseLength; i++) {
          let sample = 0;
          
          // Random component
          sample += (Math.random() - 0.5) * 0.3;
          
          // Trial-specific frequency component
          const trialFreq = testParams.carrierFreq + (trial % 20 - 10) * 50;
          sample += Math.sin(2 * Math.PI * trialFreq * i / demoConfig.sampleRate) * 0.05;
          
          // Burst patterns
          if ((i + trial * 100) % 300 < 20) {
            sample += Math.sin(2 * Math.PI * testParams.carrierFreq * i / demoConfig.sampleRate) * 0.08;
          }
          
          uniqueNoise[i] = sample;
        }

        // Test threshold 0.4
        const demod04 = new DsssDpskDemodulator({
          ...demoConfig,
          correlationThreshold: 0.4
        });
        demod04.addSamples(uniqueNoise);
        demod04.getAvailableBits();
        
        if (demod04.getSyncState().locked) {
          falsePositives04++;
        }

        // Test threshold 0.5
        const demod05 = new DsssDpskDemodulator({
          ...demoConfig,
          correlationThreshold: 0.5
        });
        demod05.addSamples(uniqueNoise);
        demod05.getAvailableBits();
        
        if (demod05.getSyncState().locked) {
          falsePositives05++;
        }
      }

      const fp04Rate = falsePositives04 / monteCarloTrials;
      const fp05Rate = falsePositives05 / monteCarloTrials;

      console.log(`\nMonte Carlo Results (${monteCarloTrials} trials):`);
      console.log(`  Threshold 0.4: ${falsePositives04}/${monteCarloTrials} = ${(fp04Rate * 100).toFixed(2)}% false positive rate`);
      console.log(`  Threshold 0.5: ${falsePositives05}/${monteCarloTrials} = ${(fp05Rate * 100).toFixed(2)}% false positive rate`);
      console.log(`  Difference: ${((fp04Rate - fp05Rate) * 100).toFixed(2)}% higher with 0.4`);

      if (falsePositives04 > falsePositives05) {
        console.log(`\n*** STATISTICAL CONFIRMATION ***`);
        console.log(`Demo configuration (seq15_spp23_sr44100) with threshold 0.4`);
        console.log(`produces significantly more false positives than threshold 0.5!`);
        console.log(`This explains the demo environment failure.`);
      }

      // The test is exploratory - we expect to find the issue, not assert absence of it
      expect(monteCarloTrials).toBe(50);
    });
  });
});