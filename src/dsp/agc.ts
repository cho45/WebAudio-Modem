/**
 * Automatic Gain Control (AGC) Processor
 * 
 * Provides automatic gain control for audio signals with configurable
 * attack and release time constants. Maintains consistent output levels
 * while preventing clipping and handling dynamic range variations.
 */

/**
 * AGC Processor with sample-by-sample processing
 * 
 * Features:
 * - Fast attack for preventing overload
 * - Slow release for smooth gain transitions
 * - Configurable target level and time constants
 * - Gain limiting to prevent instability
 */
export class AGCProcessor {
  private targetLevel: number;
  private currentGain: number;
  private attackRate: number;
  private releaseRate: number;

  /**
   * Create AGC processor
   * @param sampleRate Sample rate in Hz
   * @param targetLevel Target output level (0.0 - 1.0)
   * @param attackTimeMs Attack time constant in milliseconds (default: 1ms)
   * @param releaseTimeMs Release time constant in milliseconds (default: 10ms)
   */
  constructor(
    sampleRate: number, 
    targetLevel = 0.5,
    attackTimeMs = 1.0,
    releaseTimeMs = 10.0
  ) {
    this.targetLevel = targetLevel;
    this.currentGain = 1.0;
    
    // Convert time constants to sample-based rates
    // Rate = 1 - exp(-1 / (sampleRate * timeInSeconds))
    this.attackRate = 1.0 - Math.exp(-1.0 / (sampleRate * attackTimeMs / 1000));
    this.releaseRate = 1.0 - Math.exp(-1.0 / (sampleRate * releaseTimeMs / 1000));
  }

  /**
   * Process audio samples in-place with AGC
   * @param samples Audio samples to process (modified in-place)
   */
  process(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      // Apply current gain in-place
      samples[i] *= this.currentGain;
      
      // Measure output level
      const outputLevel = Math.abs(samples[i]);
      
      // Update gain based on output level
      if (outputLevel > this.targetLevel) {
        // Too loud, reduce gain quickly (attack)
        const targetGain = this.targetLevel / outputLevel;
        this.currentGain += (targetGain - this.currentGain) * this.attackRate;
      } else {
        // Too quiet, increase gain slowly (release)
        if (outputLevel > 0) {
          const targetGain = this.targetLevel / outputLevel;
          this.currentGain += (targetGain - this.currentGain) * this.releaseRate;
        }
      }
      
      // Limit gain to reasonable bounds to prevent instability
      this.currentGain = Math.max(0.1, Math.min(10.0, this.currentGain));
    }
  }

  /**
   * Get current gain value
   * @returns Current gain factor
   */
  getCurrentGain(): number {
    return this.currentGain;
  }

  /**
   * Reset AGC state
   * @param initialGain Initial gain value (default: 1.0)
   */
  reset(initialGain = 1.0): void {
    this.currentGain = initialGain;
  }

  /**
   * Set target level
   * @param level New target level (0.0 - 1.0)
   */
  setTargetLevel(level: number): void {
    this.targetLevel = Math.max(0.01, Math.min(1.0, level));
  }
}