import { describe, it, expect } from 'vitest';
import { execute } from './sigmoidDecayCollateralCalculator';

describe('sigmoidDecayCollateralCalculator', () => {
  it('should return approximately half the collateral at the midpoint', () => {
    // Sigmoid at midpoint (x=midpoint) = 0.5, so collateral * 0.5 = 250
    expect(execute(500, 30, 15)).toBeCloseTo(250, 0);
  });

  it('should return low collateral on day 0 (start of sigmoid)', () => {
    // Sigmoid at x=0 with steepness=0.1, midpoint=15 → ~0.182 → ~91
    const result = execute(500, 30, 0);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(250); // well below midpoint
  });

  it('should return high collateral on the last day (end of sigmoid)', () => {
    // Sigmoid at x=30 with steepness=0.1, midpoint=15 → ~0.818 → ~409
    const result = execute(500, 30, 30);
    expect(result).toBeGreaterThan(250); // well above midpoint
    expect(result).toBeLessThanOrEqual(500);
  });

  it('collateral increases monotonically', () => {
    const values = Array.from({ length: 31 }, (_, i) => execute(500, 30, i));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it('should throw an error if current day is out of range', () => {
    expect(() => execute(500, 30, 31)).toThrow('Current day must be within the range of 0 to totalDays.');
    expect(() => execute(500, 30, -1)).toThrow('Current day must be within the range of 0 to totalDays.');
  });

  it('handles edge case with 1-day period', () => {
    expect(execute(100, 1, 0)).toBeGreaterThan(0);
    expect(execute(100, 1, 1)).toBeGreaterThan(0);
  });
});